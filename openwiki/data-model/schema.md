---
type: Reference
title: Data Model & Database Schema
description: Polyrouter's PostgreSQL schema — identity, routing configuration, request logging, pricing, budgets, notifications, body capture, semantic learning, and L2 telemetry with tenant isolation, immutable cost records, and the all-or-none semantic telemetry quartet.
tags: [database, schema, postgresql, drizzle, tenant-isolation, semantic, learning]
resource: packages/shared/src/server/database/
---

# Data Model & Database Schema

Polyrouter uses PostgreSQL 16 with Drizzle ORM. The schema is organized into six domains: identity, routing, observability, budgets/notifications, body capture, and semantic learning. Migrations run on boot (`npm run db:migrate` in dev, automatic in production).

## Design Principles

- **Tenant isolation** — `owner_user_id` on every owned table; all queries scoped via `WHERE owner = current_principal`
- **Immutable cost records** — prices snapshotted at request time, never recomputed
- **Append-only audit** — `request_log` survives provider/model deletion (denormalized IDs)
- **Encrypted credentials** — provider and channel credentials encrypted at rest with AES-256-GCM
- **Cascading deletes** — FK constraints with `ON DELETE CASCADE` for clean tenant data removal
- **Bound by CHECK constraints** — out-of-range numeric values, invalid enum strings, and inconsistent state combinations fail at the DB level (not just the application layer)

## Schema Overview

### Identity & Auth

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `user` | Better Auth users | `id`, `email`, `name`, `password_hash`, `role`, `disabled` |
| `session` | JWT sessions | `id`, `user_id`, `expires_at`, `token` |
| `account` | OAuth provider links | `id`, `user_id`, `provider`, `provider_account_id` |
| `agent` | API keys (`poly_...`) | `id`, `owner_user_id`, `name`, `api_key_hash`, `harness_type`, `body_capture_override` |
| `invite` | Single-use account invites | `id`, `email`, `token_prefix`, `token_hash`, `role`, `expires_at`, `consumed_at` |
| `instance_settings` | Instance-wide runtime settings (singleton row) | `registration_mode`, `bootstrap_claimed_at` |

