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

| File                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/daemon.ts` | Tracks consecutive per-role failure counts per job. After N failures (default 3, env `AGVSR_MAX_WORKER_FAILURES`), escalates to Tier2: hard-fails the job and writes a user-facing failure audit row. Success resets the counter. Crash path uses the same threshold logic. Adds `job.tell` handler (user → supervisor dispatch for running jobs) and `job.stop` handler (human-initiated job termination). |
| `src/protocol.ts`      | Adds `job.tell` (`{ job_id, body }`) and `job.stop` (`{ job_id }`) request types.                                                                                                                                                                                                                                                                                                                           |
| `src/cli/agvsr.ts`     | Adds `agvsr tell <job-id> "<message>"` (D15 steering) and `agvsr stop <job-id>` (D15 forced stop).                                                                                                                                                                                                                                                                                                          |
| `test/ipc.test.ts`     | Covers `job.tell` dispatch, `job.stop` status transition + double-stop rejection, and Tier2 hard-fail after N consecutive worker failures.                                                                                                                                                                                                                                                                  |

Current validation: **41 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 11 — Notification Event Hooks ✅

| File                   | What it does                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/hooks.ts`         | `fireHook(cmd, event)` — runs a user shell command with event JSON on stdin. Fire-and-forget; failures are swallowed so hooks never crash the daemon. Uses `sh -c` on POSIX, `cmd /c` on Windows.                                                                        |
| `src/config/team.ts`   | Adds optional `hooks` block to `TeamSchema` with `on_job_done`, `on_job_failed`, `on_supervisor_message` string fields.                                                                                                                                                  |
| `src/daemon/daemon.ts` | Fires hooks at every job-done/failed transition (`job.complete`, `job.fail`, `job.stop`, supervisor timeout, Tier2 watchdog, supervisor crash) and when supervisor sends a message to user (`msg.send` from=supervisor to=user). `hookRunner` is injectable for testing. |
| `examples/team.yaml`   | Adds commented-out `hooks:` section with platform examples.                                                                                                                                                                                                              |
| `test/hooks.test.ts`   | 8 tests: schema parsing (full/partial/absent), `on_job_done`, `on_job_failed` (via fail/stop), `on_supervisor_message`, and no-hooks path.                                                                                                                               |

Current validation: **49 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 12 — Loop / No-Progress Watchdog (D14 Tier1 signals) ✅

