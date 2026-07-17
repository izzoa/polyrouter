## MODIFIED Requirements

### Requirement: Better Auth session plane guards the management API on its own plane
Better Auth (email/password always; Google/GitHub/Discord OAuth each enabled only when its client id/secret pair is configured) SHALL be mounted at `/api/auth/*`, with passwords hashed by a slow, memory-hard KDF (Better Auth's scrypt — satisfying spec §3.2.3's argon2/bcrypt intent, flagged in design). A `SessionGuard` SHALL protect `/api/**` (except `GET /api/health` and the auth routes), resolving the authenticated user into the request `Principal` (§11.1). Guarding is **plane-scoped**: the session guard applies only to `/api`, the agent-key plane applies to `/v1`, and **neither credential authenticates on the other plane** (invariant 7) — a session cookie is inert on `/v1`, a Bearer agent key is inert on `/api`. Because Express matches controller routes case-insensitively, **every** plane-scoping decision SHALL compare the request path **case-insensitively and segment-safely** (`=== '/api'` or a `'/api/'` prefix, never a bare substring): the session-guard `/api` check, the SPA-fallback plane reservation (so `/API/agents` is not served the SPA shell before the guard), the Better-Auth `/api/auth` interception, the `/v1` body/plane routing and the proxy error-envelope/protocol-shape scoping, and the auth-route rate limiter. An upper- or mixed-case path (e.g. `/API/agents`, `/V1/chat/completions`) is thus scoped exactly like its lowercase form and cannot slip past the guard, the throttle, the SPA reservation, or the interceptor. (Better Auth's own router is case-sensitive on its base path, so an uppercase `/API/auth/*` path is intercepted and throttled but returns Better Auth's own 404 rather than completing — safe, no bypass.)

#### Scenario: Signup and session round-trip
- **WHEN** a user signs up via `/api/auth/sign-up/email` and calls a protected `/api` route with the returned session cookie
- **THEN** the route executes with that user's principal, and the same call without a session returns 401

#### Scenario: Credentials do not cross planes
- **WHEN** a valid session cookie is sent to a `/v1` route, or a valid Bearer agent key is sent to a protected `/api` route
- **THEN** each is rejected on the foreign plane (the session does not authenticate `/v1`, the agent key does not authenticate `/api`)

#### Scenario: Passwords are slow-hashed
- **WHEN** a user's credential row is inspected after signup
- **THEN** the stored password is a salted scrypt hash — not plaintext and not a fast digest

#### Scenario: An upper-case /api path is still guarded and throttled
- **WHEN** `GET /API/agents` is requested without a session, and an uppercase auth route is hit past its limit
- **THEN** the first returns 401 (the session guard scopes it as an `/api` route despite the casing — it is not served the SPA shell and does not 500) and the uppercase auth route is throttled (429) by the limiter, which matched it case-insensitively (it does not bypass the plane)

### Requirement: Auth endpoints are rate limited atomically with a mode-aware failure policy
Sign-up (5/min), sign-in (10/min), and the actual Better Auth 1.6 reset routes **`/request-password-reset` and `/reset-password`** (3/5min) SHALL be rate limited per client IP per route using an **atomic Redis operation** (a Lua script that increments, sets expiry only on first hit, and returns the TTL — so a mid-pair crash cannot leak a non-expiring counter), correct across instances (§3.2); excess requests receive 429 with `Retry-After` and are not forwarded to the auth handler. Client IP SHALL be the raw socket peer; `X-Forwarded-For`'s last hop SHALL be honored only when that immediate peer is within a configured `TRUSTED_PROXY_CIDRS` entry. Client-IP CIDR matching SHALL be **family-aware (IPv4, IPv6, and IPv4-mapped)** so that behind an IPv6-connecting proxy each client is bucketed by its own forwarded address rather than collapsing into one shared bucket (an auth-plane DoS); configured `TRUSTED_PROXY_CIDRS` entries SHALL be **strictly validated at boot** — the prefix length SHALL be a required decimal within the address family's width, so an empty/malformed suffix (e.g. `10.0.0.0/`) is REJECTED at boot rather than silently coerced to `/0` (which would trust every peer and let a direct client spoof `X-Forwarded-For` to rotate rate-limit buckets); a malformed or family-inconsistent CIDR fails fast, the variable named, its value un-echoed. On a Redis outage the limiter SHALL fall back to a **per-instance in-process fixed-window limiter with the identical per-route limits** (equivalent to normal enforcement on single-instance self-host; degrading to per-instance counting on cloud — bounded and logged, never fully open, never a total lockout).

#### Scenario: Reset-request route is throttled
- **WHEN** a client exceeds the limit on `/api/auth/request-password-reset` within its window
- **THEN** further attempts receive 429 with `Retry-After` and are not forwarded

#### Scenario: Brute force is throttled
- **WHEN** a client exceeds the sign-in limit within one window
- **THEN** further attempts in that window receive 429 with `Retry-After` and are not forwarded to the auth handler

#### Scenario: Counters are correct across instances
- **WHEN** two app instances share one Redis and a client's combined attempts cross the limit
- **THEN** the limit is enforced on the combined count (no per-instance drift)

#### Scenario: Each client behind an IPv6 proxy gets its own bucket
- **WHEN** two clients reach the instance through an IPv6 proxy whose address is within a configured IPv6 `TRUSTED_PROXY_CIDRS` entry, each carrying a distinct `X-Forwarded-For`
- **THEN** each client is rate-limited on its own forwarded address (distinct buckets), not collapsed into the single proxy peer address
