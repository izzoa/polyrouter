---
'@polyrouter/control-plane': patch
---

Harden the auth plane: IPv6-aware rate-limit bucketing, strict trusted-proxy CIDR validation, and a case-insensitive plane boundary (FABLE_AUDIT E9).

**IPv6-aware client IP (E9.1).** `ipInCidr` was IPv4-only, so behind an IPv6-connecting proxy `X-Forwarded-For` was discarded and every client collapsed into one rate-limit bucket — 10 sign-in attempts/min then locked out *everyone* (an auth-plane DoS) and per-client brute-force isolation was lost. CIDR matching is now family-aware (IPv4, IPv6, IPv4-mapped) via Node's `net.BlockList`, and `TRUSTED_PROXY_CIDRS` entries are strictly validated at boot through a shared parser — a malformed prefix (e.g. `10.0.0.0/`) now fails boot instead of being coerced to `/0` (which would have trusted every peer and let a direct client spoof `X-Forwarded-For`).

**Case-insensitive, segment-safe plane boundary (E9.2).** The session guard scoped `/api` with a case-sensitive `startsWith`, but Express routes case-insensitively, so `GET /API/agents` matched the controller yet skipped the guard (and in production the SPA fallback would have served it the shell before Nest). Every plane-scoping decision — the session guard, the SPA fallback reservation, the Better-Auth `/api/auth` interception, the `/v1` error envelope + protocol-shape detection, the auth rate limiter, and the trace label — now compares the path case-insensitively and segment-safely (so `/apiary` no longer folds into the `/api` plane). An upper-case `/API/...` path is guarded and throttled exactly like its lowercase form.

No schema migration; no behavior change for lowercase paths or a valid existing `TRUSTED_PROXY_CIDRS`.