`invite` stores only the token prefix + HMAC-style hash (like agent keys) — never the raw token. `instance_settings.bootstrap_claimed_at` decides the first-signup-wins admin race atomically; `registration_mode` (`invite_only`/`open`) is read authoritatively per signup attempt. See [Security & Auth](/openwiki/security/auth.md#dashboard-sessions-web-plane).

### Routing Configuration

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `provider` | LLM providers | `id`, `owner_user_id`, `name`, `kind`, `protocol`, `base_url`, `credentials_encrypted`, `oauth_preset`, `credential_expires_at`, `credential_error`, `max_tokens_spelling`, `first_byte_timeout_ms`, `idle_timeout_ms` |
| `model` | Available models | `id`, `provider_id`, `external_id`, `capabilities`, `input/output_price_per_1m`, `listed_*` display estimates |
| `tier` | Routing tiers | `id`, `owner_user_id`, `key`, `display_name` |
| `routing_entry` | Tier↔model chains | `id`, `tier_id`, `model_id`, `provider_id`, `position` (0-4) |
| `routing_rule` | Header/default rules | `id`, `owner_user_id`, `priority`, `header_name`, `header_value`, `tier_id` |
| `routing_settings` | Per-tenant auto-layer prefs | `owner_user_id`, `structural_enabled`, `cascade_enabled`, `semantic_enabled`, `semantic_learning_enabled`, `semantic_learning_epoch`, `semantic_learning_generation`, calibration cols |

**Provider `max_tokens_spelling`** (`add-max-tokens-spelling`): `text NOT NULL DEFAULT 'auto'` — `auto` derives the outgoing wire field from provider kind (`local` → `max_tokens`, else `max_completion_tokens`); explicit values `max_completion_tokens` | `max_tokens` override. Inbound always accepts either.

**Provider per-call timeouts** (`add-long-call-timeouts`): `first_byte_timeout_ms` and `idle_timeout_ms` (`integer`, NULL = inherit env defaults), CHECK-constrained to `[1000, 3600000]` (1 s to 1 h). Used for research-class models whose prefill exceeds the global defaults.

**Subscription OAuth columns** (provider): `oauth_preset` names the bundled preset (`claude`/`chatgpt`) for an OAuth-connected provider; `credential_expires_at` mirrors the access token's expiry for the UI (never an auth input — the encrypted envelope is authoritative); `credential_error` is the durable credential state the dashboard reads after reload (`reauthorize_required`). All three are non-secret — tokens live only inside the encrypted envelope.

**Listed price columns** (model): `listed_input_price_per_1m`, `listed_output_price_per_1m`, `listed_is_free`, `listed_price_captured_at` — a display-only estimate captured from the provider's `/models` endpoint at sync. Deliberately distinct from the user-price columns: these **never** feed `resolveModelPrice`, the `model_price` catalog, or the request-time cost snapshot. Rewritten on every sync; cleared on a base URL or protocol change.

**Semantic columns on `routing_settings`** (`add-semantic-routing`, `add-semantic-learning`):

- `semantic_enabled boolean NOT NULL DEFAULT true` — per-tenant opt-in for Layer 2 (effective = `cap ∧ pref`).
- `semantic_learning_enabled boolean NOT NULL DEFAULT false` — per-tenant opt-in for the L2 learning loop. CHECK constraint enforces `semantic_learning_enabled → semantic_enabled`.
- `semantic_learning_epoch integer NOT NULL DEFAULT 0` — revocation epoch; bumped on revert so any in-flight sweep's CAS fails and every reader gates out the stale epoch.
- `semantic_learning_generation integer NOT NULL DEFAULT 0` — incremented on each successful apply; part of the active-state gate.

**Calibration columns** (`add-auto-threshold-calibration`): `calibration_enabled`, `calibrated_high`, `calibrated_low`, `calibrated_anchor_high`, `calibrated_anchor_low`, `calibration_epoch`. Per-tenant calibrated structural thresholds with anchor columns and a one-click revert that bumps the calibrated pair back to instance defaults.

### Observability

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `request_log` | Immutable cost records | `id`, `owner_user_id`, `agent_id`, `provider_id`, `model_id`, `input_tokens`, `output_tokens`, `cost_micro_usd`, `price_snapshot`, `decision_layer`, `routing_header_name`, `routing_header_value`, `latency_ms`, `status`, `routing_reason`, structural/semantic/calibration telemetry |
| `request_attempt` | Per-attempt cost ledger | `id`, `request_log_id`, `provider_id`, `model_id`, `outcome`, `latency_ms` |
| `model_price` | Effective-dated pricing | `id`, `model_id`, `effective_at`, `input_price_per_mtok`, `output_price_per_mtok` |

**Routing header visibility** (`add-routing-header-visibility`): `request_log.routing_header_name` and `routing_header_value` record which header chose the route. Set only on `decision_layer='header'` rows. The built-in tier header records name + matched tier key; custom rules record name only (value is null — a configured header value can be a credential and is never persisted). A CHECK constraint enforces value-requires-name.

**Structural telemetry** (`add-auto-decision-telemetry`): `request_log.structural_band`, `structural_score`, `structural_dimension`, `structural_reason` — written on every evaluated row (including ambiguous/unroutable fall-throughs), no silent telemetry. `structural_epoch` records the decision-time calibration epoch.

**Semantic telemetry quartet** (`add-semantic-routing`): `request_log.semantic_band`, `semantic_score`, `semantic_source`, `semantic_revision` — written on every Layer-2-evaluated row. **All-or-none**: a CHECK constraint enforces that all four are populated together or all are null. The bundle/content-derived revision identifies the embedder and anchor set that produced the verdict; `source` distinguishes `bundled` from `learned`.

**Calibration telemetry** (`add-auto-threshold-calibration`): `request_log.calibration_epoch` — the calibration epoch at decision time, stamped on every structurally evaluated row.

### Budgets, Notifications & Body Capture

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `budget` | Spend limits | `id`, `owner_user_id`, `scope`, `scope_id`, `window`, `action`, `limit_micro_usd` |
| `notification_channel` | Alert channels | `id`, `owner_user_id`, `type`, `name`, `config_encrypted`, `events_subscribed` |
| `body_capture_settings` | Per-tenant body capture config | `owner_user_id`, `mode`, `retention_days`, `capture_epoch`, `dropped_count`, `last_purge_at`, `last_purge_count` |
| `request_body` | Captured prompt/response bodies | `id`, `request_log_id` (FK CASCADE), `direction`, `content_encrypted`, `bytes`, `truncated`, `partial` |
| `request_body_tombstone` | Deletion tombstones | `request_log_id` (PK, FK CASCADE), `owner_user_id` |

**Body capture** (`add-body-capture`) is an opt-in feature, **off by default**. When enabled (`errors_only` or `all`), prompt and response bodies are captured, encrypted with the same `PROVIDER_CREDENTIAL_KEY` as provider credentials, and stored alongside the request log. The `request_body` rows are deletable operational data (not audit) — FK CASCADE with the parent `request_log`. The `capture_epoch` column is a deletion-revocation counter: purge-all or disable-with-purge bumps it under a `FOR UPDATE` lock, and the writer's guarded insert re-reads it post-lock to discard stale drafts. A `request_body_tombstone` prevents queued/retrying writes from resurrecting deleted bodies. Bodies are purged daily by a BullMQ scheduler (03:30 UTC) per-owner retention window; infinite retention requires an explicit `keepForever` choice. The feature is **selfhosted-only** (`MODE=selfhosted`) — cloud instances never arm capture.

### Semantic Learning

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `semantic_learning_event` | Per-tenant audit of L2 learning sweep | `id`, `owner_user_id`, `occurrence_id` (UNIQUE), `trigger`, `epoch`, `generation`, `high_samples`, `low_samples`, `high_drift`, `low_drift`, `high_similarity`, `low_similarity`, `reason`, `created_at` |

**`trigger`** is constrained to `'apply' | 'discard_revision' | 'revert'`:

- `apply` — sweep folded fresh evidence into the active centroid, CAS-committed a generation bump, and promoted the Redis stage
- `discard_revision` — sweep deleted stale-revision pending buckets and active state (a config change made the old evidence mean different things); no generation bump
- `revert` — user-initiated one-click revert (bumps the revocation epoch, fences the stale learned state)

The audit row carries scalars only — counts, drift cosine distances, similarity cosine values — **never** raw embedding bytes or prompt text. All CHECK constraints enforce valid triggers, non-negative sample counts, and drift bounds `[0, 2]`.

**Crash-atomicity** is split across Redis and Postgres: the sweep writes the Postgres CAS + audit commit first, then promotes the Redis stage via `PROMOTE_LUA` keyed to the just-committed `(epoch, generation)`. A concurrent revert makes the CAS fail (`stale`) and no promote happens. A retry after the active is already at the expected coordinates returns `true` (idempotent).

## Tenant Isolation

Every table with `owner_user_id` is scoped at query time:

```typescript
// Shared guard pattern
function ownershipPredicate(owner: string) {
  return eq(table.owner_user_id, owner);
}
```

The `userPrincipal` type ensures tenancy is enforced at the type level — you can't construct a query without an owner. Cross-tenant read tests verify isolation across all endpoints. FK constraints with `ON DELETE CASCADE` ensure clean tenant data removal when a user is deleted (admins excepted — last enabled admin cannot be deleted).

Source: `packages/shared/src/server/database/tenancy.ts`.

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

Source: `packages/shared/src/server/pricing/`.

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

Source: `packages/shared/src/server/security/encryption.ts`, `packages/shared/src/server/security/credential-envelope.ts`.

## Cascade Cost Ledger

For cascade routing, each escalation creates a `request_attempt` row:

```
request_log (the final accepted request)
  ├── request_attempt #1 (cheap tier attempt — superseded)
  └── request_attempt #2 (strong tier attempt — accepted)
```

This allows accurate cost attribution even when cascade escalates from a cheap to a strong model. Outcome values are constrained: `accepted | superseded | cheap_error | provider_fault`.

## Budget Enforcement

Budgets are enforced at the Redis level for real-time checking:

- **Scope**: `global` (all spend) or `agent` (specific agent)
- **Window**: `day`, `week`, `month` (UTC calendar boundaries)
- **Action**: `alert` (fire notification) or `block` (reject requests)

Redis counters are reconciled from the database periodically by the budget scheduler. The reconcile uses a monotonic Lua script (`RECONCILE_MAX_LUA`) to prevent counter regression.

Source: `packages/control-plane/src/budgets/`, `packages/control-plane/src/database/`.

## Indexes

Key indexes for performance:

- `request_log`: `created_at`, `owner_user_id`, `agent_id`, `provider_id`, `model_id`, `(decision_layer, semantic_band)`, `(owner_user_id, created_at)`
- `agent`: `owner_user_id`, `api_key_hash` (prefix index for fast lookup), `api_key_prefix` (UNIQUE)
- `provider`: `owner_user_id`
- `routing_entry`: `tier_id`, `position`
- `model_price`: `model_id`, `effective_at`
- `semantic_learning_event`: `owner_user_id`, `created_at`; UNIQUE `occurrence_id`

## Migrations

Database migrations are managed by Drizzle and generated as part of the development workflow:

```bash
npm run db:generate -w packages/control-plane   # generate a new migration
npm run db:migrate                              # apply pending migrations
```

Migrations are `prettier-ignore`d to prevent formatting changes from altering their content. Migrations run on boot, so production upgrades are atomic with the deploy. As of v0.8.0:

- `0018` (unknown_mantis) — long-call-timeouts columns on `provider`
- `0019` (vengeful_sentry) — L1→L2 routing reason trail plumbing
- `0020` (lame_kronos) — semantic learning enabled / epoch / generation on `routing_settings` + CHECK
- `0021` (luxuriant_magus) — `max_tokens_spelling` on `provider`
- `0022` (dashing_queen_noir) — `semantic_learning_event` table with constraints and indexes

The migration journal lives in `packages/control-plane/src/database/migrations/meta/_journal.json`. Each migration's snapshot is in the same `meta/` directory.