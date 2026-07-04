#!/usr/bin/env bun
/**
 * Inventory and (optionally) clean up agvsr job worktrees/branches.
 *
 * Earlier ad hoc bash cleanup passes derived a worktree's job id by
 * re-deriving the branch-naming convention (`agvsr/<id-or-id.slice(0,8)>`)
 * and string-matching it against job ids by hand — fragile, and it produced
 * a wrong classification once (matching by 8-char prefix incorrectly marked
 * nearly every real job as an orphan). This script never re-derives that
 * convention: it cross-references the daemon's own `job.list` records
 * (which carry the exact `branch`/`worktree` the daemon wrote at creation
 * time, see `Store.createJob` in src/daemon/store.ts) against
 * `git worktree list --porcelain`'s own (path, branch) pairs, matched by
 * exact string equality.
 *
 * Classification per non-main worktree:
 *   KEEP           - job status is "running" (never touch a live job).
 *   SAFE_TO_REMOVE - terminal/orphaned job, clean tree, branch fully merged
 *                    into main (or has no commits ahead of main).
 *   NEEDS_REVIEW   - anything else: uncommitted changes, commits not yet in
 *                    main, or (for orphans) any state at all that isn't
 *                    provably safe. Never auto-removed.
 *
 * Usage:
 *   bun run scripts/cleanup-jobs.ts              # report only, no changes
 *   bun run scripts/cleanup-jobs.ts --apply       # remove SAFE_TO_REMOVE entries
 *   bun run scripts/cleanup-jobs.ts --socket PATH # override daemon endpoint
 *
 * Cross-platform by design (agvsr targets Windows/macOS/Linux): Bun +
 * `node:child_process` git calls + the project's own IPC client, no
 * bash/awk/grep/zsh-specific process substitution.
 */
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { Client, DaemonNotRunningError } from "../src/ipc/transport.ts";
import { ipcEndpoint } from "../src/paths.ts";
import type { Job } from "../src/protocol.ts";

interface WorktreeEntry {
  path: string;
  branch: string | null; // null for detached HEAD worktrees
}

type Classification = "KEEP" | "SAFE_TO_REMOVE" | "NEEDS_REVIEW";

interface Assessment {
  entry: WorktreeEntry;
  job: Job | null;
  dirty: boolean;
  aheadOfMain: number | null; // null if not resolvable (e.g. detached/no branch)
  classification: Classification;
  reason: string;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "" && current?.path) {
      entries.push({ path: current.path, branch: current.branch ?? null });
      current = null;
    }
  }
  if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}

async function fetchJobs(endpoint: string): Promise<Job[]> {
  let client: Client;
  try {
    client = await Client.connect(endpoint);
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      console.error(`daemon not reachable at ${endpoint} — is 'agvsr daemon start' running?`);
      process.exit(2);
    }
    throw err;
  }
  try {
    const res = await client.request<{ jobs: Job[] }>("job.list");
    if (!res.ok) throw new Error(`job.list: ${res.error.message}`);
    return res.result.jobs;
  } finally {
    client.close();
  }
}

