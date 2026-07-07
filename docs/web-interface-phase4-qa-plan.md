# QA Test Plan: `docs/design-web-interface.md` Phase 4 Push Notifications

## Goal

Verify the approved Phase 4 push-notification scope in `docs/design-web-interface.md` under
`## 12. Phase 4 実装設計: プッシュ通知 (Service Worker + VAPID + subscription 永続化 + lifecycle トリガ)`.

This phase adds Web Push support on top of the existing Phase 1/2/3 web stack. The
implementation is acceptable only if it persists VAPID/subscription data correctly,
exposes the documented push API endpoints with the required security checks, wires daemon
hook events through injected `pushNotifier`, and passes the real crypto smoke coverage
described in section 12.6.

## Scope

### In scope

- `WebAuthStore` migration/table behavior for:
  - `web_vapid_keys`
  - `web_push_subscriptions`
- Push API endpoints:
  - `GET /sw.js`
  - `GET /api/push/config`
  - `POST /api/push/subscribe`
  - `POST /api/push/unsubscribe`
- Session, Origin, CSRF, and payload validation checks on push mutation routes
- Confirming push mutations do **not** create `web_operation_audit` side effects
- Daemon hook wiring through injected `pushNotifier` for:
  - `done`
  - `failed`
  - `interrupted`
  - `stalled`
  - `attention`
- Real crypto smoke coverage from section 12.6:
  - real VAPID key generation
  - fake browser subscription generation
  - encrypt/decrypt round trip without mocked crypto
  - `Bun.serve` fake push endpoint validation
  - `404`/`410` pruning behavior
- Client and service-worker behavior at review level:
  - service-worker registration flow
  - subscribe/unsubscribe toggle flow
  - no `innerHTML`
  - no inline scripts/styles
  - CSP includes `worker-src`

### Out of scope

- Implementing or fixing the feature
- Phase 5 `job.update` lifecycle push
- README or docs updates outside this handoff
- New runtime dependencies
- Redesigning section 12

## Harness Requirements

Use the same real integration style as the existing web tests:

- create isolated temp directories per case
- use real `startDaemon` + `startWebGateway` where HTTP behavior is under test
- authenticate through the existing session flow
- preserve and restore env vars in `try/finally`
- avoid mocking the core crypto path for the smoke test
- keep all verification self-contained in `bun test`

## Acceptance Criteria

The implementation is acceptable only if all of the following hold:

1. `web_vapid_keys` and `web_push_subscriptions` are created idempotently and persist across
   process restarts using the same store file.
2. VAPID public key material is exposed only through `GET /api/push/config`; private key
   material never leaves the store.
3. `GET /sw.js` serves the service worker with the expected headers and route scope
   behavior.
4. `POST /api/push/subscribe` and `POST /api/push/unsubscribe` require session auth,
   Origin validation, and CSRF validation.
5. Push mutation validation rejects malformed JSON, non-HTTPS endpoints, missing required
   fields, and overlong payload fields with `400`.
6. Successful subscribe/unsubscribe operations update the subscription table correctly.
7. Push mutation routes do not write to `web_operation_audit`.
8. `pushNotifier` receives the correct `{ job_id, status }` payloads for the approved hook
   events, including `failed` vs `interrupted` resolution from `store.getJob(job_id)`.
9. The real crypto smoke test proves the payload can be encrypted and decrypted with the
   approved Web Push flow and that a fake push endpoint sees the correct headers.
10. 404/410 push responses cause subscription pruning.
11. The client/SW code paths remain review-safe with no `innerHTML`, no inline
   scripts/styles, and CSP `worker-src` coverage.
12. The required verification commands pass before handoff.

## Verification Matrix

### 1. Store migration and table behavior

What to verify:

- the two push tables are present after schema initialization
- creating VAPID keys is lazy and stable across repeated reads
- public key retrieval returns the same stored value
- subscriptions are stored by endpoint and can be listed/removed
- re-running initialization does not duplicate or corrupt rows

