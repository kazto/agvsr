# QA Test Plan: `agvsr daemon start`

## Goal

Verify the first phase of the daemon lifecycle improvement described in `docs/action-plan.md`:

- add `agvsr daemon start` as a detached background launcher
- share the detached spawn logic with the existing `agvsr daemon restart`
- keep `agvsr daemon start` idempotent
- leave `job` auto-start out of scope for this phase

This plan is written against the current implementation surface in:

- `src/cli/agvsr.ts`
- `src/ipc/transport.ts`
- `src/daemon/daemon.ts`
- `test/ipc.test.ts`
- `test/e2e.test.ts`

## Scope

### In scope

- CLI behavior for `agvsr daemon start`
- background process lifecycle and IPC availability
- restart behavior after refactoring the detached spawn path
- error handling when the daemon is already running or not running
- regression checks around the existing foreground `daemon`, `stop`, and `restart` flows

### Out of scope

- automatic daemon spawning from `agvsr job`
- any job bootstrap or lazy-start behavior
- unrelated CLI commands
- redesign of the IPC protocol or daemon state machine

## Acceptance Criteria

The implementation is acceptable only if all of the following are true:

1. `agvsr daemon start` launches `agvsrd` in the background using a detached process.
2. The command returns control to the shell promptly and does not block on the daemon process.
3. A running daemon can be reached through the normal IPC endpoint after `start` completes.
4. Running `agvsr daemon start` twice is safe and does not create user-visible breakage.
5. `agvsr daemon restart` continues to work after the detached spawn logic is shared out.
6. `agvsr daemon start` does not change foreground `agvsr daemon`, `stop`, or `ping` semantics.
7. `job` remains unchanged in this phase: no auto-start is introduced there.

## Verification Matrix

### 1. CLI start launches a detached daemon

What to verify:

- `agvsr daemon start` spawns the daemon in detached mode.
- the parent CLI exits after printing a success message.
- the daemon remains reachable after the CLI process ends.

How to check:

- add an automated CLI test that invokes `agvsr daemon start` in a temporary workspace
- wait for the IPC endpoint to become available
- confirm `agvsr ping` succeeds after the original CLI process has exited

Acceptance criteria:

- startup is asynchronous from the user’s perspective
- the daemon is still alive after the parent shell process is gone

### 2. Start is idempotent

What to verify:

- invoking `agvsr daemon start` when the daemon is already running does not create a second daemon instance
- the command is safe to repeat
- the user receives a sensible outcome instead of a crash or a hanging process

How to check:

- add a test that starts the daemon once, then runs `daemon start` again
- assert that the second invocation exits cleanly
- assert that the IPC endpoint still responds normally
- if the implementation chooses to report "already running", verify the message is stable and explicit

Acceptance criteria:

- repeated starts are harmless
- only one reachable daemon endpoint is active for the job workspace

### 3. Restart reuses the shared detached spawn path

What to verify:

- `agvsr daemon restart` still stops the current daemon and relaunches it detached
- the new start path and the restart path share the same detached spawn implementation
- the restart refactor does not regress team-file argument forwarding

How to check:

- add or update a CLI test that exercises `daemon restart --team <file>`
- verify that the restarted daemon comes up on the same IPC endpoint
- verify the `--team` argument is still passed through to the background daemon process

Acceptance criteria:

- restart behavior is preserved
- team-file override behavior remains intact

### 4. Foreground daemon behavior is unchanged

What to verify:

- `agvsr daemon` without `start/stop/restart` still runs in the foreground
- shutdown handling for SIGINT/SIGTERM is unchanged
- the foreground command still reports the listening endpoint

How to check:

- keep or update the existing daemon process tests if any are affected by the refactor
- if a CLI-level test is added, run it against the foreground mode as a regression check

Acceptance criteria:

- the new background launch path does not alter the existing foreground lifecycle

### 5. IPC transport still behaves the same

What to verify:

- `Client.connect` still resolves a missing daemon as `DaemonNotRunningError`
- the daemon still listens on the expected endpoint created by the CLI
- background start does not require transport changes beyond the existing local IPC path

How to check:

- keep the existing `test/ipc.test.ts` coverage for connection and request/response behavior
- add a focused assertion that `ping` works after `daemon start`

Acceptance criteria:

- no regression in IPC connection semantics
- no new transport-level failure modes introduced by the start command

## Candidate Automated Tests

### `test/cli.test.ts` or equivalent new CLI test file

Add tests for:

- `agvsr daemon start` launches a background daemon and returns promptly
- repeated `agvsr daemon start` calls are idempotent
- `agvsr daemon restart --team <file>` still restarts successfully after refactor

### `test/ipc.test.ts`

Extend with coverage for:

- daemon start through the real CLI path, if that test harness is already practical there
- a second `start` call while the daemon is live
- endpoint availability immediately after start

### `test/e2e.test.ts`

Add a real-process smoke scenario if the harness can support it:

- start the daemon in the background
- connect through the real IPC client
- issue `ping`
- optionally stop the daemon cleanly afterward

### Existing regression tests to keep green

- daemon startup fail-safe behavior
- restart/session persistence behavior
- `ping` and `Client.connect` error handling
- any foreground daemon lifecycle tests already present

## Manual Verification

Use manual checks if automated coverage cannot fully prove detach semantics:

1. Run `agvsr daemon start` from a shell.
2. Confirm the command returns without keeping the terminal occupied.
3. Run `agvsr ping` in a separate shell and confirm the daemon answers.
4. Run `agvsr daemon start` again and confirm it does not create a second visible daemon failure.
5. Run `agvsr daemon restart` and confirm the daemon comes back up with the same team file behavior.
6. Run `agvsr daemon stop` and confirm the daemon exits cleanly afterward.

## Regression Risks

### Highest risk

- detached spawn logic may be duplicated or diverge between `start` and `restart`
- start may accidentally block instead of returning immediately
- start may spawn a second daemon when one already exists

### Medium risk

- `restart` may lose `--team` forwarding during refactor
- foreground `daemon` signal handling may be affected by code sharing
- success/failure messages may become misleading or inconsistent

### Lower risk

- IPC transport behavior may change only indirectly, but should still be checked by `ping`
- docs or CLI usage strings may lag behind the new subcommand

## Focus Points For Review

- detached spawn behavior is the core of the change
- idempotence should be treated as required, not nice-to-have
- `job` auto-start must not appear in this phase
- the acceptance gate is user-visible behavior, not implementation shape

