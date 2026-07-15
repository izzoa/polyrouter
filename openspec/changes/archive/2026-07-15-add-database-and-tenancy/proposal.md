# Proposal: add-database-and-tenancy

> Implements **TODOS.md #2 `add-database-and-tenancy`** — spec.md **§5** (data model), **§11.1** (tenant isolation), **§12** (config), **§14.2** (control-plane skeleton milestone). CLAUDE.md invariants **5** (central tenant scoping) and **8** (secrets encrypted at rest).

## Why

Everything from auth (#3) onward needs a database, and spec §11.1 is blunt about the failure mode: CRUD built without a *central* ownership guard leaks other tenants' rows by id (IDOR). This change lands the identity/config schema, migrations-on-boot, Redis wiring, the tenant-scoping guard, and the secret-encryption utility **before** any endpoint exists — so no later change can accidentally ship an unscoped query or a plaintext credential.

## What Changes

- **Drizzle + PostgreSQL 16 schema** for the identity/config core: `User` (Better Auth-compatible columns so #3 plugs its adapter onto it), `Organization` (schema-only stub — the feature is deferred), `Agent`, `Provider`, `Model` (columns enumerated per §5, `UNIQUE (provider_id, external_model_id)` for #7's idempotent sync), `Tier` (`UNIQUE (owner, key)`), `RoutingEntry` (ordered; the §7.4 **five-models-per-tier cap enforced at the schema level** via `CHECK position 0–4` + `UNIQUE (tier_id, position)`), `RoutingRule`. Owner columns (`owner_user_id`, nullable `org_id`) + indexes per §5. **Feature-owned tables are NOT here** (ModelPrice → #8, RequestLog → #11, NotificationChannel → #15, Limit → #16).
- **Migrations generated with drizzle-kit and run on boot** (fail-fast on migration error, idempotent re-runs); `npm run db:generate` / `npm run db:migrate` scripts per CLAUDE.md.
- **Central tenant-scoping guard**: a `Principal` union type (user implemented now; org handled by the deferred org change) plus a scoped-repository factory over owned tables — `findById/list/insert/update/remove` all take a principal and append the ownership predicate; **no unscoped by-id method exists**, `id`/owner columns are **immutable through the API** (insert sets the owner from the principal; update strips ownership fields), and the database module **does not export raw Pool/drizzle handles** — only repositories plus explicit `withTransaction`/`withAdvisoryLock` facilities (needed by #3). A `@polyrouter/shared/server` DB injection token defines the persistence seam the data-plane (#10/#11) consumes without importing control-plane. Cross-tenant/IDOR e2e harness established as the reusable pattern.
- **Secret-encryption utility** (AES-256-GCM, pure functions, key passed in): used by #7 (provider credentials) and #15 (channel config); guarantees error paths never contain plaintext or key material.
- **Redis wiring**: ioredis client as a Nest module with lifecycle (BullMQ-compatible for #15), `REDIS_URL` registered/validated.
- **Config**: `DATABASE_URL` / `REDIS_URL` registered in the #1 framework with URL validation and localhost defaults matching a new **`docker-compose.dev.yml`** (postgres:16 + redis:7 — dev/test infrastructure, distinct from #22's product packaging).
- **`@polyrouter/shared` gains a server-only `./server` entrypoint** hosting the schema, principal types, and encryption util.

## Capabilities

### New Capabilities

- `database-schema`: the §5 identity/config tables, migrations-on-boot behavior, drizzle commands, and the db module.
- `tenant-isolation`: the principal abstraction, the scoped-repository guard, and the cross-tenant test harness.
- `secret-encryption`: the encrypt-at-rest utility and its never-leak guarantees.
- `redis-wiring`: the shared Redis client module, config, and lifecycle.

### Modified Capabilities

- `monorepo-workspace`: the shared package's build contract gains a second, server-only entrypoint (`@polyrouter/shared/server`) that backend packages may import and `frontend` must not.

## Impact

- **Code:** `packages/shared/src/server/**` (schema, principal, encryption — new entrypoint), `packages/control-plane/src/database/**` (pool, migrator, module, migrations dir per §4), Redis module, `docker-compose.dev.yml`, drizzle config + scripts. New deps: `drizzle-orm` + `drizzle-kit`, `pg`, `ioredis`.
- **Deviation flagged (not silent):** spec §4 places `entities/` inside `control-plane/src/`. The schema lives in `@polyrouter/shared/server` instead, because the data-plane (#10/#11 proxy + RequestLog writer) must read/write these tables and the workspace dependency matrix forbids `data-plane → control-plane`. §5 marks the model "[partly design inference] — adjust freely"; the migrations directory itself stays in `control-plane/src/database/migrations` per §4.
- **Downstream:** #3 consumes the User table + principal; every CRUD change from #6 on uses the scoped repository and the IDOR harness; #7/#15 use the encryption util; #8+ use the Redis module.

## Non-goals

- **No auth** — no Better Auth, sessions, or API keys (#3); the e2e harness fabricates principals directly.
- **No business endpoints** — no controllers/CRUD beyond what tests need internally.
- **No org/team feature** — Organization is schema + principal-abstraction readiness only (deferred entry in TODOS.md).
- **No default-tier seeding at signup** — tiers are owned rows and no signup exists yet; the **idempotent, concurrency-safe `ensureDefaultTier(principal)` contract ships and is tested here** (backed by `UNIQUE (owner, key)`), and #3 invokes it at user creation.
- **No feature-owned tables** (ModelPrice/RequestLog/NotificationChannel/Limit) and **no pricing data** (#8).
- **No Redis counters/breakers/queues** — just the client (owners: #6, #16, #15).
