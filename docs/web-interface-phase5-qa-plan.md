# QA Test Plan: Phase 5 daemon lifecycle push (`job.update`)

## Goal

Verify the approved Phase 5 design in `docs/design-web-interface.md` section 13:
daemon lifecycle push `job.update` replaces the 2-second polling loop for live job-list
updates while preserving existing `msg.new` behavior, security checks, and fallback
polling.

## In Scope

- Protocol:
  - `PushFrame` remains a discriminated union with existing `msg.new` plus new `job.update`
  - `job.watch` request shape
  - JSON round-trip compatibility for both push events
- Daemon real IPC:
  - `job.watch` subscription
  - successful job creation emits `running`
  - lifecycle transitions emit exactly once per transition for `done`, `failed`, and `interrupted`
  - ordering is preserved
  - changes that happened before subscription are not delivered
- Gateway real WebSocket:
  - `/api/jobs/stream` receives `job.update`
  - fanout reaches multiple clients
  - per-job `/api/jobs/:id/stream` remains `msg.new` only
  - unauthenticated or bad-origin upgrades reject with `401` / `403`
- Client behavior:
  - primary 2-second job-list polling is removed
  - the global stream drives debounced refreshes
  - a slow `30-60s` fallback poll remains
- Regression / non-goals:
  - no `agvsr watch` / `agvsr wait` behavior changes
  - no Phase 4 Web Push files touched (`src/web/push.ts`, service worker, VAPID)
  - no README update
  - no new runtime dependencies

## Acceptance Criteria

The implementation is acceptable only if all of the following are true:

1. `PushFrame` accepts both `msg.new` and `job.update`, and both round-trip through JSON
   without shape loss.
2. `job.watch` succeeds over real IPC and returns `{ watching: true }`.
3. A new job produces `job.update: running` once, and later transitions emit exactly one
   push each for `done`, `failed`, and `interrupted`.
4. Subscriptions observe events only after they are established; pre-subscription
   transitions do not backfill through `job.watch`.
5. `/api/jobs/stream` fans out `job.update` to all connected clients.
6. `/api/jobs/:id/stream` continues to carry only `msg.new`.
7. WebSocket upgrades enforce auth and Origin checks with the expected `401` / `403`
   rejection behavior.
8. The client no longer relies on a 2-second polling loop for live updates, but still has
   a slower fallback poll for recovery.
9. The implementation does not touch the Phase 4 Web Push files or add runtime
   dependencies.

## Verification Matrix

### 1. Protocol

Verify:

- `PushFrame` can represent both push events
- `job.watch` request encoding/decoding matches the design
- JSON serialization preserves `event`, `job_id`, `status`, and `updated_at`

How:

- construct frames directly in tests
- serialize and deserialize them
- assert both the new and existing push variants still work

### 2. Daemon IPC

Verify:

- real daemon startup exposes `job.watch`
- `job.create` emits `running`
- lifecycle transitions emit exactly once
- ordering is `running` before terminal outcomes
- no pre-subscription backfill occurs

How:

- use the real daemon with a temp socket
- connect a real IPC client
- subscribe before and after job transitions to verify delivery boundaries
- drive terminal transitions through the real job lifecycle

### 3. Gateway WebSocket

Verify:

- `/api/jobs/stream` receives and fans out `job.update`
- multiple clients receive the same update
- `/api/jobs/:id/stream` remains limited to `msg.new`
- auth and Origin rejection paths are enforced

How:

- start the real daemon and gateway
- open real WebSocket clients
- verify the global stream and per-job stream independently
- repeat upgrade attempts without auth and with a bad Origin

### 4. Client polling behavior

Verify:

- the 2-second live polling loop is removed
- the global stream triggers debounced refreshes
- a slower fallback poll still exists

How:

- inspect the client flow through tests and/or targeted assertions
- confirm the update path is stream-driven rather than primary-poll driven
- confirm the fallback interval remains in the `30-60s` range

### 5. Regression boundaries

Verify:

- no changes to `agvsr watch` / `agvsr wait`
- no Phase 4 Web Push file changes
- no README update
- no new runtime dependencies

How:

- review the touched file set and the diff scope
- fail the plan if unrelated web push or CLI behavior is modified

## Required Verification Commands

Run these before handoff:

```sh
bun test
bun run typecheck
bunx oxlint src test
bunx oxfmt src
```

If the repository-standard formatter entry point changes later, use the project script
equivalent instead of a raw `bunx oxfmt` invocation.

