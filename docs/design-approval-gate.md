# Design-approval gate

A structural human checkpoint so a job cannot move from **design** to **implementation**
until the human approves the design. Backstops the supervisor charter rule (prose alone is
unreliable — see the worker no-route guard precedent).

## Decision

Gate **all jobs uniformly** — no heuristic "non-triviality" predicate. Once a design has
been handed to the supervisor, the daemon blocks the supervisor → implementation handoff
until the human approves. Chosen over a regex-based "only non-trivial" gate because the
regex over-matched (most daemon/adapter work mentions spawn/ipc/adapter) and was brittle.

## Enforcement (daemon, `src/daemon/daemon.ts`)

In the `msg.send` handler, when `from === "supervisor"` and `to` is an implementation role
(`implementation` or a name starting with `implementation`):

1. Find the latest `design → supervisor` handoff in the job's message history. If none
   exists, allow (jobs that intentionally skip design are unaffected).
2. Otherwise require approval: the most recent `user → supervisor` reply after that handoff
   must read as approval (`APPROVAL_RE`) and not as rejection (`REJECTION_RE`). A later
   "stop"/"reject" overrides an earlier "approved"; no reply means not yet approved.
3. If not approved: do **not** record or dispatch the handoff. Emit a `daemon → user`
   escalation telling the human to reply `agvsr tell <job> "approved"`, and return the IPC
   error `approval_required` so the supervisor's tool call fails visibly.
4. A newer design handoff resets the requirement (approval must come after the latest one).

Supervisor escalations (`msg.escalate` from the supervisor) now route to `user` instead of
looping back to the supervisor, so the design summary / approval request actually reaches
the human. Worker escalations still route to the supervisor.

**Disable** with `AGVSR_DESIGN_GATE` in `{0, off, false, no}` (default: on).

## Supervisor charter (`charters/defaults/supervisor.md`)

The supervisor is told to send the human a short design summary (approach, mechanisms /
dependencies, files touched, alternatives) and wait for approval before delegating to
implementation; if the human asks for changes, route back to design. The daemon enforces
this regardless of whether the supervisor remembers to.

## Tests

- `test/ipc.test.ts`: gate blocks with `approval_required` + logs a user escalation; approval
  via `job.tell` unblocks; a newer design handoff re-gates; supervisor escalation routes to
  the user.
- `test/charter.test.ts`: asserts the supervisor charter carries the approval wording.

## Known limitations

- `created_at` is millisecond-precision ISO; events within the same millisecond have
  undefined order. Human-paced approvals are seconds apart, so this is not a practical issue.
- Approval detection is phrase-based; the escalation tells the human the exact phrase to use.
