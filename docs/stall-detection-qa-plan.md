# QA Test Plan: `docs/action-plan.md` §5 A/C

## Goal

Verify the remaining scope of `docs/design-stall-detection.md` as confirmed for this job:

- A-1 worker no-route guard
- A-2 idle watchdog
- idle_ms side effect isolation
- C note kind for finalText audit logs

This plan intentionally excludes `action-plan.md` §1-§4 and the already-completed B phase
(`runtime` visibility). The implementation is acceptable only if the A/C changes preserve the
existing supervisor no-route guard, the current `status` output shape, and the repository quality
checks.

## Scope

### In scope

- worker turns that exit `0` without routing anything
- supervisor escalation and re-dispatch behavior for that worker case
- idle watchdog detection when a running job has no in-flight turn and exceeds the stall threshold
- duplicate suppression and timer cleanup for the watchdog
- `idle_ms` not being reset by watchdog notification behavior
- `kind: "note"` for finalText audit rows and the CLI presentation of that kind
- regressions around the existing supervisor no-route guard and status display
- repository-level checks: `bun test`, `oxlint`, and `oxfmt`

### Out of scope

- redesign of job routing, worker sessions, or status semantics
- adding a new `stalled` job status
- broader changes from `action-plan.md` §1-§4
- implementation of the plan itself

## Acceptance Criteria

The implementation is acceptable only if all of the following hold:

1. A worker turn that exits `0` with no `agvsr` routing calls does not fail the job directly; it creates
   a daemon-to-supervisor escalation and the supervisor is dispatched again.
2. The existing supervisor no-route guard still fails the job when the supervisor itself exits `0`
   without routing anything.
3. The idle watchdog emits a stall notification only when a running job has no in-flight turn and the
   idle threshold is exceeded.
4. The idle watchdog does not emit duplicate notifications for the same stall window and stops when the
   daemon is closed.
5. Watchdog notification must not reset `idle_ms` by writing a new audit message.
6. FinalText-derived audit rows are stored and displayed as `kind: "note"` and remain distinct from
   `message` and `escalation`.
7. `status` still reports the existing runtime state correctly and is not broken by the note/stall work.
8. `bun test`, `oxlint`, and `oxfmt` remain green.

## Verification Matrix

### 1. Worker no-route guard

What to verify:

- a worker turn can complete with `exitCode: 0` and no routing activity
- the job is not failed immediately in that case
- the daemon writes a supervisor-directed escalation
- the supervisor is re-dispatched after the escalation

How to check:

- use the existing fake-runner style from `test/ipc.test.ts`
- make a supervisor turn route to a worker, then make the worker return `finalText` with no tool calls
- assert the job remains `running` after the worker turn
- assert a `from_role="daemon"`, `to_role="supervisor"`, `kind="escalation"` row is written
- assert the supervisor receives a second dispatch

Negative control:

- the same no-route pattern on the supervisor role must still fail the job, not escalate it

Acceptance criteria:

- worker no-route is recovered through escalation
- supervisor no-route still fails hard
- no accidental worker-to-worker routing is introduced

### 2. Idle watchdog

What to verify:

- only `running` jobs are considered
- only jobs with no in-flight turn are considered
- only jobs whose `idle_ms` meets or exceeds the stall threshold are notified
- the watchdog does not fire repeatedly for the same stalled job until activity resumes
- `daemon.close()` stops the timer

How to check:

- create a focused daemon test with a small `AGVSR_STALL_TIMEOUT_MS`
- drive a job to a state where it is `running` but idle and has no in-flight dispatch
- wait for the watchdog tick and capture the stall hook or equivalent notification path
- confirm the notification happens once
- wait for an additional tick and confirm no duplicate notification
- dispatch new activity for the same job and confirm the stall arm is reset
- close the daemon and confirm the timer no longer fires

Acceptance criteria:

- stall detection is gated by both runtime state and threshold
- duplicate notifications are suppressed
- timer cleanup is deterministic

### 3. `idle_ms` side effect

What to verify:

- watchdog notification does not create a fresh daemon audit message
- the latest audit timestamp is not advanced by the stall notification path
- `idle_ms` remains stable until real job activity occurs

How to check:

- capture the message list before the watchdog fires
- let the watchdog notify once
- compare the audit message count and the `created_at` ordering after notification
- assert that the notification mechanism does not add a new audit row that would reset the runtime clock

Acceptance criteria:

- stalled jobs remain observable as stalled
- runtime reporting is not self-cancelled by the watchdog itself

### 4. Note kind and CLI presentation

What to verify:

- finalText audit rows are stored with `kind: "note"`
- note rows remain visible in logs/status output
- `message` and `escalation` behavior is unchanged
- note presentation is visually distinct enough that it is not mistaken for a routed message

How to check:

- drive a turn that produces finalText
- inspect the stored message and assert `kind === "note"`
- run the existing `logs` and `status` paths against that job
- assert the note is rendered as a note label or equivalent visual treatment
- assert existing message/escalation rows still render as before

Acceptance criteria:

- note classification is correct in storage and display
- note changes do not alter routing semantics
- no existing message/escalation meaning is broken

### 5. Regression checks

What to verify:

- the existing supervisor no-route guard still fails the job
- `status` output remains coherent after the runtime/note changes
- the repository-level checks remain green

How to check:

- keep the relevant `ipc.test.ts` coverage for supervisor no-route behavior
- keep or extend the runtime/status coverage so the current status line still reflects `running` and the
  runtime text
- run the full repository checks:
  - `bun test`
  - `bunx oxlint`
  - `bunx oxfmt`

Acceptance criteria:

- no regression in current supervisor guard semantics
- no regression in status output
- lint, format, and test suites remain passing

## Specific Cases

### Positive cases

- worker exits `0` with finalText and no routing, then supervisor is escalated and re-dispatched
- idle running job with no in-flight turn triggers one stall notification
- re-arming after new activity allows a later stall notification
- finalText audit row is stored as `note`
- note rows remain distinguishable from `message` and `escalation`

### Negative cases

- supervisor exits `0` with no routing and still fails the job
- running job with in-flight work does not stall
- running job below the idle threshold does not stall
- watchdog notification does not rewrite the runtime clock
- note rows do not masquerade as routed messages

### Edge cases

- a worker that exits `0` without finalText is still handled by the idle watchdog rather than the
  no-route guard
- repeated stall ticks do not duplicate notifications
- `daemon.close()` stops the watchdog timer even if the job remains running
- existing database rows with older `message` kinds continue to render normally

## Execution Notes

- Prefer the existing daemon test harness used by `test/ipc.test.ts` and `test/runtime.test.ts`.
- Do not depend on a real external CLI if the daemon can be exercised directly with a fake runner.
- Treat `bun test` as necessary but not sufficient; the plan-specific cases above are the acceptance gate.
- Keep the implementation review focused on the A/C scope confirmed for this job.

## Review Outcome

The change is acceptable only if:

- A-1 worker no-route is escalated and re-dispatched, not failed
- A-2 stall detection is precise, deduplicated, and cleaned up
- `idle_ms` remains stable under watchdog notification
- C note classification is correct and non-breaking
- the existing supervisor guard, status display, and repository checks stay green
