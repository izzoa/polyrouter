## Why

The notification surface is strong, but two gaps remain (FABLE_AUDIT E14):

- **A spec-mandated SSRF behavior is untested.** The spec requires the SMTP host validated **at connect
  time** in the adapter, connecting to the pinned validated IP so a DNS rebind can't redirect the
  socket. It is implemented, but **no test executes it** — `system-mailer.spec.ts` mocks the adapter and
  the channels e2e uses a reachable loopback. A refactor dropping `assertNetworkHostSafe` or the IP
  pinning stays green while a cloud tenant could rebind DNS to `169.254.169.254`.
- **The per-channel test-send endpoint is unthrottled.** `POST /:id/test` is session-guarded and
  tenant-scoped but has no rate limit (`AuthRateLimitMiddleware` only matches Better Auth routes). Each
  call drives a real SMTP session or Apprise POST (15s timeout) + live DNS, so an authenticated user (or
  a stolen session) can loop it to spam arbitrary recipients through the configured SMTP, hammer the
  Apprise sidecar, or tie up connections.

## What Changes

- **E14.1** Add `smtp.adapter.spec.ts` that locks the connect-time SSRF contract: `deliverSmtp` with a
  host resolving to a metadata/link-local address (`169.254.169.254`, literal — no DNS) is refused with
  a sanitized `smtp_host_blocked` **before any socket is opened**, in both modes; and a safe host
  connects to the **resolved IP** (not the hostname) with the cert validated against the original host
  (SNI). Removing the SSRF assertion or the IP pinning fails the test. (Test-only — no production code
  change.)
- **E14.2** Rate-limit `test-send` per user by reusing the existing Redis fixed-window limiter
  (`auth/rate-limit.ts`), keyed on the caller's user id in a dedicated `notify` keyspace (a few
  sends/minute). Over the threshold returns **429** *before* any DNS/SMTP/Apprise work. The limiter
  gains an optional `keyspace` so it can guard a non-auth surface without colliding with the auth keys.

## Capabilities

### Modified Capabilities

- `notification-channels`: the SMTP adapter's connect-time SSRF refusal + IP pinning is locked by a test
  (a blocked host opens no socket; a safe host is pinned to its resolved IP with SNI preserved); the
  per-channel test-send is rate-limited per user (429 past a small per-minute threshold), before any
  network work.

## Impact

- **Code:** `auth/rate-limit.ts` (optional `keyspace` on `RateRule`, default `auth` — no auth key
  change), `notifications/channels.service.ts` (a per-user test-send throttle before delivery, 429 on
  exceed). No schema change, no migration.
- **Tests:** `smtp.adapter.spec.ts` (connect-time refusal both modes + IP pinning via a dns/nodemailer
  mock); `rate-limit.spec.ts` (keyspace namespacing + a per-user notify rule 429s past max); a
  notifications e2e loop asserting the 6th test-send in a window is a 429 with no SMTP session, and a
  different user is independent. Changeset: user-facing (test-send throttling).
- Backlog A-32 (weekly-summary single-attempt), A-33 (validate `APPRISE_API_URL` at boot — already
  covered by the existing boot gate), A-34 (channel update clears `lastTestStatus`) are out of scope.
