/**
 * Structural commit gate for job completion.
 *
 * The daemon checks only the job worktree, never the original cwd, so dirty
 * main checkouts do not block completion.
 */
import { spawnSync } from "node:child_process";
import type { Job } from "../protocol.ts";

export const COMMIT_GATE_BLOCK_MESSAGE =
  "Job worktree is dirty. Commit the work on the job branch before completing the job.";

const DISABLED_RE = /^(0|off|false|no)$/i;

function commitGateEnabled(): boolean {
  const raw = process.env.AGVSR_COMMIT_GATE;
  return !raw || !DISABLED_RE.test(raw.trim());
}

function gitStatus(worktree: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: worktree,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trimEnd(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function countPorcelainEntries(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

export interface CommitGateResult {
  ok: true;
}

export interface CommitGateBlocked {
  ok: false;
  code: "commit_required" | "commit_check_failed";
  message: string;
}

export type CommitGateOutcome = CommitGateResult | CommitGateBlocked;

/**
 * Checks the job's own worktree plus any extra worktrees (e.g. array-expanded
 * implementation instances' isolated worktrees, D27) — an instance's
 * uncommitted work must block completion exactly like the job worktree's
 * own dirty state does, not go unnoticed.
 */
export function checkJobCommitGate(
  job: Pick<Job, "id" | "worktree">,
  extraWorktrees: string[] = [],
): CommitGateOutcome {
  if (!commitGateEnabled()) return { ok: true };

  const worktrees = [job.worktree, ...extraWorktrees].filter((w): w is string => !!w);
  if (worktrees.length === 0) return { ok: true };

  const dirtySections: string[] = [];
  for (const worktree of worktrees) {
    const status = gitStatus(worktree);
    if (!status.ok) {
      return {
        ok: false,
        code: "commit_check_failed",
        message:
          `Unable to verify the job worktree for completion. Commit the work on the job branch first.\n` +
          `worktree: ${worktree}\n` +
          (status.stderr ? `git status error: ${status.stderr}` : "git status failed"),
      };
    }
    if (status.stdout.length > 0) {
      dirtySections.push(
        `worktree: ${worktree}\ngit status --porcelain=v1 --untracked-files=normal:\n${status.stdout}`,
      );
    }
  }

  if (dirtySections.length > 0) {
    return {
      ok: false,
      code: "commit_required",
      message: `${COMMIT_GATE_BLOCK_MESSAGE}\n${dirtySections.join("\n\n")}`,
    };
  }

  return { ok: true };
}

export function recoverableDirtyWorktreeNote(
  job: Pick<Job, "branch" | "worktree">,
  extraWorktrees: Array<{ worktree: string; branch: string }> = [],
): string | null {
  const entries = [{ worktree: job.worktree, branch: job.branch }, ...extraWorktrees];

  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.worktree) continue;
    const status = gitStatus(entry.worktree);
    if (!status.ok || !status.stdout) continue;
    const changedFileCount = countPorcelainEntries(status.stdout);
    if (changedFileCount <= 0) continue;
    const branch = entry.branch ?? "(unknown)";
    lines.push(
      `未コミットの作業が worktree に残存: ${entry.worktree}, 変更ファイル数 ${changedFileCount}, ブランチ ${branch}。git でコミットして回収可`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
