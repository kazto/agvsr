# QA Test Plan: git worktree isolation

## Goal

Verify the worktree-isolation design described in `docs/action-plan.md` and the related
`worktree` discussion:

- per-job worktrees live under `configDir()/worktrees/<jobId>`
- `job.create` must fail if worktree provisioning fails
- gitignored files are not copied into the worktree
- the daemon and CLI use the worktree as the effective execution directory
- status output makes the worktree-backed job state visible to the operator

This plan is for pre-implementation review. It defines the acceptance gate for the change
set that will introduce worktree isolation.

## Scope

### In scope

- store migration and persistence for any new worktree-related metadata
- git worktree creation for a job created from a git repository
- replication of repository state into the worktree
- failure behavior when worktree provisioning cannot be completed
- daemon effective cwd for spawned work, adapters, and MCP shim invocations
- CLI `status` visibility for the worktree-backed job
- final verification commands: `bun test`, `oxlint`, `oxfmt`

### Out of scope

- redesign of job routing or role topology
- changing the accepted base path rule for worktrees
- any worktree behavior outside job creation / job execution
- UI redesign beyond the minimum `status` visibility required to expose the worktree

## Acceptance Criteria

The implementation is acceptable only if all of the following hold:

1. A job created from a real git repository gets a worktree rooted at
   `configDir()/worktrees/<jobId>`.
2. The daemon uses that worktree as the effective cwd for job execution.
3. Tracked files and non-ignored untracked files are present in the worktree with the expected
   contents.
4. Files ignored by git in the source repository are not copied into the worktree.
5. If worktree provisioning fails, `job.create` fails instead of silently continuing with the
   original repository directory.
6. Any new store fields or tables survive restart and remain readable for existing and newly
   created jobs.
7. `status` exposes enough information to identify the worktree-backed execution location and
   does not regress the existing runtime display.
8. `bun test`, `oxlint`, and `oxfmt` all pass after the change.

## Verification Matrix

### 1. Store migration and persistence

What to verify:

- existing database rows created before the worktree feature still load
- any new worktree metadata survives daemon restart
- job listing and single-job lookup still return the same job identity, status, cwd, and branch

How to check:

- create a legacy sqlite fixture that predates the worktree change, or seed a database using the
  pre-feature schema shape
- start the daemon against that database and confirm `job.list` / `job.get` still work
- create a new job, restart the daemon, and confirm the worktree-related fields are unchanged
- verify that persistence is durable across the daemon lifecycle rather than only in memory

Acceptance criteria:

- no data loss for pre-existing rows
- new worktree metadata is readable after restart
- persistence does not depend on a single daemon process

### 2. Git worktree creation and state replication

What to verify:

- a job created from a git repository gets a dedicated worktree under
  `configDir()/worktrees/<jobId>`
- the worktree is initialized from the source repository state
- tracked files are present with the same contents as the source repo
- non-ignored untracked files are present
- gitignored files are not copied

How to check:

- build a real git repo fixture with:
  - at least one tracked file
  - at least one untracked but not ignored file
  - at least one ignored file
- create a job against that repo
- inspect the resulting worktree path on disk
- compare the tracked file content between source repo and worktree
- confirm the untracked non-ignored file is present in the worktree
- confirm the ignored file is absent in the worktree

Acceptance criteria:

- the worktree exists at the configured base path
- replication matches the source repo for tracked and non-ignored state
- ignored files do not leak into the worktree

### 3. Failure behavior for provisioning errors

What to verify:

- if the source path is not a git repository, `job.create` fails
- if git worktree creation itself fails, the daemon reports that failure to the caller
- the daemon does not silently fall back to the original cwd

How to check:

- point `job.create` at a non-repository directory and expect a hard failure
- use a second failure fixture if needed to force `git worktree add` to fail
- verify the caller receives an error and no running job proceeds from the broken setup
- verify no hidden "best effort" execution path runs unisolated

Acceptance criteria:

- provisioning failures are surfaced immediately
- there is no silent fallback to the source directory
- the failure mode is observable at `job.create`

### 4. Daemon effective cwd

What to verify:

- the daemon dispatches work using the worktree directory, not the source repository root
- spawned adapter processes inherit the worktree cwd
- MCP shim / tool execution sees the same effective cwd

How to check:

- use the existing daemon test harness with a fake runner that records the dispatch cwd
- assert the cwd passed into the runner is the worktree path
- if the implementation stores both source cwd and effective cwd, assert both are correct and
  distinct
- confirm the effective cwd remains the worktree after a restart

Acceptance criteria:

- every execution path uses the worktree cwd
- the original repo root is not used for job execution once isolation is active

### 5. CLI and status visibility

What to verify:

- `agvsr status <job-id>` exposes the worktree-backed execution location
- the displayed branch / cwd information matches the created worktree
- the existing runtime output remains intact
- failure cases are visible rather than being hidden behind a generic running state

How to check:

- run the CLI against a job created from a git repo fixture
- check that the `status` output includes the worktree-backed path or an equivalent explicit
  indication of where the job is running
- confirm the current runtime line still reports the existing running / idle detail correctly
- verify that a failed `job.create` does not leave a misleading running entry in `status`

Acceptance criteria:

- operators can tell which worktree a job is using
- the status display still reflects runtime state correctly
- failed provisioning is not misrepresented as a running job

### 6. Regression checks

What to verify:

- the repository still passes its standard quality gates
- no existing tests around job creation, persistence, or CLI output regress

How to check:

- run:
  - `bun test`
  - `oxlint`
  - `oxfmt`

Acceptance criteria:

- all repository checks pass
- no existing behavior is broken while adding worktree isolation

## Concrete Cases

### Positive cases

- create a job from a git repo and get a worktree at `configDir()/worktrees/<jobId>`
- restart the daemon and still resolve the same worktree-backed job correctly
- tracked files and non-ignored untracked files appear in the worktree
- `status` shows the job as running with worktree-relevant location information

### Negative cases

- create a job from a non-git directory and see `job.create` fail
- force worktree provisioning failure and confirm there is no unisolated fallback
- confirm ignored files are absent from the worktree

### Edge cases

- existing sqlite rows created before the feature still open correctly after migration
- repeated daemon restarts do not duplicate or drift the stored worktree mapping
- a status lookup after provisioning failure does not report a live job

## Recommended Test Harness Shape

- Prefer the existing daemon integration style used in `test/ipc.test.ts` and `test/e2e.test.ts`.
- Use a real git repository fixture for the worktree tests so file replication behavior is not
  mocked away.
- Use a temp `XDG_CONFIG_HOME` or equivalent fixture path so `configDir()` resolves to a test-local
  directory.
- Keep the checks deterministic: no reliance on the developer's global git config or existing
  worktrees.

## Review Outcome

The worktree-isolation change is acceptable only if:

- worktrees are created under `configDir()/worktrees/<jobId>`
- provisioning failures fail `job.create`
- ignored files are not copied
- daemon cwd and operator-facing `status` output reflect the isolated worktree
- persistence survives restart
- `bun test`, `oxlint`, and `oxfmt` stay green
