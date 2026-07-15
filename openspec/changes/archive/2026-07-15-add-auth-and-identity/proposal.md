# Proposal: add-auth-and-identity

> Implements **TODOS.md #3 `add-auth-and-identity`** — spec.md **§2.1** (connect an agent), **§5** (User/Agent), **§6.2** (Agents CRUD), **§11/§11.3** (auth, endpoint protection), **§12** (auth env), **§14.3**. CLAUDE.md invariant **7** (two credential planes: HMAC agent keys, never bcrypt; slow-hashed session passwords).

## Why

Everything user-facing needs an authenticated principal, and the proxy (#10) needs agents with verifiable keys. This change lands **both credential planes** — Better Auth sessions for the dashboard/management API and HMAC-SHA256 agent API keys for the proxy — plus the §11 self-host UX (first user = admin, localhost auto-login, seed admin) and the §11.3 protections (auth-endpoint rate limiting, first-admin race guard), so #6+ CRUD changes inherit a real session guard and #10 inherits a ready `AgentApiKeyGuard`.

## What Changes

- **Better Auth 1.6.23** mounted at `/api/auth/*` (email/password + Google/GitHub/Discord OAuth, each enabled only when its client id/secret pair is configured); its drizzle adapter is **built inside the database module** (over that module's private pool, identity tables only) and exported as an opaque token, so no new raw handle escapes #2's boundary. **Per-plane guarding**: `SessionGuard` on `/api/**` (health + auth routes excepted); `/v1/**` is the agent-key plane; neither credential authenticates on the other plane.
- **Auth-plane tables** `session`, `account`, `verification` (complete Better Auth 1.6.23 shapes, explicit singular-model→plural-table map) join the shared schema + one migration; `user.role` is exposed via `additionalFields` with `input: false` (server-owned — no mass assignment).
- **First user = admin, race-safely and crash-safely**: `ensureFirstAdmin()` under `withAdvisoryLock` promotes the earliest user iff none is admin (concurrent first signups → exactly one admin), plus a **boot-time reconciliation** heals any zero-admin/missing-tier state left by a crashed post-commit hook. Signup provisions the user's `default` tier (idempotent, #2). During any promotion gap the system is fail-closed.
- **Self-host UX (`MODE=selfhosted`)**: loopback auto-login, hardened — loopback socket **and** loopback `Host` **and** same-origin **and** an admin exists (defeats reverse-proxy spoofing, DNS rebinding, hostile browser origins); CORS pinned to the exact dev origin. `SEED_DATA` creates a dev admin only when selfhosted **and** non-production, **never logging the password**.
- **Auth-endpoint rate limiting**: **atomic Lua** Redis fixed-window per IP per route (sign-in 10/min, sign-up 5/min, reset 3/5min) → 429 with `Retry-After` (§11.3), correct across instances; **fails open on self-host, closed on cloud** (with an in-process backstop); proxy-aware IP only via explicit `TRUSTED_PROXY_CIDRS`.
- **Agent API keys**: `poly_…` keys minted/rotated shown-once (`Cache-Control: no-store`); stored as **HMAC-SHA256 hash + unique prefix** (`poly_` + first 12 payload chars = 72 bits; O(1) lookup, constant-time compare — never bcrypt, proven by a deterministic no-KDF unit assertion); `AgentApiKeyGuard` resolves `Bearer` keys and stamps `last_used_at` **coalesced** (per-agent throttle, `.catch`-guarded) off the hot path.
- **Agents CRUD** under `/api/agents` (list/create/rotate-key/delete), tenant-scoped through #2's guard, returning per-harness connection snippets from a new canonical `shared` module (the dashboard prototype's snippet logic moves there).
- **Config (`auth` namespace)**: `BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET` (hex-64; **required in production**, fixed dev fallbacks with a loud warning otherwise), `BETTER_AUTH_URL`, `SEED_DATA`, `TRUSTED_PROXY_CIDRS`, optional OAuth pairs.

## Capabilities

### New Capabilities

- `session-auth`: the Better Auth session plane — mounting, session guard, first-admin race safety, default-tier provisioning at signup, localhost auto-login, seed admin, auth-endpoint rate limiting, secrets policy.
- `agent-keys`: the agent credential plane — minting/rotation, HMAC+prefix storage and fast verification, the Bearer guard, Agents CRUD with harness snippets.

### Modified Capabilities

- `database-schema`: the identity/config schema gains the auth-plane tables (`session`, `account`, `verification`).
- `tenant-isolation`: the database module additionally exports an opaque `AUTH_ADAPTER` token and a separate `IdentityPort` token with **semantic** identity methods (`ensureFirstAdmin`, `findAdminUserId`, `provisionDefaultTier`, `agentAuth.findByPrefix`/`touchLastUsed`) — NOT folded into the tenant `PersistencePort`, and exposing no query builder or raw handle. Raw Pool/drizzle privacy is unchanged.

## Impact

- **Code:** `control-plane/src/database/**` (Better Auth adapter construction + `IdentityPort` impl over the existing private pool), `control-plane/src/auth/**` (Better Auth instance + mount, session guard, rate limiter, seed, agent-key service + guard), `src/agents/**` (CRUD), `shared/src/harness.ts` (root entry: harness list + snippets, consumed by frontend too), `shared/src/server/**` (auth tables, identity-port + adapter token types), one migration. New deps: `better-auth`.
- **No second raw handle:** the Better Auth adapter is constructed by the database module over its existing private pool (identity tables only) and exported opaquely — #2's "unscoped SQL is unwritable outside the persistence module" holds.
- **Downstream:** every `/api` change from #6 on uses `SessionGuard` + `@CurrentPrincipal()`; #10 consumes `AgentApiKeyGuard` (proven here on a `/v1` probe route); #18's connect-agent flow calls these endpoints; **#15 owns password-reset email delivery** (a TODOS note is added).

## Non-goals

- **No proxy endpoints** (#10) — the key guard is proven against a `/v1` test probe route only.
- **No dashboard UI** (#18) — the prototype keeps simulating; only the shared snippet module is refactored.
- **No org/team membership** (deferred change), **no Better Auth admin plugin** (ban/impersonation surface is unneeded; `role` is our column).
- **No email delivery** — password reset issues Better Auth tokens; the send callback is a no-token-logging stub, and SMTP/Apprise delivery is deferred to #15 (tracked there).
