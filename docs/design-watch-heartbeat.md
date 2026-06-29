# Design: watch heartbeat/liveness lines

## Scope and assumptions

- Keep the change inside `src/cli/agvsr.ts` plus focused tests in `test/watch.test.ts`.
- Do not change `src/protocol.ts`, `src/daemon/daemon.ts`, or any IPC methods. `job.get` already returns `{ job, runtime }`, and `computeRuntime()` already supplies the needed `JobRuntime` fields.
- Reuse the existing status runtime wording and thresholds by calling the same CLI formatter path that `status <job-id>` uses today.
- Preserve the role-message stream exactly: push frames still print through `printMsg()`, and heartbeat lines are additive poll output, not replacements for messages.

## Files/functions to touch

- `src/cli/agvsr.ts`
  - Export `formatDuration()` and `formatRuntime()` if tests need direct assertions. Keep the implementation unchanged unless a tiny wrapper is needed for watch-specific display.
  - Add a watch-local formatter, e.g. `formatWatchRuntimeLine(job, runtime, shortId, dim)`, near the existing `watch` helpers. It should build one line from `job.get` data:
    - Prefix with `[shortId]` so multi-job output remains attributable.
    - Include the job status and the existing `formatRuntime(job, runtime)` suffix.
    - Prefer a compact shape such as `~ heartbeat [abcd1234] running — working: implementation, last progress 2s ago, idle 4s`.
    - For non-running jobs under `--all`, `formatRuntime()` returns `""`; still render `~ heartbeat [abcd1234] done <goal>` or skip runtime detail, but do not label them stalled.
  - In the existing `poll()` inside the `watch` command, after filtering target jobs and before/after `subscribeToJob(job)`, call `job.get` for each target job:
    - `const getRes = await c.request<{ job: Job; runtime: JobRuntime }>("job.get", { id: job.id });`
    - If it fails, continue without printing heartbeat. This matches the current watch behavior of ignoring transient `job.list`/`msg.list` failures.
    - Render the heartbeat from `getRes.result.job` rather than the stale `job.list` item, so status changes between list/get are reflected.
  - Avoid any changes to `msg.watch`, `msg.list`, `onPush`, or `printMsg` ordering except the extra heartbeat line.

## TTY and non-TTY behavior

- TTY:
  - Use the existing `dim()` helper for heartbeat/header lines, the same style as `+ watching ...`.
  - Do not clear the screen or redraw in place. This preserves scrollback and avoids interfering with streamed messages.
  - Heartbeat lines appear once per poll for each target job. This is intentionally additive and simple.
- Non-TTY:
  - Emit plain text with no ANSI codes, because `dim()` already becomes identity when `stdout` is not a TTY.
  - Keep the same line-oriented format as TTY so logs can be grepped.
  - No carriage returns, spinners, or terminal control sequences.

## Runtime wording and thresholds

- Reuse `formatRuntime(job, runtime)` directly. It already encodes the status command's behavior:
  - terminal jobs: no runtime suffix;
  - idle running jobs: `no in-flight turn, idle <duration> (possibly stalled)`;
  - active jobs: `working: <role>, budget <duration> left, last progress <duration> ago, idle <duration>`.
- Do not introduce a new stall threshold in watch. The only client-side "possibly stalled" signal should remain the existing `!runtime.in_flight` branch in `formatRuntime()`, while daemon-side watchdog policy remains in `computeRuntime()`/stall notification code.
- If the example wording `implementation working last progress 2s ago` is desired, achieve it by the watch wrapper only reordering/prefixing existing `formatRuntime()` content, not by creating a separate threshold policy. The minimal recommendation is to keep the exact status suffix to prevent drift.

## End-to-end behavior

- Start `agvsr watch` as today.
- Every `pollMs`, `job.list` selects target jobs:
  - default: only `running`;
  - `--all`: every job.
- For every selected job, `watch`:
  - subscribes once if not already subscribed, preserving historical message replay and push streaming;
  - fetches fresh runtime via `job.get`;
  - prints one heartbeat/header line with the job id, status, goal, and runtime text.
- Success condition: while a job is running with an in-flight role, the watch output includes a heartbeat identifying the role as working and showing budget/progress details when present; after the job is running but has no in-flight turn, a later heartbeat includes `possibly stalled`; message bodies still appear exactly once through history replay or push.

## Test strategy

- Extend `test/watch.test.ts`; keep using the existing daemon/client harness.
- Add small pure formatter tests if `formatRuntime()`/the watch wrapper is exported:
  - active runtime with `active_roles: ["implementation"]` and `idle_since_progress_ms` renders `working` and `last progress 2s ago`;
  - idle running runtime renders `no in-flight turn`, `idle 23m`, and `possibly stalled`;
  - terminal job produces no runtime suffix.
- Add a watch-flow test using a stub client or a tiny exported polling helper if implementation chooses to extract one:
  - given `job.list` with two jobs and `showAll=false`, assert `job.get` is called only for running jobs;
  - given `showAll=true`, assert `job.get` is called for terminal jobs too;
  - assert `msg.list`/`msg.watch` still happen once per job and duplicate messages are suppressed by the existing `seen` set.
- Add or preserve an integration-style daemon harness case:
  - create a job whose turn is gated so `job.get.runtime.in_flight=true`;
  - simulate one watch poll;
  - assert heartbeat output contains the short id and `working: implementation`;
  - release the turn, wait until runtime is no longer in flight, simulate another poll, and assert `possibly stalled` appears while no duplicate historical message is printed.
- Run `bun test test/watch.test.ts` first, then `bun test` if implementation time allows. Follow repo instructions with `bunx oxfmt` and `bunx oxlint`.

## Alternatives considered

- Daemon/server-push heartbeat frames: rejected because the goal explicitly forbids daemon/protocol changes and the existing poll loop is sufficient.
- A live dashboard with screen clearing or in-place updates: rejected because it would disturb the role-message stream and make non-TTY output harder to consume.
- Duplicating status formatting in watch: rejected because status and watch would drift on wording, duration formatting, and stall semantics.
- Polling `msg.list` only and deriving liveness from messages: rejected because `JobRuntime` already has authoritative in-flight/progress state from the daemon.
- Broad extraction of CLI command classes/helpers: rejected because `src/cli/agvsr.ts` is shared with another job and the requested scope is the watch command region.
