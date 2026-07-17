---
type: Architecture
title: Security & Authentication
description: Polyrouter's dual auth model (session + agent keys), SSRF protection, AES-256-GCM credential encryption, tenant isolation, rate limiting, and metadata-only privacy.
tags: [security, auth, ssrf, encryption, tenant-isolation]
resource: packages/control-plane/src/auth/
---

# Security & Authentication

Polyrouter implements defense-in-depth security across two authentication planes, with SSRF protection, encrypted credentials, mandatory tenant isolation, and a metadata-only privacy model.

## Dual Authentication

### Dashboard Sessions (Web Plane)

Requests to `/api/**` are authenticated via Better Auth 1.6:

- **Email/password** — standard credential auth
- **OAuth providers** — configurable third-party login
- **JWT sessions** — stateless tokens with expiration
- **Rate limiting** — Redis-backed rate limiter applied before the Better Auth handler

The auth bootstrap seeds the first admin user on initial startup.

**Source**: `packages/control-plane/src/auth/session.guard.ts`, `packages/control-plane/src/auth/auth.bootstrap.ts`

### Agent API Keys (API Plane)

Requests to `/v1/**` are authenticated via HMAC-signed API keys:

```
Authorization: Bearer poly_YOUR_API_KEY
```

Verification uses **prefix lookup** for fast O(1) key resolution:

1. Extract the `poly_` prefix from the key
2. Look up agents by prefix (indexed column)
3. Validate the full HMAC-SHA256 signature against `api_key_hash`
4. Attach the authenticated principal to the request

Keys are minted from the dashboard or `/api/agents` endpoint. Key rotation is supported — old keys are invalidated immediately.

**Source**: `packages/control-plane/src/auth/agent-key.guard.ts`

## SSRF Protection

Every outbound HTTP request passes through SSRF protection to prevent server-side request forgery:

### URL Validation

```typescript
assertUrlSafe(url: string): void
// Throws if URL targets private/loopback/link-local/metadata ranges
```

### IP Classification

The `network-host.ts` module classifies resolved IPs:

| Range | Classification | Blocked |
|-------|---------------|---------|
| `10.0.0.0/8` | Private | Yes |
| `172.16.0.0/12` | Private | Yes |
| `192.168.0.0/16` | Private | Yes |
| `127.0.0.0/8` | Loopback | Yes* |
| `169.254.0.0/16` | Link-local | Yes |
| `100.64.0.0/10` | CGNAT | Yes |
| `fd00::/8` | Private (IPv6) | Yes |
| Metadata endpoints | AWS/GCP/Azure | Yes |

*Loopback is allowed only for `local` provider kind in self-host mode.

### DNS Rebinding Defense

Resolved IPs are validated at connect time, not just at URL parse time. This prevents DNS rebinding attacks where a URL resolves to a public IP initially but a private IP on the actual connection.

**Source**: `packages/shared/src/server/security/ssrf.ts`, `packages/shared/src/server/security/network-host.ts`

## Credential Encryption

Provider and notification channel credentials are encrypted at rest with **AES-256-GCM**:

```typescript
// Encrypt (on write)
const encrypted = await encryptSecret(plaintext, key);

// Decrypt (on read, only at call time)
const plaintext = await decryptSecret(encrypted, key);
```

### Key Management

| Secret | Env Var | Purpose |
|--------|---------|---------|
| Auth secret | `BETTER_AUTH_SECRET` | Session signing |
| API key HMAC | `API_KEY_HMAC_SECRET` | Agent key hashing |
| Provider credential key | `PROVIDER_CREDENTIAL_KEY` | Provider secret encryption |
| Notification credential key | `NOTIFY_CREDENTIALS_SECRET` | Notification channel encryption |

Key rotation is supported via dual-key decryption (decrypt with old key, re-encrypt with new key).

**Source**: `packages/shared/src/server/security/encryption.ts`

## Tenant Isolation

Every database query is scoped to the authenticated user's identity:

```typescript
// Type-safe tenancy — can't construct a query without an owner
function ownershipPredicate(owner: string) {
  return eq(table.owner_user_id, owner);
}
```

The `userPrincipal` type makes it a compile error to run a query without tenant scoping. Cross-tenant read tests verify isolation across all endpoints.

**Source**: `packages/shared/src/server/database/tenancy.ts`

## Metadata-Only Privacy

By design, polyrouter **never stores prompt or response bodies**. The `request_log` table contains only:

- Token counts (input/output)
- Model and provider IDs
- Cost and pricing snapshots
- Routing decision metadata
- Latency measurements

This means even a full database breach exposes no conversation content.

## Input Validation

All configuration input is validated with Zod schemas:

- **Whitelist mode** — only known fields accepted
- **Forbid non-whitelisted** — unknown fields cause validation errors
- **Model ID cap** — 512 characters max
- **Model list cap** — 5000 entries max
- **Numeric bounds** — all counts and prices have explicit ranges

## Rate Limiting

Auth routes are rate-limited before the Better Auth handler:

- Redis-backed sliding window
- Applied per IP for login attempts
- Applied per session for sensitive operations

**Source**: `packages/control-plane/src/auth/rate-limit.ts`

## Security Audit

The [`FABLE_AUDIT.md`](/FABLE_AUDIT.md) file documents a 19-surface multi-agent security audit. Key verified areas:

- ✅ Tenancy seam — no cross-tenant data leaks
- ✅ Mid-stream commit rule — no model swap after first token
- ✅ SSRF pinning — full IPv4 + IPv6 range blocking
- ✅ Append-only pricing — immutable cost records
- ✅ Budget counters — monotonic reconcile
- ✅ Breaker settling — generation-stamped state
- ✅ Auto-layer gating — opt-in only
- ✅ Notification isolation — fire-and-forget, no request-path blocking

0 critical findings. All high and medium findings resolved.
