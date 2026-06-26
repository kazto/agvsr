# agvsr — Implementation Progress

> Handoff document for agents or humans picking up this project.
> The authoritative design is in `docs/design.md` (architecture decisions D1-D28, charter decisions CH1-CH8).
> This file records what has been built, what is next, and where to look.

---

## Current State

### Phase 0 — Spikes ✅

Three real-machine spikes confirmed the adapter model:

- **S1/S1b** (`spikes/s1b-claude-resume.ts`): `claude --resume <id>` continues conversation across processes.
- **S2** (`spikes/s2-codex.ts`): codex `exec resume <thread_id>` pattern, asymmetric flag set.
- **S3** (`spikes/s3-run.ts` + `spikes/s3-mcp/`): stdio MCP shim intercepts tool calls and relays to UDS daemon.

Key finding: all three CLIs fit a unified **resume-invoke** model (D1). No persistent stdin injection needed.

### Phase 1 — Daemon skeleton ✅ (merged to main)

| File                            | What it does                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/ipc/transport.ts`          | `serve()` / `Client` / `DaemonNotRunningError`. POSIX UDS + Windows named pipe via same `node:net` path. |
| `src/daemon/store.ts`           | `Store` — `bun:sqlite` WAL, jobs table, `createJob / getJob / listJobs / setJobStatus`.                  |
| `src/daemon/daemon.ts`          | `startDaemon()` — IPC handler for `ping / job.* / team.get / msg.* / job.complete / job.fail`.           |
| `src/config/team.ts`            | `parseTeam / loadTeam / allowedTargets` — Zod-validated `team.yaml`, star topology edge derivation.      |
| `src/paths.ts`                  | Cross-platform `configDir()`, `ipcEndpoint()`, `storePath()`.                                            |
| `src/protocol.ts`               | Wire types: `Job`, `Request` (all methods), `Response<T>`, `Frame`.                                      |
| `src/cli/agvsr.ts`              | CLI: `daemon / ping / job / status / team`.                                                              |
| `test/{store,team,ipc}.test.ts` | 11 passing tests.                                                                                        |

### Phase 2 — Adapter layer ✅ (on branch `phase-2-adapters`, not yet merged)

| File                                       | What it does                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/types.ts`                    | `AgentSpec`, `TurnEvent`, `TurnOutcome`, `TurnResult`, `CliDriver`, `TurnParser`, `SpawnSpec`, `SessionProbe`.                                             |
| `src/adapters/charter.ts`                  | `stripHtmlComments`, `fillScaffold`, `composeCharter`. Scaffold + `defaults/<role>.md` composition.                                                        |
| `src/adapters/claude.ts`                   | `claudeDriver`: `--append-system-prompt`, `--resume`, stream-json parser.                                                                                  |
| `src/adapters/codex.ts`                    | `codexDriver`: `exec --json` / `exec resume <id>`, charter preamble, thread_id parser.                                                                     |
| `src/adapters/agy.ts`                      | `agyDriver`: plain text, `probeSession` / `resolveSessionId` via conversations dir diff.                                                                   |
| `src/adapters/run.ts`                      | `runTurn()`: shared spawn → stream → resolve session-id runner.                                                                                            |
| `src/adapters/index.ts`                    | Registry: `driverFor(adapter)`. Re-exports `runTurn`, `composeCharter`, types.                                                                             |
| `src/mcp/shim.ts`                          | stdio MCP server. Exposes `agvsr_send`, `agvsr_escalate` (all roles), `agvsr_complete`, `agvsr_fail` (supervisor). Relays over UDS to daemon via `Client`. |
| `test/{charter,adapters,run,shim}.test.ts` | 18 passing tests (14 adapter + 4 shim integration).                                                                                                        |

**Total: 29 passing tests, 0 failing.**

### Phase 3 — Orchestration Runtime ✅ (router/session core)

