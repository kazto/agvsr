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

export interface CommitGateResult {
  ok: true;
}

export interface CommitGateBlocked {
  ok: false;
  code: "commit_required" | "commit_check_failed";
  message: string;
}

export type CommitGateOutcome = CommitGateResult | CommitGateBlocked;

export function checkJobCommitGate(job: Pick<Job, "id" | "worktree">): CommitGateOutcome {
  if (!commitGateEnabled()) return { ok: true };
  if (!job.worktree) return { ok: true };

  const status = gitStatus(job.worktree);
  if (!status.ok) {
    return {
      ok: false,
      code: "commit_check_failed",
      message:
        `Unable to verify the job worktree for completion. Commit the work on the job branch first.\n` +
        `worktree: ${job.worktree}\n` +
        (status.stderr ? `git status error: ${status.stderr}` : "git status failed"),
    };
  }

  if (status.stdout.length > 0) {
    return {
      ok: false,
      code: "commit_required",
      message:
        `${COMMIT_GATE_BLOCK_MESSAGE}\n` +
        `worktree: ${job.worktree}\n` +
        `git status --porcelain=v1 --untracked-files=normal:\n${status.stdout}`,
    };
  }

  return { ok: true };
}