| File                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/daemon.ts` | Inspects `TurnResult.events` after every successful worker turn. Detects two Tier1 signals: (1) zero `tool_use` events for N consecutive turns (`AGVSR_NO_PROGRESS_TURNS`, default 3); (2) identical tool-call fingerprint for N consecutive turns (`AGVSR_LOOP_REPEAT_TURNS`, default 3). Either fires a Tier1 escalation to supervisor. After `AGVSR_MAX_LOOP_ESCALATIONS` (default 3) total loop Tier1s for a job, escalates to Tier2 hard-fail. agy adapter is skipped (no structured tool events in stdout, D28). Resets the loop escalation counter on any clean turn. |
| `test/ipc.test.ts`     | Covers: no-progress Tier1, same-fingerprint Tier1, loop Tier2 after N escalations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Current validation: **52 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 13 — Config Reload Without Restart (D17) ✅

| File                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/daemon.ts` | `team` and `runner` are now `let` so the `reload` handler can atomically swap them. Per-job team snapshots (`jobTeamSnapshots: Map<string, TeamConfig>`) are captured at `job.create` time. `dispatchRole`, `msg.send` routing, and `msg.escalate` all prefer the per-job snapshot, falling back to the live `team` only for jobs created before any snapshot was recorded. After `reload`, new jobs use the new team; existing jobs keep their snapshot. `defaultTurnRunner` reads `adapter`/`model` from `TurnDispatch` (not a captured closure), so it uses the right config for each job regardless of when reload fired. |
| `src/protocol.ts`      | Adds `reload` request type (no params, returns `{ roles: RoleSummary[] }`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/cli/agvsr.ts`     | Adds `agvsr reload` command: prints the new team's role table on success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/ipc.test.ts`     | Covers: reload reflects new roles, reload error path, snapshot isolation (old job routes to impl after reload removed impl; new job is forbidden).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Current validation: **55 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 14 — Server-Push Logs (`logs -f` real-time streaming) ✅

| File                   | What it does                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/protocol.ts`      | Adds `PushFrame { type:"push"; event:"msg.new"; data:Message }` and `msg.watch` request (`{ job_id, mark_read? }`). Updates `Frame` to include `PushFrame`.                                                                                                                                                                |
| `src/ipc/transport.ts` | Adds `PushFn = (frame:PushFrame) => boolean` (returns false when the connection is gone). `RequestHandler` now receives `push: PushFn` as second arg. `serve()` creates a per-connection push function and passes it to every handler call. `Client` dispatches incoming push frames to `onPush` callback.                 |
| `src/daemon/daemon.ts` | Adds `msgWatchers: Map<job_id, Set<watcher>>` and `notifyWatchers`. Wraps every `store.createMessage` call with `createMsg()` which writes the message and immediately pushes it to any live watchers. `msg.watch` handler registers the push function as a watcher; dead connections are pruned on the next push attempt. |
| `src/cli/agvsr.ts`     | `logs -f` now calls `msg.watch` and sets `c.onPush` instead of polling every second. The connection stays open until the process is killed.                                                                                                                                                                                |
| `test/ipc.test.ts`     | 3 new tests: push frame delivery, cross-job isolation (push only for the watched job), `not_found` error path.                                                                                                                                                                                                             |

Current validation: **58 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 15 — Job Branch Naming (CH5) ✅

| File                      | What it does                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/store.ts`     | `createJob` now generates `branch = "agvsr/<first-8-of-job-id>"` and stores it in `jobs.branch`. The column was always present but always null before.                                         |
| `src/adapters/charter.ts` | Adds `branch?: string \| null` to `CharterContext`. `fillScaffold` maps `{{branch}}` → the branch name (or `"(not set)"` if absent). `composeCharter` forwards `ctx.branch` to `fillScaffold`. |
| `charters/scaffold.md`    | Adds `- **Job branch:** \`{{branch}}\`` to the header block so every agent knows which branch to work on, satisfying CH5 without requiring the agent to invent a branch name.                  |
| `src/daemon/daemon.ts`    | Passes `branch: job.branch` to `composeCharter` and `AGVSR_JOB_BRANCH: job.branch ?? ""` in the env for every agent dispatch.                                                                  |
| `test/store.test.ts`      | Updates assertion: `branch` is now `"agvsr/<id-prefix>"` not null.                                                                                                                             |
| `test/charter.test.ts`    | Adds `branch` to all `fillScaffold` / `composeCharter` calls; asserts branch appears in output and `{{branch}}` leaves no leftover placeholders.                                               |

Current validation: **59 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 16 — `agvsr_status` MCP read-only tool (D19) ✅

| File                | What it does                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp/shim.ts`   | Adds `agvsr_status(last_n?)` tool available to all roles. Calls `job.get` + `msg.list` via IPC and returns a compact text summary: goal, status, branch, cwd, and the last N (default 10, max 50) audit messages. Adds `relayGet<T>` helper to shim for read-only IPC calls. |
| `test/shim.test.ts` | Test: stub returns canned `job.get` + `msg.list` responses; asserts summary contains goal, branch, status, message body, and that both IPC methods were called.                                                                                                              |

Current validation: **60 passing tests, 0 failing**; `bun run typecheck` passes.

### Phase 17 — Web Gateway Phase 1 ✅

| File / area                                 | What it does                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/agvsr.ts`                          | Adds `agvsr web` as a standalone gateway subcommand. It launches the Bun.serve process, prints the one-time startup token, and shuts down cleanly on SIGINT/SIGTERM.                                                                                                                            |
| `src/web/server.ts`                         | Starts the gateway, connects to the real daemon via `src/ipc/transport.ts`, loads the browser shell, and binds with UDS-first / loopback-TCP fallback.                                                                                                                                          |
| `src/web/auth*.ts`, `src/web/security.ts`   | Implements the startup-token login flow, HttpOnly session cookie, CSRF cookie/header checks, Host/Origin allowlists, and security headers. The startup token is hashed in SQLite and only shown once in process stdout.                                                                         |
| `src/web/routes.ts` + `src/web/ipc.ts`      | Exposes read-only `GET /api/session`, `GET /api/jobs`, and `GET /api/jobs/:id`. The job list is derived from `job.list` plus `job.get` runtime fan-out; job detail uses `job.get` + `msg.list` without marking messages read. The UI state derives `in_flight`, `idle`, and `possibly_stalled`. |
| `src/web/client/*`                          | Dependency-free TS SPA shell that polls every 2s, renders audit text via text nodes, and does not depend on live subscriptions or future-phase mutation endpoints.                                                                                                                              |
| `test/web-{auth,api,security,cli-smoke}.ts` | Covers auth/session cookies, startup-token hashing, Host/Origin/CSP checks, read-only list/detail behavior, and a real gateway smoke against a live daemon and live web process.                                                                                                                |

Current validation: **226 passing tests, 0 failing**; `bun run typecheck`, `bunx oxlint src test`, and `bunx oxfmt src test` all pass.

### Phase 18 — Web Gateway Phase 3 ✅

| File / area                      | What it does                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web/ipc.ts`                 | Adds thin `job.create / job.tell / job.stop / job.kill` daemon IPC wrappers with typed `WebDaemonError` propagation.                                                                                                                                                                                    |
| `src/web/auth-store.ts`          | Adds `web_operation_audit` plus insert/update/list helpers so web mutations are auditable without storing secrets or full message bodies.                                                                                                                                                                |
| `src/web/routes.ts`              | Adds POST `/api/jobs`, `/api/jobs/:id/tell`, `/stop`, and `/kill` with session, Host/Origin, CSRF, validation, and fail-closed audit writes.                                                                                                                                                            |
| `src/web/client/app.ts` + CSS    | Adds create-job, tell, stop, and kill controls to the DOM SPA and keeps all rendering text-node based.                                                                                                                                                                                                  |
| `test/web-ops.test.ts`           | Real daemon + real gateway + real HTTP integration coverage for create/tell/stop/kill, CSRF rejection, unauthenticated rejection, and audit rows.                                                                                                                                                       |

Current validation: **250 passing tests, 0 failing**; `bun run typecheck`, `bunx oxlint src test`, and `bunx oxfmt src test` all pass.

### Phase 19 — Turn-Failure Diagnostics ✅

| File                   | What it does                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/daemon.ts` | Adds `turnFailureDiagnostics(adapter, model, exitCode, stderrTail)` helper (2048-byte tail bound, same as `configErrorEscalation`). Enriches 3 failure sites: (1) supervisor non-timeout failure → user-facing body gets `exitCode/adapter/model` (no stderrTail, option b); (2) worker hard-fail at threshold → user-facing body gets `exitCode/adapter/model` (no stderrTail); (3) worker retry escalation → supervisor-facing body gets `exitCode/adapter/model/stderrTail`. Timeout reason text left unchanged. |
| `test/ipc.test.ts`     | 5 new tests: retry escalation body has exitCode/adapter/model/stderrTail; hard-fail user-facing body has exitCode/adapter/model but not raw stderr; supervisor non-timeout failure body has exitCode/adapter/model; timeout body unchanged and lacks exitCode=/stderrTail; long stderrTail truncated with tail kept and head dropped. |

Current validation: **275 passing tests, 0 failing**; `bun run typecheck`, `bunx oxlint src test`, and `bunx oxfmt src test` all pass.

Remaining next work:

1. **Real CLI smoke tests**
   - Optionally run against actual claude-code/codex binaries with credentials available; the committed E2E now covers the same daemon/adapter/MCP path deterministically using a fake `claude`.
   - For agy, verify whether the generated `mcp_config.json` location can be configured without mutating global user state; if not, keep it as documented setup.

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
| `main` | Phase 0–16 merged, 60 tests pass |
