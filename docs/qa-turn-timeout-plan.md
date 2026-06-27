# QA Test Plan: Turn Timeout Control

## Goal

Verify the implementation described in `docs/design-turn-timeout.md` for the first release slice of
turn timeout control:

- split per-turn timeout handling into `idle` and `hard`
- keep progress-sensitive turns alive until the idle budget is exceeded
- preserve a hard upper bound as a safety limit
- resolve timeout settings with the agreed priority order
- expose remaining hard budget and last progress time in `status`
- keep the existing stall watchdog behavior separate and unchanged

This plan is written against the confirmed scope for this job:

- Tier 1 and Tier 2 are both in scope
- default values are `idle = 10 minutes` and `hard = 60 minutes`
- `AGVSR_TURN_TIMEOUT_MS` remains a backward-compatible hard timeout fallback
- per-role keys are `hard_timeout_ms` and `idle_timeout_ms`

## Scope

### In scope

- `src/adapters/run.ts` timeout behavior for progress and no-progress cases
- daemon timeout resolution from role config, environment, and defaults
- backward compatibility for `AGVSR_TURN_TIMEOUT_MS`
- `status` runtime output for hard remaining time and last progress time
- failure messaging and timeout classification
- regression coverage for the existing stall watchdog and runtime/status output
- repository checks:
  - `bun test`
  - `bun run typecheck`
  - `bunx oxlint src test`
  - `oxfmt`

### Out of scope

- redesign of the routing model
- changes to the existing stall watchdog policy
- non-timeout feature work
- fixing implementation defects in this phase

## Acceptance Criteria

The implementation is acceptable only if all of the following are true:

1. A turn that keeps producing stdout lines before the idle budget expires is not killed by idle timeout.
2. A turn that stops producing progress is killed after the idle budget and is reported as an idle timeout.
3. A turn can still be killed by the hard timeout even if it keeps producing progress.
4. Role settings override environment variables, and environment variables override defaults.
5. `AGVSR_TURN_TIMEOUT_MS` still works as a hard timeout fallback when the new hard timeout env var is absent.
6. `idle_timeout_ms` is clamped to the hard timeout when the configured idle budget would exceed it.
7. `status` shows the live hard budget remaining for in-flight turns.
8. `status` shows the most recent progress time or equivalent progress age for in-flight turns if Tier 2 is implemented as designed.
9. Existing stall watchdog behavior remains separate from the new per-turn timeout logic.
10. The repository checks listed above remain green.

## Verification Matrix

### 1. `runTurn` unit coverage

What to verify:

- progress resets the idle timer
- idle timeout fires when progress stops
- hard timeout fires even if progress continues
- synthesized result text distinguishes `idle` from `hard`
- `TurnOutcome` reports timeout classification in a way the daemon can consume

How to check:

- extend `test/run.test.ts`
- use a fake driver backed by a small Bun script that emits stdout lines at controlled delays
- cover at least these cases:
  - multiple stdout lines spaced shorter than `idleTimeoutMs`, total elapsed time longer than `idleTimeoutMs`
  - stdout stops after some progress and exceeds `idleTimeoutMs`
  - stdout continues but elapsed time exceeds `hardTimeoutMs`
  - legacy `timeoutMs` path still behaves as hard fallback when used directly

Acceptance criteria:

- no-progress turns fail for the correct reason
- progress-sensitive turns survive until the configured hard limit
- the result object exposes enough information for daemon-side classification

### 2. Daemon timeout resolution

What to verify:

- role config values win over environment variables
- environment variables win over defaults
- `AGVSR_TURN_TIMEOUT_MS` still feeds the hard timeout fallback
- `idle_timeout_ms` is not allowed to exceed the resolved hard timeout
- resolved values are actually passed to the turn runner

How to check:

- add focused daemon tests in `test/ipc.test.ts` or a nearby daemon test file
- use a custom `turnRunner` that captures the resolved dispatch payload
- set up temporary team configs with and without per-role timeout keys
- cover all of these permutations:
  - role values present
  - role values absent, env values present
  - only defaults present
  - new hard timeout env var absent, legacy `AGVSR_TURN_TIMEOUT_MS` present
  - idle greater than hard, expecting clamp to hard

Acceptance criteria:

- the resolved hard and idle values follow the documented priority order
- the backward-compatible env var still works as a hard fallback
- the daemon never passes an idle budget larger than the hard budget

### 3. Failure reporting and job outcome

What to verify:

