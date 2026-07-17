---
'@polyrouter/control-plane': patch
---

Harden the notification surface (FABLE_AUDIT epic E14):

- **The per-channel test-send is now rate-limited per user.** `POST /api/notification-channels/:id/test` was session-guarded and tenant-scoped but unthrottled, and each call drives a real SMTP session or Apprise POST (15s) + live DNS — so an authenticated or stolen session could loop it to spam recipients through the configured SMTP, hammer the Apprise sidecar, or tie up connections. It now uses the shared atomic Redis fixed-window limiter keyed per user (a few sends/minute across all of a user's channels), checked **before** any DNS/SMTP/Apprise work; over the threshold it returns **429** with no delivery. The limiter's `RateRule` gained an optional `keyspace` (default `auth`, so existing auth rate-limit keys are unchanged), and its Redis-degradation warning is latched to once per process so an outage can't amplify into per-request log spam.
- **The SMTP adapter's connect-time SSRF refusal + IP pinning is now covered by a regression test.** The spec requires the SMTP host validated at connect time (connecting to the pinned validated IP so a DNS rebind can't redirect the socket, with the cert checked against the original host), but no test executed it — a refactor dropping the check or the pin could regress silently. A new `smtp.adapter.spec.ts` asserts a metadata/link-local host is refused (`smtp_host_blocked`, no socket opened) in both modes, and that a safe host connects to the resolved IP with SNI preserved. Test-only — no runtime change to delivery.
