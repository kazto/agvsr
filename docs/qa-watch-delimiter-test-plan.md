# QA Test Plan: `agvsr watch` delimiter rendering

Scope: verify the watch-only rendering change in `src/cli/agvsr.ts`, limited to
the local `printMsg(jobId, m)` path inside the `watch` case.

## Goal

When `agvsr watch` prints more than one message item, it should insert a single
dimmed separator line (`---`) between consecutive message items, regardless of
whether those items came from the initial `msg.list` backfill or later live
`msg.new` push frames. Existing message formatting must stay unchanged.

## Acceptance criteria

1. Two or more rendered message items in `agvsr watch` produce exactly one
   separator line between each adjacent pair.
2. The first rendered message does not get a separator before it.
3. A separator is not emitted after the watch banner / status lines when no
   message has been printed yet.
4. The separator behavior applies across backfilled messages and later live
   messages in the same watch session.
5. The timestamp, refs, header (`kind from -> to`), body, and trailing blank
   line for each message remain unchanged.
6. `logs`, `status`, `tell`, and other non-watch CLI commands do not gain
   separator lines.
7. Required verification commands after implementation succeed:
   `bun test`, `oxlint`, `oxfmt`.

## Most focused verification approach

Use a real daemon and a real spawned CLI process for watch output, without
mocking the changed `printMsg` behavior. Keep the existing transport-level watch
tests for IPC semantics, and add one small CLI rendering test path that only
observes stdout.

Recommended file changes:

1. Update `test/watch.test.ts` with a new `describe("agvsr watch — delimiter rendering")`
   block that spawns `bun run src/cli/agvsr.ts watch` against an ephemeral
   daemon and captures stdout line-by-line.
2. Update `test/cli-daemon.test.ts` to add negative assertions that existing
   `status` output still contains no delimiter lines.
3. If `logs` does not already have CLI coverage, add a tiny dedicated CLI smoke
   test file such as `test/cli-logs.test.ts` or extend `test/cli-daemon.test.ts`
   with one `logs` and one `tell` assertion, each checking that `stdout` does
   not contain `---`.

## Test cases

### 1. Backfill-only rendering

- Create a job and write two messages before starting the watch CLI.
- Start `agvsr watch --poll 500` against the real daemon.
- Capture stdout until both backfilled messages are printed.
- Assert:
  - the watch banner and `+ watching [...]` line still appear,
  - the first message block appears with no leading separator,
  - exactly one `---` line appears between the two backfilled message blocks,
  - the message header/body/blank-line formatting is unchanged.

### 2. Live message after backfill

- Keep the same watch session open after the backfilled messages are rendered.
- Send one additional live message to the same job through IPC.
- Assert the live message is printed with one separator line immediately before
  it, and no extra separator lines are inserted around it.
- This is the main regression check for the shared `printMsg` state across
  `msg.list` and `msg.new`.

### 3. No separator before the first message

- Start `agvsr watch` in a case with at least one watched job and only one
  message so far, or no messages at all.
- Assert there is no `---` line before the first rendered message.
- Assert the banner / status / tip output is not followed by a separator on its
  own.

### 4. Existing formatting unchanged

- For one representative message, assert the rendered line still includes the
  same timestamp, refs suffix when present, header fields, body, and trailing
  blank line as before.
- Check this with direct string assertions or a narrow line-by-line expectation,
  not a broad snapshot that would hide regressions in the message payload.

### 5. Non-watch commands stay clean

- Spawn `agvsr status <job-id>` and confirm stdout does not contain `---`.
- Spawn `agvsr logs <job-id>` and confirm stdout does not contain `---`.
- Spawn `agvsr tell <job-id> "<message>"` and confirm the acknowledgement does
  not contain `---`.
- These checks can reuse the existing CLI smoke style already used in
  `test/cli-daemon.test.ts`.

## Notes on implementation boundaries

- Do not mock the separator logic itself; the purpose is to validate the actual
  CLI output path.
- Do not expand the transport-level `msg.watch` tests unless they are needed to
  set up the CLI smoke scenario.
- Do not add new flags, runtime dependencies, or broad harness changes.

## Verification commands

After the implementation lands, run:

```bash
bunx oxfmt src test docs/qa-watch-delimiter-test-plan.md
bunx oxlint src test
bun test
```

## Verdict rule

- Pass if the watch CLI prints exactly one separator between consecutive
  messages, preserves existing message formatting, and non-watch commands stay
  free of separator lines.
- Fail if the delimiter appears before the first message, after banner/status
  output, between the wrong message boundaries, or leaks into non-watch
  commands.
