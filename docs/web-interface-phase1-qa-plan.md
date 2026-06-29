# QA Test Plan: `docs/design-web-interface.md` Phase 1

## Goal

Verify the approved Phase 1 web gateway scope in `docs/design-web-interface.md`:

- `agvsr web` runs as a separate Bun.serve gateway process.
- The gateway uses the existing daemon IPC `Client` from `src/ipc/transport.ts`.
- Phase 1 is read-only monitoring plus the mandatory security foundation.
- The only allowed API surface in this phase is auth/session plus:
  - `GET /api/session`
  - `GET /api/jobs`
  - `GET /api/jobs/:id`
- No WebSocket/live stream.
- No operation APIs beyond auth/session.
- No notifications.
- The dependency-free TS SPA shell under `src/web/client/*` is acceptable for Phase 1.

This plan is the acceptance gate for the implementation that will later create:

- `src/cli/agvsr.ts`
- `src/web/server.ts`
- `src/web/routes.ts`
- `src/web/ipc.ts`
- `src/web/auth.ts`
- `src/web/security.ts`
- `src/web/auth-store.ts`
- `src/web/client/*`

## Scope

### In scope

- CLI wiring for `agvsr web`
- server startup and shutdown behavior
- IPC bridging from the web gateway to the real daemon over the existing transport
- login/logout and session validation
- generated startup token behavior
- dedicated SQLite `web_*` tables for hashed token/session/security state
- `HttpOnly`, `Secure`, `SameSite=Strict` session cookies
- Host and Origin allowlists
- CSRF protection on login/logout and any future unsafe routes
- CSP and other security headers
- escaped audit/message rendering
- read-only job/session APIs and SPA polling
- UDS bind `0600` first, TCP loopback fallback
- repository verification commands:
  - `bun test`
  - `bun run typecheck`
  - `bunx oxlint src test`
  - `bunx oxfmt src test`

### Out of scope

- WebSocket/live message streaming
- push notifications or service worker code
- job creation, stop, kill, tell, or any other operation endpoint
- phase 2-4 behavior from the design
- new IPC protocol methods
- heavy runtime dependencies or a rewritten frontend stack
- implementation details beyond what is observable from behavior

## Acceptance Criteria

The implementation is acceptable only if all of the following are true:

1. `agvsr web` starts a separate web gateway process and does not require the daemon process to be rewritten.
2. The gateway talks to the real daemon through the existing IPC `Client`, not a parallel data path.
3. Startup prints a token once, and the token is stored only as a hash in dedicated `web_*` SQLite tables.
4. Login creates a session cookie with `HttpOnly`, `Secure`, and `SameSite=Strict`.
5. Requests with an unapproved `Host` or `Origin` are rejected.
6. Login/logout and any future unsafe route are CSRF protected.
7. Response headers include the expected CSP and related security headers, and no permissive CORS is exposed.
8. Audit and message content are escaped before rendering.
9. `GET /api/session`, `GET /api/jobs`, and `GET /api/jobs/:id` work against live daemon state and remain read-only.
10. The implementation does not add WebSocket/live, notification, or mutation endpoints in Phase 1.
11. The SPA polls every 2 seconds and does not depend on the phase-2/3/4 features.
12. The repository command set stays green:
    - `bun test`
    - `bun run typecheck`
    - `bunx oxlint src test`
    - `bunx oxfmt src test`

## Verification Matrix

### 1. CLI bootstrap and process model

What to verify:

- `agvsr web` is a separate subcommand in `src/cli/agvsr.ts`.
- the web server starts as a gateway process, not as a daemon replacement.
- startup path prefers a Unix domain socket bind with mode `0600`.
- TCP fallback, when exercised, is loopback-only.
- startup fails clearly if the daemon is unavailable.

How to check:

- add a focused CLI test for `agvsr web --help` or equivalent usage text if the command is user-facing.
- add a process test that starts the gateway against a real daemon socket and verifies the command exits only when told to stop.
- verify the bind mode on the UDS path where the platform exposes it.
- verify the TCP fallback binds only to `127.0.0.1` or `::1`, never to a public interface.

Acceptance criteria:

- the gateway is a standalone process
- the bind choice is secure by default
- the daemon dependency is explicit and observable