| File                                            | What it does                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/daemon.ts`                          | `startDaemon(options)` with injectable store/team/runner; `job.create` dispatches supervisor; `msg.send` routes allowed targets; `msg.escalate` routes to supervisor; role-per-job sessions are tracked in memory; per-role dispatch is serialized. |
| `src/daemon/store.ts`                           | Message audit API: `createMessage / listMessages / markMessageRead`.                                                                                                                                                                                |
| `src/protocol.ts`                               | `MessageKind` / `Message` wire/store types.                                                                                                                                                                                                         |
| `src/adapters/types.ts` + `src/adapters/run.ts` | `AgentSpec.env` passes daemon runtime env into spawned CLIs for MCP shim context.                                                                                                                                                                   |
| `test/ipc.test.ts`                              | Fake-runner daemon tests for job dispatch, allowed routing, forbidden worker-to-worker routing, escalation routing, and session resume.                                                                                                             |
| `test/store.test.ts`                            | Message audit persistence coverage.                                                                                                                                                                                                                 |

Current validation: **34 passing tests, 0 failing**; `bun run typecheck` passes.

---

### Phase 4 — MCP Spawn Wiring and Runtime Hardening ✅

| File                                                            | What it does                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/mcp.ts`                                           | Shared agvsr MCP stdio server config generation. Claude gets `--mcp-config` JSON; Codex gets `-c mcp_servers.agvsr.*` overrides; Antigravity can emit an `mcp_config.json` payload because its CLI help exposes no per-invocation MCP flag. |
| `src/adapters/claude.ts`                                        | Adds `--mcp-config <json>` and `--strict-mcp-config` so spawned claude-code turns load only the agvsr MCP shim supplied by the daemon.                                                                                                      |
| `src/adapters/codex.ts`                                         | Adds per-invocation Codex config overrides for `[mcp_servers.agvsr]`, including command/args/cwd/env/required.                                                                                                                              |
| `src/adapters/run.ts`                                           | Adds the first deterministic turn timeout watchdog (`timeoutMs`) and kills the spawned process on timeout.                                                                                                                                  |
| `src/daemon/daemon.ts`                                          | Default runner passes a 10-minute turn timeout (`AGVSR_TURN_TIMEOUT_MS` override).                                                                                                                                                          |
| `src/protocol.ts` + `src/daemon/daemon.ts` + `src/cli/agvsr.ts` | Adds `msg.list` and `agvsr logs <job-id>` so humans can read audit messages, including completion/failure rows.                                                                                                                             |
| `test/{adapters,run,ipc}.test.ts`                               | Covers MCP argv/config generation, timeout kill behavior, and audit log listing.                                                                                                                                                            |

Current validation: **35 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 5 — Session Persistence ✅

| File                   | What it does                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/daemon/store.ts`  | Adds `agent_sessions(job_id, role, session_id, updated_at)` plus `getAgentSession / setAgentSession`, preserving the daemon single-writer model.                                     |
| `src/daemon/daemon.ts` | Restores role/job session IDs from SQLite on cache miss and persists every non-null session returned by `runTurn`. Charter injection remains first-turn only (`sessionId === null`). |
| `test/store.test.ts`   | Covers session insert/update/read behavior.                                                                                                                                          |
| `test/ipc.test.ts`     | Covers daemon restart: a persisted supervisor session is reused and the system prompt is not reinjected.                                                                             |

Current validation: **36 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 6 — Restart Fail-Safe ✅

| File                   | What it does                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/store.ts`  | Adds `interruptRunningJobs()`, atomically moving stale `running` jobs to `interrupted`.                                                                                    |
| `src/daemon/daemon.ts` | On daemon start, marks stale running jobs interrupted and writes a daemon-to-user audit message. `interruptRunningJobsOnStart: false` is available only for focused tests. |
| `test/store.test.ts`   | Covers idempotent interruption of running jobs.                                                                                                                            |
| `test/ipc.test.ts`     | Covers daemon startup fail-safe and verifies stale jobs are not dispatched automatically.                                                                                  |

