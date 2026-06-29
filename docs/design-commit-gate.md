# Design-commit gate

A structural backstop that prevents a job from being marked complete while the job
worktree is dirty.

## Decision

Check the job's own worktree at completion time, not the original `cwd` checkout. The gate
uses `git status --porcelain=v1 --untracked-files=normal`, so it respects `.gitignore` and
flags staged changes, unstaged changes, renames, deletions, and untracked non-ignored
files.

## Enforcement

In the daemon `job.complete` path, before it transitions the job to `done`, it:

1. Looks only at `job.worktree`.
2. Rejects completion if `git status` reports anything or if `git status` itself fails.
3. Returns an IPC error and emits a daemon → user escalation telling the worker to commit
   the work on the job branch before completing the job.
4. Never auto-commits.

`AGVSR_COMMIT_GATE` disables the gate when set to `0`, `off`, `false`, or `no` (case
insensitive). Any other value, or an unset variable, keeps the gate on.

## Reuse

The completion check is implemented as a helper under `src/git/commit-gate.ts` so future
completion-delegation flows can call the same logic before they create a completion
message or transition a job to `done`.

## Tests

- `test/commit-gate.test.ts` covers dirty rejection, successful completion after commit,
  env disablement, and ignored-only files.
- `test/charter.test.ts` checks the bundled charter text tells workers to commit before
  completion and warns that uncommitted work can be lost.
