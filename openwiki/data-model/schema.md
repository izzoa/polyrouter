---
type: Reference
title: Data Model & Database Schema
description: Polyrouter's PostgreSQL schema — 13 core tables covering identity, routing configuration, request logging, pricing, budgets, and notifications with tenant isolation and immutable cost records.
tags: [database, schema, postgresql, drizzle, tenant-isolation]
resource: packages/shared/src/server/database/
---

# Data Model & Database Schema

Polyrouter uses PostgreSQL 16 with Drizzle ORM. The schema has 13 core tables organized into four domains: identity, routing, observability, and budgets/notifications.

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
| `user` | Better Auth users | `id`, `email`, `name`, `password_hash` |
| `session` | JWT sessions | `id`, `user_id`, `expires_at`, `token` |
| `account` | OAuth provider links | `id`, `user_id`, `provider`, `provider_account_id` |
| `agent` | API keys (`poly_...`) | `id`, `owner_user_id`, `name`, `api_key_hash`, `harness_type` |

### Routing Configuration

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `provider` | LLM providers | `id`, `owner_user_id`, `name`, `kind`, `protocol`, `base_url`, `credentials_encrypted` |
| `model` | Available models | `id`, `provider_id`, `external_id`, `capabilities` (tools, vision, reasoning) |
| `tier` | Routing tiers | `id`, `owner_user_id`, `name`, `is_default` |
| `routing_entry` | Tier↔model chains | `id`, `tier_id`, `model_id`, `provider_id`, `position` (0-4) |
| `routing_rule` | Header/default rules | `id`, `owner_user_id`, `priority`, `header_name`, `header_value`, `tier_id` |
| `routing_settings` | Per-tenant auto-layer prefs | `owner_user_id`, `structural_enabled`, `cascade_enabled` |

### Observability

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `request_log` | Immutable cost records | `id`, `owner_user_id`, `agent_id`, `provider_id`, `model_id`, `input_tokens`, `output_tokens`, `cost_micro_usd`, `price_snapshot`, `decision_layer`, `latency_ms`, `status` |
| `request_attempt` | Per-attempt cost ledger | `id`, `request_log_id`, `provider_id`, `model_id`, `outcome`, `latency_ms` |
| `model_price` | Effective-dated pricing | `id`, `model_id`, `effective_at`, `input_price_per_mtok`, `output_price_per_mtok` |

### Budgets & Notifications

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `budget` | Spend limits | `id`, `owner_user_id`, `scope` (global/agent), `scope_id`, `window` (day/week/month), `action` (alert/block), `limit_micro_usd` |
| `notification_channel` | Alert channels | `id`, `owner_user_id`, `type` (smtp/apprise), `name`, `config_encrypted`, `events_subscribed` |

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

**Source**: `packages/shared/src/server/security/encryption.ts`

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
