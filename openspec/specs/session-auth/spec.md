# session-auth Specification

## Purpose
TBD - created by archiving change add-auth-and-identity. Update Purpose after archive.
## Requirements
### Requirement: Better Auth session plane guards the management API on its own plane
Better Auth (email/password always; Google/GitHub/Discord OAuth each enabled only when its client id/secret pair is configured) SHALL be mounted at `/api/auth/*`, with passwords hashed by a slow, memory-hard KDF (Better Auth's scrypt — satisfying spec §3.2.3's argon2/bcrypt intent, flagged in design). A `SessionGuard` SHALL protect `/api/**` (except `GET /api/health` and the auth routes), resolving the authenticated user into the request `Principal` (§11.1). Guarding is **plane-scoped**: the session guard applies only to `/api`, the agent-key plane applies to `/v1`, and **neither credential authenticates on the other plane** (invariant 7) — a session cookie is inert on `/v1`, a Bearer agent key is inert on `/api`.

#### Scenario: Signup and session round-trip
- **WHEN** a user signs up via `/api/auth/sign-up/email` and calls a protected `/api` route with the returned session cookie
- **THEN** the route executes with that user's principal, and the same call without a session returns 401

#### Scenario: Credentials do not cross planes
- **WHEN** a valid session cookie is sent to a `/v1` route, or a valid Bearer agent key is sent to a protected `/api` route
- **THEN** each is rejected on the foreign plane (the session does not authenticate `/v1`, the agent key does not authenticate `/api`)

#### Scenario: Passwords are slow-hashed
- **WHEN** a user's credential row is inspected after signup
- **THEN** the stored password is a salted scrypt hash — not plaintext and not a fast digest

### Requirement: First user becomes admin exactly once, crash-safely, and signup provisions routing
On user creation `ensureFirstAdmin()` SHALL run under `withAdvisoryLock`: if no admin exists, the earliest-created user is promoted — so N concurrent first signups yield exactly one admin regardless of interleaving (§11.3). Because the auth library commits the user before running the after-hook, a **boot-time reconciliation** (also advisory-locked) SHALL heal any zero-admin or missing-default-tier state left by a crashed hook, before the guard serves traffic; during any promotion gap the system SHALL be fail-closed (protected routes 401, auto-login refuses), never fail-open. The `role` field SHALL be server-owned (`input: false`) so signup payloads cannot assign it. Every signup SHALL also provision the user's `default` tier.

#### Scenario: Concurrent first signups yield one admin
- **WHEN** multiple signups race on an empty instance
- **THEN** exactly one resulting user has `role='admin'` and the rest do not

#### Scenario: A crashed promotion is healed at next boot
- **WHEN** a user was committed but its promotion/tier provisioning did not complete (simulated), and the app restarts
- **THEN** boot reconciliation leaves exactly one admin and a `default` tier for that user, and no route served during the gap ran without an authenticated principal

#### Scenario: A later user's missing tier is healed too
- **WHEN** a non-first user (an admin already exists) was committed but its default-tier hook crashed, and the app restarts
- **THEN** boot reconciliation provisions that user's missing `default` tier (via `provisionMissingDefaultTiers`), not only the first admin's

#### Scenario: Role cannot be mass-assigned
- **WHEN** a signup payload includes a `role` field
- **THEN** the created user's role is unaffected by the payload

#### Scenario: Signup seeds the default tier
- **WHEN** a user completes signup
- **THEN** exactly one `default` tier owned by that user exists

### Requirement: Self-host conveniences are gated and hardened against local abuse
When `MODE=selfhosted`, localhost auto-login SHALL serve a sessionless request as the existing admin ONLY when ALL hold: **`BIND_ADDRESS` resolves to a loopback address** (the instance is not network-reachable — the load-bearing gate), **no forwarding header** (`X-Forwarded-*`/`Forwarded`) is present (a proxy in front ⇒ refuse), the raw socket peer is loopback (`trust proxy` OFF), the `Host` header is loopback (DNS-rebinding defense), the request is same-origin (`Origin`/`Sec-Fetch-Site` absent or the exact dashboard origin), and an admin exists (else 401). CORS SHALL be restricted to the exact dashboard dev origin. The dev-admin seed and the fixed dev fallback secrets SHALL be permitted ONLY when `MODE=selfhosted` AND `NODE_ENV!==production` AND `BIND_ADDRESS` is loopback; a network-bound or production boot that requests the seed or relies on fallback secrets SHALL fail fast, and the seed password SHALL NEVER be logged (invariant 8). None of these behaviors SHALL exist when `MODE=cloud`.

