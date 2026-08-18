/**
 * Worktree cleanup assessment, shared by `agvsr cleanup` and the daemon's automatic
 * reclamation of a finished job's worktrees (D42).
 *
 * Cross-references the daemon's own job records (the exact `branch`/`worktree` fields
 * recorded at job creation, see `Store.createJob`) against `git worktree list
 * --porcelain`'s own (path, branch) pairs, matched by exact string equality. Never
 * re-derive the branch-naming convention by hand: doing so once (matching an 8-char
 * branch prefix against job ids) mis-classified nearly every real job as orphaned.
 */
import { spawnSync } from "node:child_process";
import type { Job } from "../protocol.ts";

export interface WorktreeEntry {
  path: string;
  branch: string | null; // null for detached HEAD worktrees
}

export type CleanupClassification = "KEEP" | "SAFE_TO_REMOVE" | "NEEDS_REVIEW";

export interface WorktreeAssessment {
  entry: WorktreeEntry;
  job: Job | null;
  dirty: boolean;
  aheadOfMain: number | null; // null if not resolvable (e.g. detached/no branch)
  classification: CleanupClassification;
  reason: string;
}

export function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
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

export function assessWorktree(
  entry: WorktreeEntry,
  job: Job | null,
  mainWorktreePath: string,
  // "main" for a job's own worktree (unchanged default); an instance
  // worktree's correct merge target is its owning job's own branch, not
  // main — an instance can be fully reconciled into the job branch long
  // before the job itself is merged to main by the human (D27).
  baseRef: string = "main",
): WorktreeAssessment {
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
    const count = git(mainWorktreePath, ["rev-list", "--count", `${baseRef}..${entry.branch}`]);
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
      reason: `${aheadOfMain} commit(s) not yet merged into ${baseRef}`,
    };
  }
  return {
    entry,
    job,
    dirty,
    aheadOfMain,
    classification: "SAFE_TO_REMOVE",
    reason: job
      ? `job ${job.status}, clean, fully merged into ${baseRef}`
      : "orphaned (no job record), clean, fully merged",
  };
}