function assess(entry: WorktreeEntry, job: Job | null, mainWorktreePath: string): Assessment {
  if (job?.status === "running") {
    return {
      entry,
      job,
      dirty: false,
      aheadOfMain: null,
      classification: "KEEP",
      reason: "job is running",
    };
  }

  const status = git(entry.path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (!status.ok) {
    return {
      entry,
      job,
      dirty: true,
      aheadOfMain: null,
      classification: "NEEDS_REVIEW",
      reason: `git status failed: ${status.stderr || "unknown error"}`,
    };
  }
  const dirty = status.stdout.length > 0;

  let aheadOfMain: number | null = null;
  if (entry.branch) {
    const count = git(mainWorktreePath, ["rev-list", "--count", `main..${entry.branch}`]);
    aheadOfMain = count.ok ? Number(count.stdout) : null;
  }

  if (dirty) {
    return {
      entry,
      job,
      dirty,
      aheadOfMain,
      classification: "NEEDS_REVIEW",
      reason: "uncommitted changes in the worktree",
    };
  }
  if (aheadOfMain === null) {
    return {
      entry,
      job,
      dirty,
      aheadOfMain,
      classification: "NEEDS_REVIEW",
      reason: "could not determine commits-ahead-of-main (detached HEAD or missing branch)",
    };
  }
  if (aheadOfMain > 0) {
    return {
      entry,
      job,
      dirty,
      aheadOfMain,
      classification: "NEEDS_REVIEW",
      reason: `${aheadOfMain} commit(s) not yet merged into main`,
    };
  }
  return {
    entry,
    job,
    dirty,
    aheadOfMain,
    classification: "SAFE_TO_REMOVE",
    reason: job
      ? `job ${job.status}, clean, fully merged`
      : "orphaned (no job record), clean, fully merged",
  };
}

function formatLine(a: Assessment): string {
  const jobCol = a.job ? `${a.job.id}\t${a.job.status}` : "-\tORPHAN";
  const aheadCol = a.aheadOfMain === null ? "-" : String(a.aheadOfMain);
  return [
    a.entry.path,
    a.classification,
    jobCol,
    `dirty:${a.dirty ? "yes" : "no"}`,
    `ahead:${aheadCol}`,
    a.entry.branch ?? "(detached)",
    a.reason,
  ].join("\t");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      apply: { type: "boolean", default: false },
      socket: { type: "string" },
    },
  });

  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (!repoRoot.ok) {
    console.error("not inside a git repository");
    process.exit(2);
  }
  const mainWorktreePath = repoRoot.stdout;

  const listRes = git(mainWorktreePath, ["worktree", "list", "--porcelain"]);
  if (!listRes.ok) {
    console.error(`git worktree list failed: ${listRes.stderr}`);
    process.exit(2);
  }
  const entries = parseWorktreePorcelain(listRes.stdout).filter((e) => e.path !== mainWorktreePath);

  if (entries.length === 0) {
    console.log("no job worktrees found (only the main checkout).");
    return;
  }

  const endpoint = values.socket ?? ipcEndpoint();
  const jobs = await fetchJobs(endpoint);
  const jobByWorktree = new Map(
    jobs.filter((j) => j.worktree).map((j) => [j.worktree as string, j]),
  );
  const jobByBranch = new Map(jobs.filter((j) => j.branch).map((j) => [j.branch as string, j]));

  const assessments = entries.map((entry) => {
    const job =
      jobByWorktree.get(entry.path) ??
      (entry.branch ? (jobByBranch.get(entry.branch) ?? null) : null);
    return assess(entry, job, mainWorktreePath);
  });

  for (const a of assessments) console.log(formatLine(a));

  const counts = { KEEP: 0, SAFE_TO_REMOVE: 0, NEEDS_REVIEW: 0 } satisfies Record<
    Classification,
    number
  >;
  for (const a of assessments) counts[a.classification]++;
  console.log(
    `\n${assessments.length} worktree(s): ${counts.KEEP} keep, ${counts.SAFE_TO_REMOVE} safe-to-remove, ${counts.NEEDS_REVIEW} need review`,
  );

  if (!values.apply) {
    if (counts.SAFE_TO_REMOVE > 0) {
      console.log("(dry run — pass --apply to remove the safe-to-remove entries)");
    }
    return;
  }

  for (const a of assessments) {
    if (a.classification !== "SAFE_TO_REMOVE") continue;
    if (a.entry.path === mainWorktreePath) continue; // belt-and-suspenders, should be unreachable
    const removed = git(mainWorktreePath, ["worktree", "remove", "--force", a.entry.path]);
    if (!removed.ok) {
      console.error(`failed to remove worktree ${a.entry.path}: ${removed.stderr}`);
      continue;
    }
    if (a.entry.branch) git(mainWorktreePath, ["branch", "-D", a.entry.branch]);
    console.log(`removed ${a.entry.path}${a.entry.branch ? ` (branch ${a.entry.branch})` : ""}`);
  }
  git(mainWorktreePath, ["worktree", "prune"]);
}

await main();