### 2. Startup token and auth store

What to verify:

- the startup token is generated at process start and printed once
- the token itself is not persisted in plaintext
- only a hash is stored in dedicated `web_*` tables
- session state is also persisted in the dedicated `web_*` tables

How to check:

- add an automated test that captures gateway stdout/stderr during boot and asserts one token emission
- inspect the SQLite file directly after startup and confirm the token is not present in plaintext
- verify the expected `web_*` table names exist and are used for token/session state
- verify a restart invalidates the startup token unless the implementation explicitly documents a retained bootstrap token

Acceptance criteria:

- secrets are not stored in plaintext
- the token is visible once to the operator and only as a hash afterward
- the dedicated tables exist and isolate web secrets from daemon state

### 3. Login, cookie flags, and CSRF

What to verify:

- successful login sets an auth cookie with `HttpOnly`, `Secure`, and `SameSite=Strict`
- logout clears the session and is CSRF protected
- login is also CSRF protected if the design requires a state-changing POST
- rejected auth requests do not mint a valid session

How to check:

- add route-level tests against the real server and real storage
- assert the `Set-Cookie` header contains the required flags
- assert missing or wrong CSRF tokens are rejected
- assert replaying an old token or cookie fails after logout

Acceptance criteria:

- cookie handling matches the approved security baseline
- state changes are not reachable without the expected anti-CSRF checks

### 4. Host, Origin, and CORS enforcement

What to verify:

- only allowlisted `Host` values are accepted
- only allowlisted `Origin` values are accepted for browser requests
- there is no permissive wildcard CORS policy
- same-origin browser requests succeed when the origin matches the configured allowlist

How to check:

- add request tests that send good and bad `Host` headers to the same endpoint
- add request tests with allowed and disallowed `Origin` headers
- assert rejected responses do not disclose privileged data
- assert the server does not emit `Access-Control-Allow-Origin: *`

Acceptance criteria:

- DNS rebinding and browser-driven CSRF paths are blocked at the edge
- CORS stays explicit and narrow

### 5. Read-only APIs

What to verify:

- `GET /api/session` returns the current auth/session state
- `GET /api/jobs` uses daemon `job.list` plus `job.get` fan-out for runtime
- `GET /api/jobs/:id` uses daemon `job.get` and `msg.list`
- `GET /api/jobs/:id` does not mark messages read
- the endpoints are read-only and do not mutate daemon state

How to check:

- use a real daemon with a controlled store so the job list and job details are deterministic
- assert the `/api/jobs` response reflects runtime data, not just stored job rows
- assert repeated `GET /api/jobs/:id` calls do not change read markers
- assert the web route layer rejects mutation verbs or missing routes for non-approved actions

Acceptance criteria:

- the read-only API surface matches the Phase 1 design
- `msg.list` remains observational only
- no read-side effect leaks into the daemon

### 6. Escaped rendering and CSP

What to verify:

- audit/message text is escaped before reaching HTML
- the SPA shell does not render raw HTML from job logs
- CSP is present and blocks inline/script injection patterns that the design forbids
- other security headers are present as required by the implementation

How to check:

- create a job/message payload that includes HTML, script tags, and attribute-breaking input
- fetch the HTML shell and any rendered job detail fragment and assert the payload is escaped, not executed or interpolated
- assert the CSP header is present and does not permit permissive script execution
- assert no permissive CORS response is emitted as a side channel

Acceptance criteria:

- hostile output is displayed as text
- XSS primitives do not survive the render path
- browser policy headers are active

### 7. SPA polling behavior

What to verify:

- the dependency-free TS SPA shell polls every 2 seconds
- the polling targets the read-only endpoints only
- the UI does not assume WebSocket/live behavior

How to check:

- add a client-side test for the polling interval or scheduler logic in `src/web/client/*`
- verify the shell refreshes from `/api/jobs` and `/api/jobs/:id` rather than subscribing to live channels
- verify no phase-2 live transport code is needed for the Phase 1 shell to operate

Acceptance criteria:

- the UI is compatible with Phase 1 only
- the polling cadence matches the approved design

### 8. Absence of phase 2-4 behavior

What to verify:

- no WebSocket/live channel exists in Phase 1
- no job mutation operations are exposed through the web gateway
- no notifications or service worker assets are present for this phase
- no read-only endpoint accidentally gains future-phase side effects

How to check:

- add route-level tests that confirm the phase-1 server returns 404/405 for websocket or operation paths, as appropriate for the chosen implementation
- assert there is no endpoint that marks a job read, sends a message, stops a job, kills a job, creates a job, or registers push notifications
- assert the client bundle does not include notification registration or live-update logic

Acceptance criteria:

- phase-2, phase-3, and phase-4 behavior is absent by design
- the phase-1 gateway cannot be mistaken for a more capable release

### 9. Real-start smoke coverage

What to verify:

- the daemon is running for real
- the web gateway is running for real
- the browser-facing HTTP path is exercised end to end
- login, session establishment, and read-only data fetch work together
- the security headers and cookies are visible on real responses

How to check:

- start a real daemon on a temporary IPC socket and temporary SQLite store
- start a real `agvsr web` process against that daemon
- capture the printed startup token from the real web process
- perform a real HTTP login request with the startup token
- read the returned cookie and confirm its flags
- fetch `/api/session`
- fetch `/api/jobs`
- fetch `/api/jobs/:id`
- verify the response contains actual daemon data
- verify escaped rendering and security headers on the returned responses
- stop the web process and daemon cleanly at the end of the smoke

Acceptance criteria:

- the web gateway works against the actual daemon and store
- the smoke covers the true IPC/auth/security path
- the smoke is not satisfied by stubs that bypass the core behavior

## Candidate Automated Tests

### `test/web-cli.test.ts` or a similarly named CLI test file

Add coverage for:

- `agvsr web` boot behavior
- token printing on startup
- bind selection and fallback rules
- shutdown path

### `test/web-auth.test.ts`

Add coverage for:

- startup token validation
- token hashing only
- login/logout CSRF enforcement
- session cookie flags
- session invalidation behavior

### `test/web-routes.test.ts`

Add coverage for:

- `GET /api/session`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- Host and Origin checks
- CSP and security header presence
- escaping of hostile message content
- rejection of unsupported Phase 2-4 endpoints

### `test/web-smoke.test.ts`

Add one real-process smoke that uses:

- a real daemon process
- a real web gateway process
- a real HTTP client
- a real temporary SQLite store

The smoke must validate the full login and read-only fetch path.

### `src/web/client/*` tests

Add focused tests for:

- polling cadence
- route-to-data refresh logic
- safe text rendering of hostile content
- avoidance of phase-2 live or notification assumptions

## Required Commands

Run these repository checks as part of the acceptance gate:

1. `bun test`
2. `bun run typecheck`
3. `bunx oxlint src test`
4. `bunx oxfmt src test`

The change is not acceptable if targeted tests pass but any of these commands fail.

## Manual / Smoke Checklist

Use manual inspection only if the automated smoke needs confirmation of process behavior:

1. Start the daemon on a temporary IPC endpoint.
2. Start `agvsr web` against that daemon.
3. Confirm the startup token is printed once.
4. Confirm login succeeds only with the token and that the cookie has the required flags.
5. Confirm `GET /api/session`, `GET /api/jobs`, and `GET /api/jobs/:id` return data from the live daemon.
6. Confirm bad `Host` and `Origin` values are rejected.
7. Confirm the rendered job content escapes hostile markup.
8. Confirm there is no WebSocket/live, notification, or mutation surface in Phase 1.

## Regression Risks

### Highest risk

- security regressions in token handling, cookie flags, Host/Origin checks, or CSRF
- accidental exposure of mutation endpoints through the web gateway
- use of a mock path that does not exercise the real IPC/auth/security boundary

### Medium risk

- startup token storage leaks plaintext secrets into the store
- CSP or escaping is incomplete and allows hostile audit content to execute
- read-only job detail fetch incorrectly marks messages read

### Lower risk

- SPA polling cadence drifts from the approved 2-second interval
- the TCP fallback is too permissive on the bind address
- CLI wording or help text is stale

## Review Outcome

The work is acceptable only if:

- the gateway is a real standalone process
- the daemon bridge is real
- the security baseline is enforced end to end
- the APIs stay read-only
- phase 2-4 behavior is absent
- the required repository commands remain green