#### Scenario: Loopback auto-login on a loopback-bound instance
- **WHEN** an admin exists, `MODE=selfhosted`, `BIND_ADDRESS` is loopback, and a same-origin sessionless request arrives from the loopback interface with a loopback Host and no forwarding headers
- **THEN** protected `/api` routes serve it as the admin principal

#### Scenario: Proxied, network-bound, spoofed, or cross-origin requests are refused
- **WHEN** a sessionless request carries a forwarding header (proxy), or `BIND_ADDRESS` is non-loopback, or the `Host` is non-loopback (rebinding), or the `Origin` is foreign (hostile page) — even from a loopback socket
- **THEN** auto-login does not apply and the route returns 401

#### Scenario: Cloud mode never auto-logs-in
- **WHEN** `MODE=cloud` and a sessionless loopback request arrives
- **THEN** protected routes return 401

#### Scenario: Seed and fixed secrets are confined to loopback-bound dev
- **WHEN** the app boots with `MODE=selfhosted`, `NODE_ENV!==production`, `BIND_ADDRESS` loopback, `SEED_DATA=true`, and zero users
- **THEN** a dev admin exists afterwards and the boot log names the seeded email but never the password; a production, cloud, or network-bound boot that requests the seed or lacks real secrets instead exits non-zero naming what to set

### Requirement: Auth endpoints are rate limited atomically with a mode-aware failure policy
Sign-up (5/min), sign-in (10/min), and the actual Better Auth 1.6 reset routes **`/request-password-reset` and `/reset-password`** (3/5min) SHALL be rate limited per client IP per route using an **atomic Redis operation** (a Lua script that increments, sets expiry only on first hit, and returns the TTL — so a mid-pair crash cannot leak a non-expiring counter), correct across instances (§3.2); excess requests receive 429 with `Retry-After` and are not forwarded to the auth handler. Client IP SHALL be the raw socket peer; `X-Forwarded-For`'s last hop SHALL be honored only when that immediate peer is within a configured `TRUSTED_PROXY_CIDRS` entry. On a Redis outage the limiter SHALL fall back to a **per-instance in-process fixed-window limiter with the identical per-route limits** (equivalent to normal enforcement on single-instance self-host; degrading to per-instance counting on cloud — bounded and logged, never fully open, never a total lockout).

#### Scenario: Reset-request route is throttled
- **WHEN** a client exceeds the limit on `/api/auth/request-password-reset` within its window
- **THEN** further attempts receive 429 with `Retry-After` and are not forwarded

#### Scenario: Brute force is throttled
- **WHEN** a client exceeds the sign-in limit within one window
- **THEN** further attempts in that window receive 429 with `Retry-After` and are not forwarded to the auth handler

#### Scenario: Counters are correct across instances
- **WHEN** two app instances share one Redis and a client's combined attempts cross the limit
- **THEN** the limit is enforced on the combined count (no per-instance drift)

### Requirement: Auth secrets are production-required with safe dev fallbacks
`BETTER_AUTH_SECRET` and `API_KEY_HMAC_SECRET` SHALL validate as 32-byte hex when set. When unset: a production boot SHALL fail fast naming the variable (value never echoed); development/test SHALL use fixed, clearly-labeled dev constants and log one warning. OAuth provider credentials SHALL be optional pairs; a provider is enabled only when its pair is present.

#### Scenario: Production refuses to boot without secrets
- **WHEN** `NODE_ENV=production` and `BETTER_AUTH_SECRET` or `API_KEY_HMAC_SECRET` is unset
- **THEN** boot exits non-zero naming the missing variable before binding

#### Scenario: Development warns and proceeds
- **WHEN** a development boot has no auth secrets configured
- **THEN** the app runs with dev-labeled fallbacks and logs exactly one warning naming them

