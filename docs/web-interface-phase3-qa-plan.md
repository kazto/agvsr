# QA Test Plan: `docs/design-web-interface.md` Phase 3

## Goal

Verify the approved Phase 3 web operations scope in `docs/design-web-interface.md` under
`## 11. Phase 3 実装設計: 操作 API + CSRF + Web 操作監査ログ`.

This phase adds only browser-facing mutation endpoints and their security/audit handling:

- `POST /api/jobs`
- `POST /api/jobs/:id/tell`
- `POST /api/jobs/:id/stop`
- `POST /api/jobs/:id/kill`

The implementation is acceptable only if it works against a real daemon and real web gateway
over HTTP, enforces the CSRF/session rules from the design, records sanitized audit rows, and
does not regress the existing read-only and websocket behavior.

## Scope

### In scope

- real integration coverage with `startDaemon` + `startWebGateway` + HTTP fetch
- auth/CSRF behavior for mutation routes
- read-only routes remain unchanged
- audit-log persistence and sanitization
- timeout handling and temp workspace isolation
- regression coverage for the existing web test surface:
  - `test/web-auth.test.ts`
  - `test/web-api.test.ts`
  - `test/web-security.test.ts`
  - `test/web-ws.test.ts`

### Out of scope

- implementation changes to daemon protocol
- pushing lifecycle events to clients
- design changes to the UI beyond what the Phase 3 spec already requires
- non-web daemon behavior unrelated to the HTTP gateway

## Harness Requirements

Use the same real integration style already present in the web tests:

- create a per-test temp directory with `mkdtempSync(tmpdir(), "agvsr-web-ops-")`
- create isolated temp paths for `sock`, `store.sqlite`, `repo`, and fake `bin/claude`
- set and restore all environment variables in `try/finally`:
  - `AGVSR_STORE`
  - `AGVSR_SOCK`
  - `AGVSR_WORKTREES`
  - `PATH`
  - `AGVSR_TURN_TIMEOUT_MS`
  - any fake-claude delay env used by the tests
- start a real daemon with `parseTeam(...)`
- start a real gateway with `startWebGateway({ daemonEndpoint: sock, storeFile: db })`
- authenticate through `/api/session/login` and keep both session and CSRF cookies
- close `web`, `daemon`, IPC clients, and remove only the temp directory created by the test

## Acceptance Criteria

The implementation is acceptable only if all of the following hold:

1. The mutation routes are exercised over the real daemon and gateway, not mocks.
2. Valid session + valid CSRF succeeds on all supported mutation endpoints.
3. Missing session returns `401`.
4. Missing or mismatched CSRF returns `403`.
5. Invalid Origin/Host on unsafe requests remains rejected with `403`.
6. Existing read-only GET routes still work and do not mutate state.
7. Web operation audit rows are written for authenticated mutation attempts and contain only bounded, sanitized metadata.
8. Audit rows include the actor/session hash, target job where applicable, operation, status, and timestamp.
9. Audit rows do not contain raw cookies, CSRF tokens, auth tokens, full bodies, or request headers.
10. The existing `web-auth`, `web-api`, `web-security`, and `web-ws` expectations continue to pass.
11. Test runtime is bounded and does not leak environment or filesystem state across cases.

## Verification Matrix

### 1. Real mutation API integration

What to verify:

- `POST /api/jobs` creates a job through the live gateway and live daemon
- `POST /api/jobs/:id/tell` queues a message through the live daemon
- `POST /api/jobs/:id/stop` stops a running job through the live daemon
- `POST /api/jobs/:id/kill` kills a running job through the live daemon
- each endpoint returns the documented success shape
- the daemon-side effects are real, not stubbed

How to check:

- create a job through HTTP, then confirm the job exists in the list/detail APIs
- tell an active job through HTTP, then confirm the new message appears in daemon-backed views
- stop and kill a running job through HTTP, then poll until the job reaches the expected terminal state
- use the existing fake `claude` runner only as a real integration helper, not as a daemon mock

Acceptance criteria:

- every mutation endpoint works end-to-end over the real stack
- response shapes match the design
- daemon state changes can be observed through live GET endpoints

### 2. Auth and CSRF matrix

What to verify:

- a valid authenticated session with a valid CSRF token succeeds
- missing session returns `401`
- missing CSRF token returns `403`
- mismatched CSRF token returns `403`
- invalid/missing Origin on unsafe requests remains rejected with `403`
- GET/read-only routes remain unaffected by the mutation-only checks

How to check:

