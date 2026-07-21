---
type: Reference
title: Data Model & Database Schema
description: Polyrouter's PostgreSQL schema — 13 core tables covering identity, routing configuration, request logging, pricing, budgets, and notifications with tenant isolation and immutable cost records.
tags: [database, schema, postgresql, drizzle, tenant-isolation]
resource: packages/shared/src/server/database/
---

# Data Model & Database Schema

Polyrouter uses PostgreSQL 16 with Drizzle ORM. The schema is organized into four domains: identity, routing, observability, and budgets/notifications.

## Design Principles

- **Tenant isolation** — `owner_user_id` on every table; all queries scoped via `WHERE owner = current_principal`
- **Immutable cost records** — prices snapshotted at request time, never recomputed
- **Append-only audit** — `request_log` survives provider/model deletion (denormalized IDs)
- **Encrypted credentials** — provider and channel credentials encrypted at rest with AES-256-GCM
- **Cascading deletes** — FK constraints with `ON DELETE CASCADE` for clean tenant data removal

## Schema Overview

### Identity & Auth

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `user` | Better Auth users | `id`, `email`, `name`, `password_hash`, `role`, `disabled` |
| `session` | JWT sessions | `id`, `user_id`, `expires_at`, `token` |
| `account` | OAuth provider links | `id`, `user_id`, `provider`, `provider_account_id` |
| `agent` | API keys (`poly_...`) | `id`, `owner_user_id`, `name`, `api_key_hash`, `harness_type` |
| `invite` | Single-use account invites | `id`, `email`, `token_prefix`, `token_hash`, `role`, `expires_at`, `consumed_at` |
| `instance_settings` | Instance-wide runtime settings (singleton row) | `registration_mode`, `bootstrap_claimed_at` |

