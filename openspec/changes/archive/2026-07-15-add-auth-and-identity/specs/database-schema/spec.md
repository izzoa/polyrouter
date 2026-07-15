# database-schema — delta

## MODIFIED Requirements

### Requirement: Identity and config schema per the reference data model
The system SHALL define Drizzle/PostgreSQL tables for the spec §5 identity/config core: `user` (Better Auth-compatible columns: text id, name, unique email, email_verified, image, timestamps), `organization` (stub: id, name, owner_user_id), `agent` (owner, name, api_key_hash, api_key_prefix, harness_type, created_at, last_used_at), `provider` (owner, name, kind, protocol, base_url, encrypted_credentials, status, created_at), `model` (provider_id, external_model_id, display_name, context_window, tools/vision/reasoning capability flags, input_price_per_1m, output_price_per_1m, is_free, last_synced_at), `tier` (owner, key, display_name, description), `routing_entry` (tier_id ↔ model_id with ordered position), and `routing_rule` (owner, match_type, header_name defaulting to `x-polyrouter-tier`, header_value, target, priority) — plus the **complete auth-plane tables in Better Auth 1.6.23 shapes** (pinned; generated SQL diffed against the 1.6.23 CLI snapshot): `session` (id, token unique, expires_at, created_at, updated_at, ip_address, user_agent, user_id FK cascade, index on user_id), `account` (id, account_id, provider_id, user_id FK cascade, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, `password` for the scrypt credential, created_at, updated_at, index on user_id), and `verification` (id, identifier, value, expires_at, created_at, updated_at, index on identifier). Better Auth's drizzle adapter SHALL receive an explicit singular-model→plural-table map. Every directly-owned table SHALL carry `owner_user_id` (required) and `org_id` (nullable stub). Feature-owned tables (ModelPrice, RequestLog, NotificationChannel, Limit) SHALL NOT be created by this capability.

#### Scenario: Schema supports the §5 relationships
- **WHEN** the migrations have run
- **THEN** models reference their provider, routing entries join tiers to models with a position, and unique/index constraints cover email, agent key prefix, and per-owner tier keys

#### Scenario: Schema is importable by both planes
- **WHEN** `control-plane` or `data-plane` imports table definitions from `@polyrouter/shared/server`
- **THEN** the import resolves without violating the workspace dependency matrix (no `data-plane → control-plane` edge)

#### Scenario: Auth-plane tables serve Better Auth
- **WHEN** Better Auth's drizzle adapter is pointed at the `user`/`session`/`account`/`verification` tables
- **THEN** signup, session issuance, and session validation operate without schema mapping errors
