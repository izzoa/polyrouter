## 1. E14.1 — Test the SMTP connect-time SSRF refusal + IP pinning

- [x] 1.1 Add `notifications/delivery/smtp.adapter.spec.ts`: mock `nodemailer` and `node:dns/promises`; assert `deliverSmtp` with host `169.254.169.254` (literal) rejects `smtp_host_blocked` with `createTransport` NOT called (no socket), in both `selfhosted` and `cloud`.
- [x] 1.2 Add the pinning case: a hostname resolving (mocked) to `127.0.0.1` → `createTransport` is called with `host === '127.0.0.1'` (resolved IP, not the hostname) and `tls.servername === '<hostname>'`. (Removing the SSRF assertion or the pinning fails these.)

## 2. E14.2 — Rate-limit the per-channel test-send

- [x] 2.1 In `auth/rate-limit.ts`, add an optional `keyspace` to `RateRule` (default `'auth'`) and build the key as `rl:${keyspace}:${prefix}:${identity}` so existing auth keys are unchanged.
- [x] 2.2 In `notifications/channels.service.ts`, inject `REDIS_CLIENT`, build an `AuthRateLimiter`, and at the **top** of `testSend` (before the row fetch / any delivery) check a per-user rule (`{prefix:'test-send', max:5, windowSec:60, keyspace:'notify'}`, keyed by the caller's user id); on exceed throw `HttpException(429)` with `retryAfterSec`.
- [x] 2.3 `rate-limit.spec.ts`: assert the key namespacing (`rl:auth:…` default vs `rl:notify:test-send:<userId>`) and that a per-user notify rule 429s past its max.
- [x] 2.4 Notifications e2e: a fresh user's first 5 test-sends succeed; the 6th within the window throws 429 with **no** SMTP session; a different user is independent (own window).

## 3. Verification & wrap-up

- [x] 3.1 `npm run build && npm run lint && npm run typecheck` clean.
- [x] 3.2 `npm test -w packages/control-plane` green; `npm run test:e2e -w packages/control-plane` (notifications + auth suites) green.
- [x] 3.3 Changeset (user-facing: test-send throttling).
- [x] 3.4 Update `TODOS.md` board + mark E14 ✅ in `FABLE_AUDIT.md` after archive.
