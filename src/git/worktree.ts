/**
 * Git worktree provisioning for per-job isolation (D20/D27).
 * Worktrees live under configDir()/worktrees/<jobId>.
 *
 * Fallback rules:
 *   - non-git cwd → null (backward compat)
 *   - unborn/empty repo → null (backward compat)
 *   - real repo, git fails → throws (job.create must fail)
 */
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { worktreesDir } from "../paths.ts";
import { seedDependencies } from "./deps.ts";

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

function repoRoot(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.stdout ? r.stdout : null;
}

function hasCommits(root: string): boolean {
  return git(root, ["rev-parse", "HEAD"]).ok;
}

/**
 * Provision a git worktree at `worktreesDir()/<worktreeKey>`.
 * Returns the worktree path on success, null for non-git / unborn repos.
 * Throws for real git repos where worktree creation fails.
 *
 * `worktreeKey` is the job id for a job's own worktree, or `<jobId>--<role>`
 * for a role instance's dedicated worktree (D27).
 */
export async function provisionWorktree(
  cwd: string,
  worktreeKey: string,
  branch: string,
): Promise<string | null> {
  const root = repoRoot(cwd);
  if (!root) return null;
  if (!hasCommits(root)) return null;

  const dest = join(worktreesDir(), worktreeKey);
  mkdirSync(dirname(dest), { recursive: true });

  const add = git(root, ["worktree", "add", "-b", branch, dest, "HEAD"]);
  if (!add.ok) {
    throw new Error(`git worktree add failed: ${add.stderr}`);
  }

  // Replicate tracked modifications (staged + unstaged) on top of HEAD checkout
  const trackedChanged = new Set([
    ...git(root, ["diff", "HEAD", "--name-only"]).stdout.split("\n").filter(Boolean),
    ...git(root, ["diff", "--cached", "--name-only"]).stdout.split("\n").filter(Boolean),
  ]);
  for (const file of trackedChanged) {
    const src = join(root, file);
    const tgt = join(dest, file);
    if (existsSync(src)) {
      mkdirSync(dirname(tgt), { recursive: true });
      cpSync(src, tgt, { recursive: true });
    }
  }

  // Replicate untracked non-ignored files
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"])
    .stdout.split("\n")
    .filter(Boolean);
  for (const file of untracked) {
    const src = join(root, file);
    const tgt = join(dest, file);
    if (existsSync(src)) {
      mkdirSync(dirname(tgt), { recursive: true });
      cpSync(src, tgt, { recursive: true });
    }
  }

  // Seed ignored dependency directories (node_modules and friends). Without this a
  // job's first act is reinstalling them, which inside a write-restricted adapter
  // sandbox frequently just fails. Best effort — a job that gets nothing here
  // installs its own exactly as before.
  try {
    seedDependencies(root, dest, (path) => git(root, ["check-ignore", "-q", path]).ok);
  } catch (e) {
    console.error(`[agvsr] dependency seeding skipped: ${(e as Error).message}`);
  }

  return dest;
}