- exercise each mutation endpoint with:
  - valid session + valid CSRF
  - valid session + missing CSRF
  - valid session + wrong CSRF
  - missing session
  - bad Origin
- confirm the GET routes still return the same data shape and no side effects
- confirm `GET /api/session`, `GET /api/jobs`, and `GET /api/jobs/:id` still succeed under normal auth

Acceptance criteria:

- the status code matrix matches the design
- read-only requests are not made brittle by the new security checks

### 3. Audit log verification

What to verify:

- each authenticated mutation attempt writes an audit row
- successful and failed attempts are both recorded
- the row includes:
  - sanitized request summary
  - actor/session hash
  - target job id when available
  - operation name
  - status
  - timestamp fields
- the stored summary is bounded and does not contain secrets
- failure cases still record a visible attempt/failure row when a valid session exists

How to check:

- query the web SQLite database directly after each operation
- verify success rows for create/tell/stop/kill
- verify failure rows for local validation and CSRF failures where the session is valid
- inspect the stored summary for:
  - preview truncation
  - length fields
  - no full goal/body leakage
  - no cookie, CSRF token, auth token, or header values
- verify timestamps are populated and ordered as expected

Acceptance criteria:

- audit logging is present for the supported mutation paths
- the table contents prove sanitization, not just row creation

### 4. Regression coverage

What to verify:

- `test/web-auth.test.ts` still passes
- `test/web-api.test.ts` still passes
- `test/web-security.test.ts` still passes
- `test/web-ws.test.ts` still passes
- read-only detail remains observational and does not mark messages read
- websocket auth and stream behavior remain unchanged

How to check:

- run the existing web test files together
- keep the current assertions intact, especially:
  - cookie and CSRF behavior
  - security headers
  - websocket session enforcement
  - non-mutating detail fetches

Acceptance criteria:

- Phase 3 does not break the existing web contract

### 5. Timeout and temp filesystem isolation

What to verify:

- tests do not rely on arbitrary long sleeps
- slow turn completion is handled by bounded polling
- each test uses its own temp directory and socket/store/worktree paths
- `AGVSR_WORKTREES` is isolated per test and restored afterward
- any modified env vars are restored in success and failure paths

How to check:

- use a helper that polls the job state with a fixed deadline instead of long sleeps
- prefer explicit fake-claude delay only where needed for stop/kill races
- assert cleanup works even when a test fails early

Acceptance criteria:

- the suite is stable under repeated runs
- no test leaks environment state into later tests

## Key Scenarios

### POST `/api/jobs`

- success with a real daemon-backed job creation
- invalid JSON returns `400`
- empty `goal` or `cwd` returns `400`
- optional `id` is accepted when valid and ignored fields do not break the request
- authenticated failure is audited

### POST `/api/jobs/:id/tell`

- success returns queued message data from the live daemon
- empty body returns `400`
- malformed or missing route id returns `400`
- authenticated failure is audited

### POST `/api/jobs/:id/stop`

- success transitions a running job to the expected stopped/failed state
- unauthenticated or bad-CSRF requests are rejected before daemon calls
- authenticated failure is audited

### POST `/api/jobs/:id/kill`

- success transitions a running job to the expected interrupted state
- if the job is mid-turn, the test should prove the kill path interrupts the delay rather than waiting for natural completion
- unauthenticated or bad-CSRF requests are rejected before daemon calls
- authenticated failure is audited

## Risks and Gaps the Implementation Must Address

- The audit log must not accidentally store raw request content, cookies, or CSRF values.
- CSRF enforcement must apply consistently across all unsafe mutation routes, not only create.
- Stop/kill tests need a real running job; mocking the daemon would not validate the risk.
- The tests must keep `AGVSR_WORKTREES` isolated so worktree creation does not bleed into the shared environment.
- If audit row writes fail after the daemon call, the implementation needs a defined observable behavior; the plan should verify the intended fallback, not assume success.
- The current read-only and websocket tests should remain green without being loosened to accommodate the new mutation paths.

## Suggested Test Files

- `test/web-api.test.ts`
  - add the real mutation integration coverage and audit assertions
- `test/web-auth.test.ts`
  - extend auth/CSRF matrix coverage where it best fits existing session tests
- `test/web-security.test.ts`
  - add route-edge rejection checks if they are easier to isolate there
- `test/web-ws.test.ts`
  - keep the websocket regression checks intact

## Run Set

Before handoff, run at least:

```sh
bun test test/web-auth.test.ts test/web-api.test.ts test/web-security.test.ts test/web-ws.test.ts
```

If the repository expects broader validation for the web change, also run the standard checks used by the project for this area.
