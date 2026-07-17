## Why

Two auth-plane defenses the spec mandates are weaker than they read (FABLE_AUDIT E9). Neither is a live
data leak today (`@CurrentPrincipal` throws on a missing principal), but one is an auth-plane DoS and
both rest on fragile assumptions:

- **IPv4-only client-IP CIDR matching:** `ipInCidr` short-circuits false for any non-IPv4 peer/CIDR, so
  behind an IPv6-connecting proxy (dual-stack cloud ingress, pod-to-pod v6) `X-Forwarded-For` is
  discarded and `clientIp` returns the single proxy address for **every** request → all clients share
  one rate-limit bucket. 10 sign-in attempts/min then locks out **everyone**, and per-client
  brute-force isolation is lost. `TRUSTED_PROXY_CIDRS` also silently accepts an (never-matching) IPv6
  CIDR.
- **Case-sensitive `/api` plane check:** the session guard scopes with `req.path.startsWith('/api')`,
  but Express routes case-insensitively, so `GET /API/agents` matches the controller yet **skips the
  global `SessionGuard`**. Saved today only by `@CurrentPrincipal` throwing (500, not a leak), but any
  future `/api` handler that reads the principal optionally would serve unauthenticated.

## What Changes

- **E9.1** Rewrite `ipInCidr` to be family-aware (IPv4 + IPv6 + IPv4-mapped) via Node's `net.BlockList`,
  keeping the `::ffff:` peer normalization; validate every configured `TRUSTED_PROXY_CIDRS` entry at
  boot (a malformed/mixed CIDR fails fast, naming the var).
- **E9.2** Normalize the plane check to `req.path.toLowerCase()` at every plane-scoping site — the
  `SessionGuard` `/api` check, the mount's Better-Auth `/api/auth` interception and `/v1` body-plane
  (`isV1`), and the rate limiter's `matchRule` — so an upper/mixed-case path is scoped identically.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `session-auth`: the rate-limit client-IP derivation SHALL be IPv6-aware with boot-validated trusted
  CIDRs; plane scoping (session guard, auth interception, throttling) SHALL be case-insensitive.

## Impact

- **Code:** `packages/control-plane/src/auth/client-ip.ts` (`ipInCidr` IPv6), `auth.config.ts`
  (`TRUSTED_PROXY_CIDRS` boot validation), `session.guard.ts` + `mount.ts` (`isV1` + `/api/auth`) +
  `rate-limit.ts` (`matchRule`) case-insensitive.
- **Tests:** new `client-ip` unit suite (IPv6 XFF bucketing, mixed-family CIDRs, spoof rejection); an
  auth-config CIDR-validation test; e2e uppercase-path cases (`GET /API/agents` → 401,
  `/API/auth/sign-in/email` throttled).
- **No migration.** **Changeset:** user-facing (IPv6 proxy support + CIDR validation). Backlog A-25+
  (if any) untouched.
