# QA checklist: watch heartbeat

Scope:

- `agvsr watch` should show a per-poll heartbeat for each selected job.
- Heartbeat data must come from `job.get` runtime state, not a separate status model.
- Existing `msg.list` then `msg.watch` streaming behavior must remain intact.
- Default mode should watch running jobs only; `--all` should include terminal jobs too.

Checks:

1. Start a real daemon and create at least one running job.
2. Run `agvsr watch` without `--all` and confirm only running jobs are selected.
3. Confirm each poll issues `job.get` for the selected jobs and prints a heartbeat line.
4. Confirm heartbeat wording matches the existing status runtime formatter for running jobs.
5. Confirm `msg.list` output still appears before live `msg.watch` frames.
6. Confirm a new message sent after subscription appears in the stream.
7. Run `agvsr watch --all` and confirm terminal jobs are also polled and rendered.
8. Confirm no daemon/protocol changes were introduced outside the existing `job.get` runtime path.

Acceptance criteria:

- Heartbeats appear consistently and are derived from fresh runtime data.
- Message streaming behavior is unchanged for watched jobs.
- Default selection and `--all` selection follow the documented behavior.
- No unrelated daemon, protocol, or dependency changes are present.
