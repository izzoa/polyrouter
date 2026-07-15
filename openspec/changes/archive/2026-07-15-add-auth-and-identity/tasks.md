# Tasks: add-auth-and-identity

## 1. Shared foundations

- [x] 1.1 `shared/src/harness.ts` (root entry): canonical `HARNESS_TYPES` + `HarnessType` + `connectionSnippet(harness, baseUrl, apiKey)`; refactor the dashboard prototype's local snippet/harness copies to consume it (frontend tests keep passing)
- [x] 1.2 Auth-plane tables in `shared/src/server/db/schema.ts` — **complete** Better Auth 1.6.23 shapes: `session` (id, token unique, expires_at, created_at, updated_at, ip_address, user_agent, user_id FK cascade, idx on user_id), `account` (id, account_id, provider_id, user_id FK cascade, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at, idx on user_id), `verification` (id, identifier, value, expires_at, created_at, updated_at, idx on identifier); generate + commit the migration and diff it against Better Auth's 1.6.23 CLI schema snapshot
- [x] 1.3 `IdentityPort` type + impl in `control-plane/src/database/port.ts` (semantic methods only: `ensureFirstAdmin`, `findAdminUserId`, `provisionDefaultTier`, `provisionMissingDefaultTiers`, `agentAuth.findByPrefix`/`touchLastUsed`); `AUTH_ADAPTER` token built inside the database module (drizzleAdapter over the private pool with the explicit `{ user: users, session: sessions, account: accounts, verification: verifications }` map); export both from the module; extend the raw-handle-privacy tests to cover the new tokens

## 2. Config & secrets

- [x] 2.1 Register the `auth` namespace: `BETTER_AUTH_SECRET`/`API_KEY_HMAC_SECRET` (hex-64 when set), `BETTER_AUTH_URL` (default `http://127.0.0.1:3001`), `SEED_DATA` (bool default false), `TRUSTED_PROXY_CIDRS` (csv, default empty), optional OAuth pairs (google/github/discord)
- [x] 2.2 Secrets resolution helper: fixed `polyrouter-dev-*` fallbacks allowed ONLY when `NODE_ENV!==production` AND `MODE=selfhosted` AND `BIND_ADDRESS` loopback (one warning); production, cloud, or network-bound boot without real secrets fails fast naming the variable; unit tests for every branch (value never echoed)

## 3. Better Auth integration

