# QA Test Plan: `agvsr watch`

Scope: review commit `df47582` and verify the new `agvsr watch` CLI against
`docs/action-plan.md`, with emphasis on real-time cross-job role-message
streaming via the existing `msg.watch` push path.

## Acceptance criteria

1. `agvsr watch` streams role messages for more than one job on one client.
2. `--all` includes non-running jobs; default mode excludes them.
3. `--poll N` respects the lower bound and does not accept values below the
   implementation minimum.
4. For each watched job, the CLI replays existing messages before live push
   frames.
5. Push routing is job-scoped: messages from unwatched jobs do not appear.
6. Late-discovered jobs are picked up on later polls and begin streaming.
7. The implementation does not introduce duplicate display beyond the known
   list/watch race, and it deduplicates replay/live delivery for a single
   message.
8. Usage/help text and docs describe the command and options accurately.
9. Required verification commands pass: `bun test`, `bun run typecheck`,
   `bunx oxlint src test`, `bunx oxfmt src test`.

## Test cases

### 1. Multi-job live streaming

- Start two running jobs.
- Subscribe to both job ids through `msg.watch`.
- Send a message to each job.
- Check that both payloads are delivered on the same client and are tagged
  with the correct `job_id`.

### 2. Job isolation

- Subscribe to job A only.
- Send a message to job B.
- Confirm no push frame is displayed for job B.
- Then send to job A and confirm exactly one push frame appears.

### 3. Replay-before-live flow

- Create a job, send a message before subscribing, and confirm `msg.list`
  returns that history.
- Subscribe with `msg.watch`.
- Send a new message and confirm live delivery still works.

### 4. Poll-driven late job discovery

- Start with no running jobs or with a later-created job.
- Confirm the poll loop can discover a new job after startup.
- Verify the new job is subscribed and its messages stream after discovery.

### 5. `--all` and status filtering

- Confirm default mode only watches jobs whose status is `running`.
- Confirm `--all` includes terminal jobs as well.
- Confirm terminal jobs are still displayed as watch targets, but live
  delivery behavior is limited to future messages only.

### 6. Poll interval floor

- Run with `--poll 1` and inspect the computed interval.
- Confirm the effective poll interval is clamped to the implementation
  minimum of 500 ms.

### 7. Duplicate / missed-frame behavior

- Exercise replay plus live push for the same job and message sequence.
- Confirm a message is rendered once even if it arrives through both paths.
- Note any remaining race where a message can appear between list and watch;
  this is acceptable only if it is documented and bounded to the known race.

### 8. Docs / usage

- Check `agvsr watch --help` or usage text for `--all` and `--poll N`.
- Check `docs/action-plan.md` for the feature entry and behavior summary.

## Verification commands

Run these from the repo root:

- `bun test`
- `bun run typecheck`
- `bunx oxlint src test`
- `bunx oxfmt src test`

## Verdict rule

- Pass if the acceptance criteria above are satisfied and the verification
  commands succeed.
- Fail if any criterion is violated, especially routing, filtering, replay,
  or duplicate-display behavior.