How to check:

- use a temp store file and inspect the tables directly
- create keys once, restart the store handle, then confirm the same key pair is reused
- add a subscription, list it, then remove it and confirm it disappears

Acceptance criteria:

- the store schema and helpers behave as a durable migration, not an ephemeral cache

### 2. Push API security and validation

What to verify:

- `GET /sw.js` returns the expected service-worker asset
- `GET /api/push/config` requires session auth and returns only public configuration
- `POST /api/push/subscribe` and `POST /api/push/unsubscribe` enforce:
  - valid session cookie
  - allowed Origin
  - CSRF token match
  - strict JSON validation
  - HTTPS endpoint requirement for subscriptions
  - bounded field lengths
- successful mutation paths persist or remove the subscription row as expected
- no push mutation path writes a `web_operation_audit` row

How to check:

- drive the endpoints over a real gateway
- repeat each unsafe request with missing session, invalid Origin, and invalid CSRF
- inspect the SQLite store after each case

Acceptance criteria:

- the status-code matrix matches section 12
- push settings changes are isolated from job mutation audit logging

### 3. Daemon hook wiring

What to verify:

- `pushNotifier` is injected through daemon startup, not imported from web code
- `done` maps to `done`
- `stalled` maps to `stalled`
- supervisor-to-user messages map to `attention`
- failed job hooks resolve `failed` vs `interrupted` from `store.getJob(job_id).status`
- the notifier is fire-and-forget and does not block daemon flow

How to check:

- inject a spy notifier into the daemon startup path
- trigger the relevant job lifecycle transitions and supervisor-message cases
- assert the emitted payloads and their statuses

Acceptance criteria:

- the notifier receives the exact approved payloads for the approved hook points

### 4. Real crypto smoke test

What to verify:

- VAPID key generation uses the real code path
- subscription key material is generated for a fake browser client
- payload encryption and decryption round-trip without mocked crypto
- `Bun.serve` fake push endpoint sees:
  - `Content-Encoding: aes128gcm`
  - VAPID `Authorization` header
  - a payload body that decrypts to the expected `{ job_id, status }`
- `404` and `410` responses prune dead subscriptions

How to check:

- generate a real VAPID key pair from the store helpers
- create a fake subscriber key pair and auth secret
- encrypt a payload, decrypt it with the subscriber private key, and compare the plaintext
- stand up a local push endpoint with `Bun.serve` and assert the wire headers/body
- return `404` and `410` from the fake endpoint and confirm cleanup

Acceptance criteria:

- the crypto path is validated end to end without mocking the mechanism under test

### 5. Client and service-worker review checks

What to verify:

- service-worker registration is present and follows the approved flow
- subscribe/unsubscribe toggle behavior is wired to the documented endpoints
- UI rendering uses DOM/text APIs rather than `innerHTML`
- no inline scripts or inline styles are introduced
- CSP includes `worker-src`

How to check:

- review the changed client and security files directly
- confirm the flow is capability-gated and degrades cleanly when push is unavailable

Acceptance criteria:

- the review surface matches the approved design and does not introduce unsafe rendering

## Required Verification Commands

Run these before handoff:

```sh
bun test
bun run typecheck
bunx oxlint src test
bunx oxfmt src
```

If the formatter is available only as a project script in the eventual implementation
branch, use that project-specific entry point instead; for this handoff, the workspace
baseline is `bunx oxfmt src`.

## Residual Risks and Manual Checks

- Real browser notification display and click-through behavior still need at least one
  manual smoke in a secure context (`http://localhost` or HTTPS).
- Push delivery depends on browser/platform support for Service Worker and PushManager.
- `on_supervisor_message` can be noisy by design; if later implementation narrows it to
  escalation-only notifications, this plan should be updated to match the approved design.
- The crypto smoke test validates the wire format and decryptability, but not a real
  external push vendor.

