# Tasks: add-database-and-tenancy

## 1. Dev infrastructure & config

- [x] 1.1 `docker-compose.dev.yml` at the repo root: postgres:16-alpine (polyrouter/polyrouter/polyrouter, port 5432) + redis:7-alpine (port 6379), named volumes; note in README-level docs that dev/e2e need `docker compose -f docker-compose.dev.yml up -d`
- [x] 1.2 Register `DATABASE_URL` (namespace `database`, postgres-URL validation, default `postgresql://polyrouter:polyrouter@localhost:5432/polyrouter`) and `REDIS_URL` (namespace `redis`, redis-URL validation, default `redis://localhost:6379`); config tests: defaults apply, invalid protocol fails naming the variable without echoing the value

## 2. Shared server entrypoint

- [x] 2.1 Add `src/server/index.ts` as a second tsup entry with an `exports` map entry for `./server` (CJS + ESM + d.ts); extend the boundary lint so `frontend` cannot reach server code in ANY form (`@polyrouter/shared/server`, deep subpaths, `**/shared/src/server/**`, `**/shared/dist/server*`); boundaries unit tests cover package, deep, and relative forms; unit test asserts the root entrypoint re-exports no server-only symbol
- [x] 2.2 Drizzle schema in `shared/src/server/db/schema.ts`: user (Better Auth-compatible), organization (stub), agent, provider, model (context_window, tools/vision/reasoning flags, per-1M prices, is_free, last_synced_at), tier, routing_entry, routing_rule — owner columns (`owner_user_id` required FK ON DELETE CASCADE, `org_id` nullable stub), FKs (model→provider, routing_entry→tier/model), constraints: unique email, unique api_key_prefix, `UNIQUE (owner_user_id, key)` on tier, `UNIQUE (provider_id, external_model_id)` on model, `position INTEGER NOT NULL` + non-null `tier_id`/`model_id` + `UNIQUE (tier_id, position)` + `CHECK (position BETWEEN 0 AND 4)` on routing_entry (§7.4 five-total cap, NULL cannot bypass it); text ids with `crypto.randomUUID()` defaults; export inferred row/insert types
- [x] 2.3 `Principal` union type + `ownershipPredicate(table, principal)` helper (single shared site; org branch throws naming the deferred org change) + the persistence injection token **typed as the scoped `PersistencePort`** (repositories, join-scoped accessors, `ensureDefaultTier`, `users.count()` — no query/execute/Pool/drizzle member on the type)

## 3. Database module & migrations

- [x] 3.1 `control-plane/src/database/`: pg Pool + drizzle providers **kept private** (not exported); module exports the shared persistence token (providing the scoped `PersistencePort`) and `withTransaction`/`withAdvisoryLock` **whose callbacks receive a transaction-bound `PersistencePort`, never raw drizzle**; tests: raw providers fail to resolve from outside, the token resolves in a consumer module importing only `@polyrouter/shared/server`, and no exported surface (port or tx callback argument) exposes query/execute/Pool/drizzle members
- [x] 3.2 drizzle.config.ts (schema from shared source, out `src/database/migrations`); generate + commit the initial migration; package scripts `db:generate`/`db:migrate` plus **root forwarding scripts** so CLAUDE.md's `npm run db:migrate` works verbatim; build copies `src/database/migrations` into `dist` and the migrator resolves the folder relative to the built entrypoint
- [x] 3.3 Run migrations programmatically at boot before the server binds; failure exits non-zero without binding (failing-migration fixture test); e2e: fresh database migrates on first boot, second boot no-ops (idempotency DoD), and the **built** entrypoint (`npm start`) migrates a fresh database successfully

## 4. Tenant-scoping guard

- [x] 4.1 `createOwnedRepository(db, table)` over an `OwnedTable` shape: `findById/list/insert/update/remove`, all principal-scoped; insert forces owner columns from the principal; **update strips/rejects `id`/`owner_user_id`/`org_id` at type level and runtime**; update/remove return not-found on zero rows; no unscoped by-id method anywhere on the API
- [x] 4.2 Repository providers for agent/provider/tier/routing_rule; join-scoped accessors for model (via provider) and routing_entry (via tier + model) whose **inserts atomically validate parent ownership** (transactional ownership-filtered insert; FKs make racing parent deletes fail closed), whose updates treat `provider_id`/`tier_id`/`model_id` as immutable, and whose deletes are join-scoped single statements; `ensureDefaultTier(principal)` as an idempotent upsert on `UNIQUE (owner_user_id, key)`
- [x] 4.3 Unit tests alongside: generated SQL contains the ownership predicate for every method (`.toSQL()` inspection); forged-owner insert is overridden; forged-owner/id update is stripped; parent-FK fields stripped from parent-owned updates; org principal throws naming the deferred change

## 5. Secret encryption

- [x] 5.1 `shared/src/server/security/encryption.ts`: `encryptSecret`/`decryptSecret` (AES-256-GCM, random IV, `poly-enc:v1:<iv>:<tag>:<ciphertext>` envelope, 32-byte-hex key validation)
- [x] 5.2 Vitest coverage alongside: round-trip; two encryptions of one plaintext differ; tamper (flip a ciphertext/tag byte) throws; wrong key throws; error messages/stacks contain neither plaintext, key, nor envelope body (never-leak DoD)

## 6. Tenancy & infrastructure e2e

- [x] 6.1 `control-plane/test/tenancy/harness.ts`: boots the app against the dev database (migrations included), `createTestPrincipal()` fabricating user rows directly, cleanup between runs; unreachable database fails the suite with the compose command in the message (no silent skip)
- [x] 6.2 `tenancy.e2e-spec.ts`: for agent, provider, tier, routing_rule — cross-tenant `findById`/`update`/`remove` return not-found and leave the victim row unchanged; forged-owner update cannot transfer a row; **cross-tenant parenting fails closed** (model under B's provider; routing entry linking A's tier to B's model and B's tier to any model); parent FKs cannot be repointed; same-tenant paths succeed (cross-tenant DoD)
- [x] 6.3 Constraint + provisioning e2e: sixth routing_entry, out-of-range position, and NULL position rejected by the database, including under concurrent inserts; duplicate `(provider_id, external_model_id)` rejected; `ensureDefaultTier` concurrent invocations yield exactly one `default` tier
- [x] 6.4 Redis client e2e: injected client PINGs against the compose redis; app shutdown quits the connection (no open-handle warnings from Jest)

## 7. Verification & bookkeeping

- [x] 7.1 `npm run build`, all unit suites, `npm run test:e2e` (with dev compose up), `npm run lint` green; strict TS clean
- [x] 7.2 Changeset (user-facing: persistence layer + dev compose); TODOS.md board row #2 updated