- idle timeout produces the expected failure reason
- hard timeout produces a distinct failure reason
- timed-out turns still fail the job through the existing daemon path
- the job status transitions remain unchanged except for the expected failure

How to check:

- drive daemon-managed jobs with a controlled runner that can trigger idle and hard cases
- inspect stored audit messages and job status after each timeout
- assert the failure body includes the timeout kind or the specific timeout phrase

Acceptance criteria:

- the daemon still marks the job failed on timeout
- idle and hard failures are distinguishable to users and tests

### 4. `status` runtime output

What to verify:

- in-flight jobs show hard remaining time
- the displayed hard remaining value decreases over time
- terminal jobs still render runtime as empty
- Tier 2 progress visibility, if implemented, shows last progress age or equivalent

How to check:

- extend `test/cli-daemon.test.ts` status coverage
- use a running daemon with a controlled in-flight turn
- call `job.get` and `agvsr status <job-id>` during the turn
- assert that the runtime structure contains the expected fields
- assert that the CLI output includes the budget remaining text and, if present, last progress text

Acceptance criteria:

- status output is informative without changing terminal-state behavior
- the live runtime fields match the daemon state for running jobs

### 5. Stall watchdog regression

What to verify:

- the existing idle watchdog still watches only non in-flight running jobs
- the watchdog still uses its existing stall threshold path
- the watchdog does not become coupled to the new per-turn idle timeout
- watchdog notification does not reset turn progress or otherwise interfere with the new timeout logic

How to check:

- keep the existing stall-related tests in `test/ipc.test.ts`
- add assertions only where needed to prove the new timeout work did not change the watchdog behavior
- confirm the old stall scenario still triggers the same notification path and still does not fail the job

Acceptance criteria:

- no regression in stall detection semantics
- the new timeout feature remains independent from the watchdog

### 6. Schema and compatibility checks

What to verify:

- `hard_timeout_ms` and `idle_timeout_ms` are accepted as optional role keys
- existing `team.yaml` files without the new keys still parse
- old timeout environment behavior remains supported
- existing tests that touch runtime, IPC, and daemon startup remain green

How to check:

- extend config parsing coverage where needed
- verify temporary team files with and without the new keys
- keep existing `test/e2e.test.ts`, `test/runtime.test.ts`, and `test/ipc.test.ts` cases passing

Acceptance criteria:

- the new schema fields are backward compatible
- old configuration shapes continue to work

## Specific Cases

### Positive cases

- progress arrives often enough that idle timeout never fires
- progress stops long enough that idle timeout fires
- progress continues long enough that hard timeout fires
- role config overrides env overrides defaults
- `AGVSR_TURN_TIMEOUT_MS` still controls hard fallback when the new hard env var is absent
- `status` shows live hard remaining time for a running job
- Tier 2 progress visibility appears if included in the implementation

### Negative cases

- a turn with no progress past idle timeout must fail
- a turn with progress must not be killed by idle timeout before the idle budget expires
- a turn must not ignore the hard timeout
- `idle_timeout_ms` must not exceed the hard timeout after resolution
- terminal jobs must not show live runtime text

### Edge cases

- `idle_timeout_ms` equal to `hard_timeout_ms`
- `idle_timeout_ms` greater than `hard_timeout_ms`
- legacy `AGVSR_TURN_TIMEOUT_MS` set without new env vars
- invalid or non-positive timeout env values falling back to defaults
- roles without any timeout overrides
- short-lived turns that finish before any timeout boundary

## Planned Test Locations

- `test/run.test.ts`
- `test/ipc.test.ts`
- `test/cli-daemon.test.ts`
- `test/runtime.test.ts` if runtime assertions need a focused regression check
- `test/e2e.test.ts` if an end-to-end smoke case is the easiest way to cover the fallback path

## Execution Notes

- Prefer the existing fake-runner patterns already used in the repository.
- Use temporary team files and temporary sockets/databases for daemon tests.
- Do not depend on user-global state except for explicitly controlled environment variables inside the test case.
- Treat `bun test` as necessary but not sufficient; the plan-specific assertions above are the real gate.
- Run the repository checks listed in Scope after the targeted tests are green.

## Review Outcome

The implementation is acceptable only if:

- idle timeout and hard timeout are both verified independently
- settings resolution matches the documented priority order
- backward compatibility for `AGVSR_TURN_TIMEOUT_MS` is preserved
- `status` shows the intended live runtime data
- the stall watchdog behavior remains unchanged
- all repository checks pass
