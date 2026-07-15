# database-schema — delta

## ADDED Requirements

### Requirement: Identity and config schema per the reference data model
The system SHALL define Drizzle/PostgreSQL tables for the spec §5 identity/config core: `user` (Better Auth-compatible columns: text id, name, unique email, email_verified, image, timestamps), `organization` (stub: id, name, owner_user_id), `agent` (owner, name, api_key_hash, api_key_prefix, harness_type, created_at, last_used_at), `provider` (owner, name, kind, protocol, base_url, encrypted_credentials, status, created_at), `model` (provider_id, external_model_id, display_name, context_window, tools/vision/reasoning capability flags, input_price_per_1m, output_price_per_1m, is_free, last_synced_at), `tier` (owner, key, display_name, description), `routing_entry` (tier_id ↔ model_id with ordered position), and `routing_rule` (owner, match_type, header_name defaulting to `x-polyrouter-tier`, header_value, target, priority). Every directly-owned table SHALL carry `owner_user_id` (required) and `org_id` (nullable stub). Feature-owned tables (ModelPrice, RequestLog, NotificationChannel, Limit) SHALL NOT be created by this capability.

#### Scenario: Schema supports the §5 relationships
- **WHEN** the migrations have run
- **THEN** models reference their provider, routing entries join tiers to models with a position, and unique/index constraints cover email, agent key prefix, and per-owner tier keys

#### Scenario: Schema is importable by both planes
- **WHEN** `control-plane` or `data-plane` imports table definitions from `@polyrouter/shared/server`
- **THEN** the import resolves without violating the workspace dependency matrix (no `data-plane → control-plane` edge)

### Requirement: Downstream-critical constraints are enforced by the database
The schema SHALL enforce, concurrency-safely at the database: the five-models-per-tier cap **total** (spec §7.4 — `position INTEGER NOT NULL` with `CHECK (position BETWEEN 0 AND 4)` plus `UNIQUE (tier_id, position)` on `routing_entry`, with non-null `tier_id` and `model_id` — nullability must not void the cap), idempotent catalog sync (`UNIQUE (provider_id, external_model_id)` on `model`), and one tier per key per owner (`UNIQUE (owner_user_id, key)` on `tier`).

#### Scenario: A sixth model in a tier is rejected
- **WHEN** a sixth `routing_entry` row — or any row with a position outside 0–4, or a NULL position — is inserted for one tier, including concurrently
- **THEN** the database rejects it via the position constraints

#### Scenario: Duplicate external model is rejected
- **WHEN** the same `(provider_id, external_model_id)` pair is inserted twice
- **THEN** the second insert violates the unique constraint (catalog sync can upsert idempotently)

### Requirement: Default tier provisioning contract
`ensureDefaultTier(principal)` SHALL idempotently guarantee exactly one `default` tier for a **user** principal (an upsert backed by `UNIQUE (owner_user_id, key)`), safe under concurrent invocation; org principals follow the guard's reserved-variant rule (throw until the deferred org change). The auth change (#3) invokes it at user creation, satisfying spec §5's "ships with `default` seeded".

#### Scenario: Provisioning is idempotent and race-safe
- **WHEN** `ensureDefaultTier` runs repeatedly — including concurrently — for one principal
- **THEN** exactly one `default` tier row exists for that principal afterwards

### Requirement: Migrations run on boot and are idempotent
Drizzle-kit-generated SQL migrations SHALL be committed under `packages/control-plane/src/database/migrations/` and applied programmatically at boot **before the HTTP server binds**; a migration failure SHALL fail the boot (non-zero exit). Re-running boot against an up-to-date database SHALL be a no-op. The production build SHALL be self-contained: migration assets are copied into `dist` and the migrator resolves them relative to the built entrypoint.

#### Scenario: Fresh database is migrated on first boot
- **WHEN** the app boots against an empty database
- **THEN** all migrations apply and the schema is complete before any request can be served

#### Scenario: Boot is idempotent
- **WHEN** the app boots a second time against the same database
- **THEN** no migration re-applies and boot succeeds

#### Scenario: The built app migrates too
- **WHEN** the production entrypoint (`npm start` against `dist`) boots against a fresh database
- **THEN** migrations resolve from the build output and apply before the port binds

#### Scenario: A failing migration blocks serving
- **WHEN** a migration fails to apply
- **THEN** the process exits non-zero without ever binding the HTTP port

### Requirement: Database connectivity is configured and maintained
`DATABASE_URL` SHALL be registered in the config framework (namespace `database`) with URL/protocol validation and a loopback default matching the dev compose file (`postgresql://polyrouter:polyrouter@localhost:5432/polyrouter`). The maintained commands SHALL match CLAUDE.md verbatim: `npm run db:generate -w packages/control-plane` and a root `npm run db:migrate` (root forwarding scripts provided for both). A `docker-compose.dev.yml` SHALL provide postgres:16 and redis:7 for development and tests.

#### Scenario: Zero-config dev database
- **WHEN** the dev compose services are up and the app boots with no `DATABASE_URL` set
- **THEN** it connects to the dev database via the default URL and serves normally

#### Scenario: Invalid database URL fails fast
- **WHEN** `DATABASE_URL` is set to a non-postgres URL
- **THEN** boot exits non-zero naming `DATABASE_URL` without echoing the value