- [x] 3.1 `auth/better-auth.ts`: instance factory consuming the `AUTH_ADAPTER` token, email/password, OAuth providers iff pairs configured, `user.additionalFields.role { input: false }`, `trustedOrigins` = the exact dashboard dev origin, `sendResetPassword` → a stub that logs a reset was requested **without the token** (delivery deferred to #15); no own pool (uses the module's adapter)
- [x] 3.2 Mount `toNodeHandler(auth)` on `/api/auth/*` ahead of the Nest router (after the rate limiter); `trust proxy` stays OFF; CORS restricted to the exact dev origin (replaces reflect-any-origin)
- [x] 3.3 `user.create.after` hook: `IdentityPort.ensureFirstAdmin()` + `provisionDefaultTier(id)`; plus a **boot reconciliation** step (advisory-locked) calling `ensureFirstAdmin()` + `provisionMissingDefaultTiers()` before the server binds; fault-injection + restart tests for both a first-user and a later-user crashed hook
- [x] 3.4 `SEED_DATA` boot step: `MODE=selfhosted` AND `NODE_ENV!==production` AND `BIND_ADDRESS` loopback AND zero users → create `admin@localhost` via the real signup API; log the email only, never the password; production / cloud / network-bound + `SEED_DATA=true` (or reliance on fallback secrets) fails fast naming what to set

## 4. Session guard, planes & throttling

- [x] 4.1 `SessionGuard` bound to `/api/**` (not global; `@Public()` for health) resolving the session → `Principal` + `@CurrentPrincipal()`; unauthenticated `/api` → 401; a Bearer agent key is inert on `/api` and a session cookie is inert on `/v1` (plane separation)
- [x] 4.2 Localhost auto-login inside the guard, gated on non-reachability: `MODE=selfhosted` + `BIND_ADDRESS` loopback + no forwarding header + sessionless + loopback socket peer + loopback `Host` + same-origin + admin exists → admin principal; reject on any forwarding header, non-loopback bind, spoofed Host, or foreign Origin; never in cloud
- [x] 4.3 Redis rate limiter middleware for sign-up (5/min) / sign-in (10/min) / **`/request-password-reset` + `/reset-password`** (3/5min) per IP per route via an **atomic Lua** INCR+expire-on-first+return-TTL script → 429 + `Retry-After`; client IP = raw socket peer, honoring `X-Forwarded-For` only when the peer is within `TRUSTED_PROXY_CIDRS`; on Redis outage fall back to a per-instance in-process limiter with identical limits (log severity/alerting differs by mode); unit tests for window math, atomicity, the in-process fallback, and XFF-trust gating

## 5. Agent keys & CRUD

- [x] 5.1 `agent-keys.service.ts`: mint (`poly_` + 24 random bytes base64url; stored prefix = `poly_` + first 12 payload chars), HMAC-SHA256 hash, `timingSafeEqual` verify, prefix-collision retry; unit test asserts the verify path calls only HMAC + constant-time compare (no KDF) plus tampered-key/prefix-mismatch cases
- [x] 5.2 `AgentApiKeyGuard`: Bearer parse → `IdentityPort.agentAuth.findByPrefix` → `timingSafeEqual` → attach agent + principal; **coalesced** `touchLastUsed` (per-agent throttle, `.catch`-guarded, non-blocking); uniform 401s; mounted on a test-only `/v1` probe route
- [x] 5.3 `/api/agents` CRUD: list (safe fields, no hash), create (DTO fields `name` + `harness` from the shared enum; returns shown-once key + snippet + `Cache-Control: no-store`), rotate-key (shown-once, `no-store`), delete — all via the scoped `agents` repository

## 6. E2e (MODE=cloud unless stated)

- [x] 6.1 Auth flow: signup → session cookie → protected route 200; sessionless → 401; a session cookie is inert on the `/v1` probe and a Bearer key is inert on `/api` (plane separation); stored account password is a salted scrypt string (not plaintext/fast digest); signup payload with `role` cannot escalate
- [x] 6.2 First-admin + reconciliation: N concurrent signups on a clean state → exactly one admin; every signup owns exactly one `default` tier; a simulated committed-but-unpromoted first user AND a later user with a crashed tier hook are both healed at next boot, with the API fail-closed during the gap
- [x] 6.3 Self-host suite (`MODE=selfhosted`, loopback-bound): same-origin loopback sessionless request serves as admin once an admin exists; a forwarding header, non-loopback bind, spoofed `Host`, and foreign `Origin` are each refused; 401 before any admin; dev-admin seed creates the account and logs no password
- [x] 6.4 Throttle: exceed the sign-in and `/request-password-reset` windows → 429 with `Retry-After`; two instances on one Redis enforce the combined count (no drift); Redis-down falls back to the in-process limiter (keys cleaned between runs)
- [x] 6.5 Agent keys: create agent via API → returned key authenticates the `/v1` probe; rotation kills the old key; unknown prefix/wrong key/malformed header → 401; `last_used_at` eventually stamped (coalesced, polled) without one-write-per-request; response bodies and logs never contain the full key or the stored hash
- [x] 6.6 Cross-tenant Agents API: user A on user B's agent id (rotate/DELETE) → 404 and B absent from A's list; B's key still works

## 7. Verification & bookkeeping

- [x] 7.1 `npm run build`, unit suites, `npm run test:e2e` (dev compose up), `npm run lint` green; strict TS clean
- [x] 7.2 Changeset; TODOS.md board row #3 updated; scrypt wording reconciled in TODOS.md; #15 gains a password-reset-email-delivery note
