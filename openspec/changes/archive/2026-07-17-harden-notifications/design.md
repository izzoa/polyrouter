## Context

Two independent hardening items on the notification surface: one closes a **test gap** for an
already-implemented SSRF behavior (so a refactor can't silently regress it), the other closes an
**abuse vector** on the test-send route. Both are small and localized.

## Decisions

### D1 — Lock the SMTP connect-time SSRF via a dns + nodemailer mock (E14.1)

`deliverSmtp` calls `assertNetworkHostSafe(host, port, …)` and, on success, builds the transport with
`host: <validated ip>` and `tls: { servername: <original host> }`. Two assertions lock this:

- **Blocked, no socket:** call with `169.254.169.254` (a literal link-local/metadata IP — no DNS
  needed; a hard block in *every* mode since it isn't loopback). The adapter must reject with the
  sanitized `smtp_host_blocked` **before** `createTransport` is called. Mocking `nodemailer` and
  asserting `createTransport` was never invoked proves no socket was opened. Run in both `selfhosted`
  and `cloud` (loopback is the only self-host exception, and this isn't loopback).
- **Pinned IP + SNI:** mock `node:dns/promises` `lookup` so a hostname resolves to `127.0.0.1`, then
  assert `createTransport` is called with `host === '127.0.0.1'` (the resolved IP, **not** the
  hostname) and `tls.servername === '<hostname>'`. With host ≠ ip, a refactor that passed `config.host`
  (dropping the pin) fails this assertion. `assertNetworkHostSafe` exposes a `resolve` seam, but
  `deliverSmtp` doesn't forward it, so mocking the `node:dns/promises` builtin (which the shared guard
  imports) is the non-invasive way to drive resolution — verified to intercept across the package
  boundary. No production change.

### D2 — Reuse the auth window limiter with a `keyspace`, throttle before delivery (E14.2)

The existing `AuthRateLimiter` is an atomic Redis fixed-window (INCR + first-hit EXPIRE, per-instance
fallback on Redis outage) — exactly what's wanted, and already correct across instances. Rather than a
second limiter, `RateRule` gains an optional `keyspace` (default `'auth'`, so existing auth keys are
byte-identical — no counter reset on deploy). `check(identity, rule, now)` already takes the identity
as its first arg (a client IP for auth); for test-send it is the caller's **user id**, so one bucket
covers all of a user's channels (a loop across many channels can't evade it). The rule is
`{ prefix:'test-send', max:5, windowSec:60, keyspace:'notify' }` → key `rl:notify:test-send:<userId>`.

The check runs at the **top of `testSend`**, before the row fetch and before any DNS/SMTP/Apprise, so a
throttled call does zero network work; over the limit it throws a NestJS `HttpException(429)` carrying
`retryAfterSec`. `ChannelsService` injects `REDIS_CLIENT` (the module already imports `RedisModule`) and
builds its own limiter instance (stateless but for the per-instance fallback map, which is per-process
anyway); the Redis-degradation callback logs a class-only warning **latched to once per process** (like
`AuthRateLimitMiddleware`), so a Redis outage under a test-send flood cannot amplify into per-request
log spam — the limiter keeps enforcing via its per-instance fallback either way.

## Risks / Trade-offs

- **Throttle-before-404:** the rate check precedes the ownership/existence check, so hammering a
  non-existent id also counts toward the window and can 429 before 404. That is standard for a resource
  guard (do no work first) and the limit is per-user, so it can't be used to probe another tenant's ids.
- **`max:5/min`** is a UI "send test" button, generous for humans and hostile to a script. It is a
  constant, not a knob (a per-deploy tunable is deferred — the auth limits are constants too).
- **dns builtin mock** is broad for the test file, but scoped to `smtp.adapter.spec.ts`; it echoes
  literal IPs so only the one test hostname is remapped.

## Migration Plan

None — no schema or persisted-state change. The `keyspace` default keeps auth rate-limit keys stable.

## Open Questions

- Should a stricter per-channel (not just per-user) sub-limit also apply? Per-user already bounds the
  abuse; a per-channel `markOnce` is deferred as redundant.
