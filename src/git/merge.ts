/**
 * Merge an implementation instance's branch into the job's own branch (D27).
 *
 * The DAEMON performs this merge deterministically via git, not the
 * supervisor via a shell command — the supervisor role has no shell access
 * on the claude-code adapter (see SUPERVISOR_DISALLOWED in adapters/claude.ts),
 * and this is safer regardless of adapter: a fixed, testable git operation
 * instead of an LLM-issued shell command.
 */
import { spawnSync } from "node:child_process";

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

export type MergeInstanceOutcome =
  | { ok: true; summary: string }
  | {
      ok: false;
      code: "dirty" | "conflict" | "merge_failed";
      message: string;
      conflicts?: string[];
    };

/**
 * Merges `instanceBranch` into whatever branch is currently checked out in
 * `jobWorktree` (the job's own branch). Refuses if the job worktree itself
 * is dirty (the merge commit shouldn't be conflated with unrelated pending
 * changes). On conflict, aborts the merge to leave a clean working tree and
 * reports the conflicting files instead of leaving a half-merged state.
 */
export function mergeInstanceBranch(
  jobWorktree: string,
  instanceBranch: string,
): MergeInstanceOutcome {
  const status = git(jobWorktree, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (!status.ok) {
    return {
      ok: false,
      code: "merge_failed",
      message: `Unable to verify the job worktree before merging: ${status.stderr || "git status failed"}`,
    };
  }
  if (status.stdout.length > 0) {
    return {
      ok: false,
      code: "dirty",
      message: `Job worktree has uncommitted changes; commit or clean it before merging ${instanceBranch}.`,
    };
  }

  const beforeHead = git(jobWorktree, ["rev-parse", "HEAD"]).stdout;
  const merge = git(jobWorktree, [
    "merge",
    "--no-ff",
    instanceBranch,
    "-m",
    `Merge ${instanceBranch}`,
  ]);
  if (merge.ok) {
    const stat = git(jobWorktree, ["diff", "--stat", beforeHead, "HEAD"]).stdout;
    return { ok: true, summary: stat || `merged ${instanceBranch} (no changes)` };
  }

  const conflicts = git(jobWorktree, ["diff", "--name-only", "--diff-filter=U"])
    .stdout.split("\n")
    .filter(Boolean);
  git(jobWorktree, ["merge", "--abort"]);

  if (conflicts.length > 0) {
    return {
      ok: false,
      code: "conflict",
      message: `Merge conflict in ${instanceBranch}: ${conflicts.join(", ")}`,
      conflicts,
    };
  }
  return { ok: false, code: "merge_failed", message: merge.stderr || "git merge failed" };
}
