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
| File | What it does |
|---|---|
| `src/ipc/transport.ts` | `serve()` / `Client` / `DaemonNotRunningError`. POSIX UDS + Windows named pipe via same `node:net` path. |
| `src/daemon/store.ts` | `Store` — `bun:sqlite` WAL, jobs table, `createJob / getJob / listJobs / setJobStatus`. |
| `src/daemon/daemon.ts` | `startDaemon()` — IPC handler for `ping / job.* / team.get / msg.* / job.complete / job.fail`. |
| `src/config/team.ts` | `parseTeam / loadTeam / allowedTargets` — Zod-validated `team.yaml`, star topology edge derivation. |
| `src/paths.ts` | Cross-platform `configDir()`, `ipcEndpoint()`, `storePath()`. |
| `src/protocol.ts` | Wire types: `Job`, `Request` (all methods), `Response<T>`, `Frame`. |
| `src/cli/agvsr.ts` | CLI: `daemon / ping / job / status / team`. |
| `test/{store,team,ipc}.test.ts` | 11 passing tests. |

### Phase 2 — Adapter layer ✅ (on branch `phase-2-adapters`, not yet merged)
| File | What it does |
|---|---|
| `src/adapters/types.ts` | `AgentSpec`, `TurnEvent`, `TurnOutcome`, `TurnResult`, `CliDriver`, `TurnParser`, `SpawnSpec`, `SessionProbe`. |
| `src/adapters/charter.ts` | `stripHtmlComments`, `fillScaffold`, `composeCharter`. Scaffold + `defaults/<role>.md` composition. |
| `src/adapters/claude.ts` | `claudeDriver`: `--append-system-prompt`, `--resume`, stream-json parser. |
| `src/adapters/codex.ts` | `codexDriver`: `exec --json` / `exec resume <id>`, charter preamble, thread_id parser. |
| `src/adapters/agy.ts` | `agyDriver`: plain text, `probeSession` / `resolveSessionId` via conversations dir diff. |
| `src/adapters/run.ts` | `runTurn()`: shared spawn → stream → resolve session-id runner. |
| `src/adapters/index.ts` | Registry: `driverFor(adapter)`. Re-exports `runTurn`, `composeCharter`, types. |
| `src/mcp/shim.ts` | stdio MCP server. Exposes `agvsr_send`, `agvsr_escalate` (all roles), `agvsr_complete`, `agvsr_fail` (supervisor). Relays over UDS to daemon via `Client`. |
| `test/{charter,adapters,run,shim}.test.ts` | 18 passing tests (14 adapter + 4 shim integration). |

**Total: 29 passing tests, 0 failing.**

---

## Immediate Next Step: Phase 3 — Orchestration Runtime

This is where the project reaches **MVP**: a real job can be dispatched, an agent runs, completes, and the result is returned to the human.

### What Phase 3 must build

1. **Message router** in `daemon.ts`
   - `msg.send`: look up the target role in team config, spawn/resume the target agent, inject the body as a new turn.
   - `msg.escalate`: route to supervisor role.
   - Enforce star topology (D10): workers may only send to supervisor; daemon rejects disallowed targets.

2. **Job lifecycle** (`src/daemon/jobs.ts` or extend `daemon.ts`)
   - `job.create` already creates a DB record (Phase 1).
   - Phase 3: on `job.create`, spawn the **supervisor** agent with the goal as first turn.
   - On `job.complete` / `job.fail`: mark the store, notify the human (stdout / hook for now).
   - Conversation lifecycle: session IDs are stored per role-per-job; reset on new job (D12).

3. **Agent session registry**
   - Track `Map<roleId, sessionId | null>` in memory (per job). Persist to SQLite in Phase 6.
   - On first turn for a role+job: `sessionId = null` → charter is injected (new session).
   - On subsequent turns: `sessionId` is passed to `runTurn` → resume.

4. **MCP shim wiring**
   - When spawning an agent via `runTurn`, pass `--mcp-server "bun run src/mcp/shim.ts"` (or equivalent) with env:
     - `AGVSR_SOCK` — daemon socket path
     - `AGVSR_ROLE` — role name
     - `AGVSR_JOB_ID` — job id
     - `AGVSR_ALLOWED` — comma-separated allowed targets (from `allowedTargets()`)

5. **Tests**
   - Unit: fake `CliDriver` (returns canned `TurnResult`) to test router, lifecycle, session registry deterministically.
   - E2E (optional here, required by Phase 5): `agvsr job "..."` → supervisor → implementation → `agvsr_complete` on a toy repo.

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
  cli/agvsr.ts         ← CLI entrypoint
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
spikes/
  s1b-claude-resume.ts ← confirmed resume model for claude
  s2-codex.ts          ← confirmed codex exec resume shape
  s3-run.ts            ← confirmed MCP shim + UDS relay
examples/
  team.yaml            ← sample 4-role team (supervisor/design/impl/qa)
```

---

## Branch Status

| Branch | Status |
|---|---|
| `main` | Phase 0 + Phase 1 merged |
| `phase-2-adapters` | Phase 2 work (29 tests passing) — **needs merge** |

Run `git log --oneline` on `phase-2-adapters` to see commits.
