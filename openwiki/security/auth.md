---
type: Architecture
title: Security & Authentication
description: Polyrouter's dual auth model (session + agent keys), SSRF protection, AES-256-GCM credential encryption with typed credential envelopes, tenant isolation, rate limiting, and metadata-only privacy.
tags: [security, auth, ssrf, encryption, tenant-isolation, oauth]
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

The first user to sign up becomes the instance admin (**first-signup-wins**): a single atomic claim on the `instance_settings.bootstrap_claimed_at` column decides the race, so multi-instance deployments can't double-crown. A stale claim (crashed winner, still zero users) is stealable after a short window so a failed bootstrap self-heals. After bootstrap, registration is invite-only by default — admins mint single-use, hashed, expiring invite tokens; the registration policy (`invite_only`/`open`) lives in `instance_settings` and is read authoritatively per signup attempt. Admins can disable users, which denies access on **both** planes (session + agent key) and prevents minting new sessions.

**Source**: `packages/control-plane/src/auth/session.guard.ts`, `packages/control-plane/src/auth/signup-gate.ts`, `packages/control-plane/src/auth/invites.service.ts`, `packages/control-plane/src/admin/admin.controller.ts`

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

### Credential Envelope

The decrypted content of `provider.encrypted_credentials` is a **typed envelope**:

- **Legacy rows** — a raw string, read as `kind: 'plain'` (unchanged semantics)
- **New writes** — `polycred:v1:` + JSON, either `{ v:1, kind:'plain', value }` or `{ v:1, kind:'oauth', preset, accessToken, refreshToken, expiresAt, accountId? }`

Plain writes **wrap** user input, so a pasted `polycred:v1:…` lookalike becomes a `plain` credential whose value contains that string — the `oauth` kind is unforgeable through every paste path by construction (only the connect/refresh code path calls `serializeOauthCredential`). Marker-prefixed content that fails to parse throws a typed `TamperedCredentialError`, never a silent fallback to plain. Error messages are fixed — credential content is never logged or echoed (invariant 8).

OAuth envelopes are minted and refreshed by the [Subscription OAuth](/openwiki/providers/subscription-oauth.md) flow; all credential mutations (refresh write, PATCH rotate/clear, reauthorize) serialize on one per-provider advisory lock (`credentialLockKey`, FNV-1a over the provider id) so rotation can never be clobbered.

**Source**: `packages/shared/src/server/security/credential-envelope.ts`

### Key Management

| Secret | Env Var | Purpose |
|--------|---------|---------|
| Auth secret | `BETTER_AUTH_SECRET` | Session signing |
| API key HMAC | `API_KEY_HMAC_SECRET` | Agent key hashing |
| Provider credential key | `PROVIDER_CREDENTIAL_KEY` | Provider secret encryption (plain API keys and OAuth envelopes) |
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

## Metadata-Only Privacy (Default)

By design, polyrouter **never stores prompt or response bodies** by default. The `request_log` table contains only:

- Token counts (input/output)
- Model and provider IDs
- Cost and pricing snapshots
- Routing decision metadata
- Latency measurements

This means even a full database breach exposes no conversation content.

**Opt-in body capture** (add-body-capture): selfhosted instances can enable prompt/response body capture via the dashboard Settings page. When enabled (`errors_only` or `all` mode), bodies are encrypted with the same `PROVIDER_CREDENTIAL_KEY` as provider credentials and stored in `request_body` rows alongside the request log. The feature is off by default, selfhosted-only (`MODE=selfhosted`), and gated behind an explicit consent confirm. Bodies are purged daily per the configured retention window (default 30 days); infinite retention requires an explicit keep-forever choice. Per-agent overrides (`always`/`never`) refine the global mode. A `capture_epoch` deletion-revocation counter and `request_body_tombstone` table prevent stale writes from resurrecting deleted bodies. See [Data Model](/openwiki/data-model/schema.md#budgets--notifications) for schema details.

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
