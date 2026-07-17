## 1. A-40 — Pin the GCM auth tag to 16 bytes

- [x] 1.1 In `encryption.ts` `decryptSecret`, reject a decoded auth tag whose length is not 16 (inside the try, so the fixed "decryption failed" message surfaces).
- [x] 1.2 Test: a truncated (8-byte) tag rejects with `/decryption failed/`.

## 2. A-41 — Full-range allowlist validation on both paths

- [x] 2.1 In `ssrf.ts`, check BOTH the network and broadcast of an allowlist CIDR for either family (BigInt `cidrRange`) — reject a soft-network CIDR whose range spans a hard/public block (v4 `10.0.0.0/7`; v6 `fc00::/6`); throw `SsrfError` (so SMTP maps it to `smtp_host_blocked`, not `smtp_unresolvable`); export it.
- [x] 2.4 In `redis.module.ts`, extract `installRedisErrorLog` and unit-test latch/ready-reset/message-redaction.
- [x] 2.2 In `network-host.ts`, call `assertEndpointsSafe` at the top of `assertNetworkHostSafe` (notification path parity).
- [x] 2.3 Tests: `10.0.0.0/1` (spans loopback) rejects on the URL path; a hard-overlapping allowlist entry rejects on the notification path.

## 3. A-43 — Redis error listener

- [x] 3.1 In `redis.module.ts`, attach a latched (once-per-outage, reset on `ready`) `error` listener that logs ONLY the error code/class (never `err.message`); never the URL/credentials.

## 4. Wrap-up

- [x] 4.1 build/lint/typecheck green; `npm test -w packages/shared` + control-plane green.
- [x] 4.2 Update `TODOS.md` + mark A-40/A-41/A-43 ✅ in `FABLE_AUDIT.md` after archive.