Current validation: **37 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 7 — Deterministic E2E Smoke ✅

| File               | What it does                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/e2e.test.ts` | Runs a real daemon, real default adapter runner, fake `claude` executable on `PATH`, and the real MCP shim. The fake CLI reads `--mcp-config`, starts `src/mcp/shim.ts`, calls `agvsr_complete`, and verifies the job reaches `done` with a completion audit row. |

Current validation: **37 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 8 — Log Follow and Read Tracking ✅

| File                                       | What it does                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `src/protocol.ts` + `src/daemon/daemon.ts` | Extends `msg.list` with `mark_read`; daemon marks listed audit messages read via `read_at`.                           |
| `src/cli/agvsr.ts`                         | Adds `agvsr logs <job-id> --follow/-f`, implemented as portable polling over IPC. Displayed messages are marked read. |
| `test/ipc.test.ts`                         | Covers `msg.list mark_read` and verifies subsequent reads expose `read_at`.                                           |

Current validation: **38 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 9 — Watchdog Tier1 Worker Failure Routing ✅

| File                   | What it does                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/daemon.ts` | Non-timeout worker turn failures now create a daemon-to-supervisor `escalation` and re-dispatch supervisor instead of immediately failing the job. Supervisor failures and timeout failures remain hard failures. Worker turn crashes follow the same Tier1 path. |
| `test/ipc.test.ts`     | Covers worker non-timeout failure: job remains `running`, an escalation audit row is written, and supervisor receives the failure context.                                                                                                                        |

Current validation: **38 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 10 — Watchdog Tier2 Threshold + Human Intervention ✅

| File                   | What it does                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/daemon/daemon.ts` | Tracks consecutive per-role failure counts per job. After N failures (default 3, env `AGVSR_MAX_WORKER_FAILURES`), escalates to Tier2: hard-fails the job and writes a user-facing failure audit row. Success resets the counter. Crash path uses the same threshold logic. Adds `job.tell` handler (user → supervisor dispatch for running jobs) and `job.stop` handler (human-initiated job termination). |
| `src/protocol.ts`      | Adds `job.tell` (`{ job_id, body }`) and `job.stop` (`{ job_id }`) request types.                                                                                                                                                                                                  |
| `src/cli/agvsr.ts`     | Adds `agvsr tell <job-id> "<message>"` (D15 steering) and `agvsr stop <job-id>` (D15 forced stop).                                                                                                                                                                                 |
| `test/ipc.test.ts`     | Covers `job.tell` dispatch, `job.stop` status transition + double-stop rejection, and Tier2 hard-fail after N consecutive worker failures.                                                                                                                                          |

Current validation: **41 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 11 — Notification Event Hooks ✅

| File                       | What it does                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks.ts`             | `fireHook(cmd, event)` — runs a user shell command with event JSON on stdin. Fire-and-forget; failures are swallowed so hooks never crash the daemon. Uses `sh -c` on POSIX, `cmd /c` on Windows.                                             |
| `src/config/team.ts`       | Adds optional `hooks` block to `TeamSchema` with `on_job_done`, `on_job_failed`, `on_supervisor_message` string fields.                                                                                                                        |
| `src/daemon/daemon.ts`     | Fires hooks at every job-done/failed transition (`job.complete`, `job.fail`, `job.stop`, supervisor timeout, Tier2 watchdog, supervisor crash) and when supervisor sends a message to user (`msg.send` from=supervisor to=user). `hookRunner` is injectable for testing. |
| `examples/team.yaml`       | Adds commented-out `hooks:` section with platform examples.                                                                                                                                                                                    |
| `test/hooks.test.ts`       | 8 tests: schema parsing (full/partial/absent), `on_job_done`, `on_job_failed` (via fail/stop), `on_supervisor_message`, and no-hooks path.                                                                                                     |