`invite` stores only the token prefix + HMAC-style hash (like agent keys) — never the raw token. `instance_settings.bootstrap_claimed_at` decides the first-signup-wins admin race atomically; `registration_mode` (`invite_only`/`open`) is read authoritatively per signup attempt. See [Security & Auth](/openwiki/security/auth.md#dashboard-sessions-web-plane).

### Routing Configuration

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `provider` | LLM providers | `id`, `owner_user_id`, `name`, `kind` (api_key/subscription/custom/local), `protocol`, `base_url`, `credentials_encrypted`, `oauth_preset`, `credential_expires_at`, `credential_error` |
| `model` | Available models | `id`, `provider_id`, `external_id`, `capabilities` (tools, vision, reasoning), `input/output_price_per_1m`, `listed_*` display estimates |
| `tier` | Routing tiers | `id`, `owner_user_id`, `name`, `is_default` |
| `routing_entry` | Tier↔model chains | `id`, `tier_id`, `model_id`, `provider_id`, `position` (0-4) |
| `routing_rule` | Header/default rules | `id`, `owner_user_id`, `priority`, `header_name`, `header_value`, `tier_id` |
| `routing_settings` | Per-tenant auto-layer prefs | `owner_user_id`, `structural_enabled`, `cascade_enabled` |

**Subscription OAuth columns** (provider): `oauth_preset` names the bundled preset (`claude`/`chatgpt`) for an OAuth-connected provider; `credential_expires_at` mirrors the access token's expiry for the UI (never an auth input — the encrypted envelope is authoritative); `credential_error` is the durable credential state the dashboard reads after reload (`reauthorize_required`). All three are non-secret — tokens live only inside the encrypted envelope. See [Subscription OAuth](/openwiki/providers/subscription-oauth.md#credential-envelope).

**Listed price columns** (model): `listed_input_price_per_1m`, `listed_output_price_per_1m`, `listed_is_free`, `listed_price_captured_at` — a display-only estimate captured from the provider's `/models` endpoint at sync. Deliberately distinct from the user-price columns: these **never** feed `resolveModelPrice`, the `model_price` catalog, or the request-time cost snapshot (recorded cost comes from the bundled catalog, not provider `/models`). Rewritten on every sync; cleared on a base URL or protocol change.

### Observability

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `request_log` | Immutable cost records | `id`, `owner_user_id`, `agent_id`, `provider_id`, `model_id`, `input_tokens`, `output_tokens`, `cost_micro_usd`, `price_snapshot`, `decision_layer`, `routing_header_name`, `routing_header_value`, `latency_ms`, `status` |
| `request_attempt` | Per-attempt cost ledger | `id`, `request_log_id`, `provider_id`, `model_id`, `outcome`, `latency_ms` |
| `model_price` | Effective-dated pricing | `id`, `model_id`, `effective_at`, `input_price_per_mtok`, `output_price_per_mtok` |

**Routing header visibility** (add-routing-header-visibility): `request_log.routing_header_name` and `routing_header_value` record which header chose the route. Set only on `decision_layer='header'` rows. The built-in tier header records name + matched tier key; custom rules record name only (value is null — a configured header value can be a credential and is never persisted). A CHECK constraint enforces value-requires-name.

### Budgets & Notifications

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `budget` | Spend limits | `id`, `owner_user_id`, `scope` (global/agent), `scope_id`, `window` (day/week/month), `action` (alert/block), `limit_micro_usd` |
| `notification_channel` | Alert channels | `id`, `owner_user_id`, `type` (smtp/apprise), `name`, `config_encrypted`, `events_subscribed` |
| `body_capture_settings` | Per-tenant body capture config | `owner_user_id`, `mode` (off/errors_only/all), `retention_days`, `capture_epoch`, `dropped_count`, `last_purge_at`, `last_purge_count` |
| `request_body` | Captured prompt/response bodies | `id`, `request_log_id` (FK CASCADE), `direction` (request/response), `content_encrypted`, `bytes`, `truncated`, `partial` |
| `request_body_tombstone` | Deletion tombstones | `request_log_id` (PK, FK CASCADE), `owner_user_id` |

**Body capture** (add-body-capture) is an opt-in feature, off by default. When enabled (`errors_only` or `all`), prompt and response bodies are captured, encrypted with the same `PROVIDER_CREDENTIAL_KEY` as provider credentials, and stored alongside the request log. The `request_body` rows are deletable operational data (not audit) — FK CASCADE with the parent `request_log`. The `capture_epoch` column is a deletion-revocation counter: purge-all or disable-with-purge bumps it under a `FOR UPDATE` lock, and the writer's guarded insert re-reads it post-lock to discard stale drafts. A `request_body_tombstone` prevents queued/retrying writes from resurrecting deleted bodies. Bodies are purged daily by a BullMQ scheduler (03:30 UTC) per-owner retention window; infinite retention requires an explicit `keepForever` choice. The feature is selfhosted-only (`MODE=selfhosted`) — cloud instances never arm capture.

## Tenant Isolation

Every table with `owner_user_id` is scoped at query time:

```typescript
// Shared guard pattern
function ownershipPredicate(owner: string) {
  return eq(table.owner_user_id, owner);
}
```

The `userPrincipal` type ensures tenancy is enforced at the type level — you can't construct a query without an owner.

**Source**: `packages/shared/src/server/database/tenancy.ts`

## Immutable Cost Records

When a request completes, the `request_log` row stores:

```typescript
{
  cost_micro_usd: number;        // Computed from snapshotted prices
  price_snapshot: {
    input_per_mtok: number;      // Price at request time
    output_per_mtok: number;
  };
  usage_estimated: boolean;      // true if provider didn't return usage
}
```

Historical costs are **never recomputed** when model prices change. The `model_price` table is append-only with effective dates, so price changes create new rows rather than updating existing ones.

**Source**: `packages/shared/src/server/pricing/`

## Encrypted Credentials

Provider and notification channel credentials are encrypted with AES-256-GCM:

```typescript
// Encrypt on write
const encrypted = await encryptSecret(plaintext, PROVIDER_CREDENTIAL_KEY);

// Decrypt on read (only at call time)
const plaintext = await decryptSecret(encrypted, PROVIDER_CREDENTIAL_KEY);
```

The encryption key (`PROVIDER_CREDENTIAL_KEY` / `NOTIFY_CREDENTIALS_SECRET`) is a required environment variable. Key rotation is supported via dual-key decryption.

The decrypted provider credential is a **typed envelope** (`polycred:v1:` + JSON, or a legacy raw string read as plain). Plain API keys are wrapped; OAuth tokens from the [Subscription OAuth](/openwiki/providers/subscription-oauth.md#credential-envelope) flow are stored as `kind: 'oauth'` envelopes that only the connect/refresh path can mint. See [Security & Auth](/openwiki/security/auth.md#credential-envelope) for the tamper-safety rules.

**Source**: `packages/shared/src/server/security/encryption.ts`, `packages/shared/src/server/security/credential-envelope.ts`

## Cascade Cost Ledger

For cascade routing, each escalation creates a `request_attempt` row:

```
request_log (the final accepted request)
  ├── request_attempt #1 (cheap tier attempt — superseded)
  └── request_attempt #2 (strong tier attempt — accepted)
```

This allows accurate cost attribution even when cascade escalates from a cheap to a strong model.

## Budget Enforcement

Budgets are enforced at the Redis level for real-time checking:

- **Scope**: `global` (all spend) or `agent` (specific agent)
- **Window**: `day`, `week`, `month` (UTC calendar boundaries)
- **Action**: `alert` (fire notification) or `block` (reject requests)

Redis counters are reconciled from the database periodically by the budget scheduler. The reconcile uses a monotonic Lua script (`RECONCILE_MAX_LUA`) to prevent counter regression.

**Source**: `packages/control-plane/src/budgets/`, `packages/control-plane/src/database/`

## Indexes

Key indexes for performance:

- `request_log`: `created_at`, `owner_user_id`, `agent_id`, `provider_id`, `model_id`
- `agent`: `owner_user_id`, `api_key_hash` (prefix index for fast lookup)
- `provider`: `owner_user_id`
- `routing_entry`: `tier_id`, `position`
- `model_price`: `model_id`, `effective_at`

## Migrations

Database migrations are managed by Drizzle and generated as part of the development workflow. Migrations are `prettier-ignore`d to prevent formatting changes from altering their content.