Current validation: **49 passing tests, 0 failing**; `bun run typecheck` passes.

Remaining next work:

1. **Real CLI smoke tests**
   - Optionally run against actual claude-code/codex binaries with credentials available; the committed E2E now covers the same daemon/adapter/MCP path deterministically using a fake `claude`.
   - For agy, verify whether the generated `mcp_config.json` location can be configured without mutating global user state; if not, keep it as documented setup.

2. **Loop/no-progress watchdog signals** (D14)
   - Same-tool-same-args repeated N times.
   - No file changes for N turns (zero `tool_use` events touching the workspace).
   These require parsing `TurnEvent` stream data from adapter drivers, which is not yet wired into the daemon.

3. **Persistence hardening**
   - Consider a true server-push logs stream later; current `logs -f` uses portable polling.

### Key design constraints to respect

- **Star topology (D10)**: supervisor is the hub. Workers must NOT be able to reach each other. `allowedTargets()` in `src/config/team.ts` already computes the allowed set; daemon must enforce it before routing.
- **Sequential turns (D27)**: one active turn per role at a time. The daemon serializes dispatch.
- **Session ID ownership (D1/D8)**: `runTurn` returns `TurnResult.outcome.sessionId`. The daemon stores it; `agyDriver` resolves it out-of-band via `resolveSessionId`.
- **Charter injection once (D25)**: `sessionId === null` → pass `composeCharter(...)` as `spec.systemPrompt`; subsequent turns pass `""` (charter already in context).

---

## File Map (quick navigation)

```
src/
  protocol.ts          ← wire types (all IPC methods)
  paths.ts             ← cross-platform paths + IPC endpoint
  ipc/transport.ts     ← serve() / Client / DaemonNotRunningError
  daemon/
    daemon.ts          ← startDaemon(), all request handlers
    store.ts           ← SQLite store (jobs)
  config/team.ts       ← team.yaml loader, allowedTargets()
  adapters/
    types.ts           ← CliDriver interface, TurnEvent/Result
    charter.ts         ← composeCharter, fillScaffold
    claude.ts          ← claude driver
    codex.ts           ← codex driver
    agy.ts             ← agy driver
    run.ts             ← runTurn() shared runner
    index.ts           ← driverFor() registry
  mcp/shim.ts          ← stdio MCP server (agvsr_send, escalate, complete, fail)
  cli/agvsr.ts         ← CLI entrypoint (job/status/team/logs/logs -f)
charters/
  scaffold.md          ← Layer 1 protocol (immutable, filled at spawn time)
  defaults/
    supervisor.md      ← supervisor role charter (CH8 goal-pursuit loop)
    design.md          ← design role charter
    implementation.md  ← implementation role charter (unit + E2E happy path)
    qa.md              ← QA role charter (2-phase: test plan + verify)
docs/
  design.md            ← full architecture decisions (D1-D28, CH1-CH8)
  progress.md          ← this file
test/
  store.test.ts        ← SQLite store tests
  team.test.ts         ← team.yaml validation tests
  ipc.test.ts          ← IPC transport tests
  charter.test.ts      ← charter composition tests
  adapters.test.ts     ← per-driver spawn/parse tests
  run.test.ts          ← runTurn() tests
  shim.test.ts         ← MCP shim integration tests
  e2e.test.ts          ← deterministic daemon → adapter → fake CLI → MCP shim smoke test
spikes/
  s1b-claude-resume.ts ← confirmed resume model for claude
  s2-codex.ts          ← confirmed codex exec resume shape
  s3-run.ts            ← confirmed MCP shim + UDS relay
examples/
  team.yaml            ← sample 4-role team (supervisor/design/impl/qa)
```

---

## Branch Status

| Branch | Status                           |
| ------ | -------------------------------- |
| `main` | Phase 0–11 merged, 49 tests pass |
