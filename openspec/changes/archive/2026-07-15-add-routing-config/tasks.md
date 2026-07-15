# Tasks: add-routing-config

> Build order: shared target helper + constants → persistence `replaceForTier` → service → DTOs → controllers/module → tests. No schema/migration (tables + cap exist since #2). Tenant-isolation, cap, and ordering tests land with the code they cover.

## 1. Shared routing helpers (pure)

- [x] 1.1 Add `packages/shared/src/server/routing/constants.ts`: `DEFAULT_TIER_KEY='default'`, `TIER_HEADER_NAME='x-polyrouter-tier'`, `AUTO_ALIAS='auto'`, `MAX_MODELS_PER_TIER=5`, `TIER_KEY_PATTERN` (lowercase slug, e.g. `^[a-z0-9](?:[a-z0-9_-]{0,63})$`).
- [x] 1.2 Add `packages/shared/src/server/routing/target.ts`: `RoutingTarget = {kind:'tier';key} | {kind:'model';id}`, `parseRoutingTarget(s) → RoutingTarget | null` (null on malformed, never throws), `formatRoutingTarget(t) → string`. Export both files from `@polyrouter/shared/server` (`server/index.ts`).
- [x] 1.3 Add `packages/shared/test/routing-target.test.ts` (Vitest): round-trip `tier:`/`model:`; malformed (no prefix, empty ref, whitespace) → null; keys/ids preserved verbatim.

## 2. Persistence: atomic replace accessor

- [x] 2.1 Add to `RoutingEntryAccessor` (shared `persistence.ts`): `replaceForTier(principal, tierId, orderedModelIds) → ReplaceEntriesResult` (`{status:'ok';entries} | {status:'tier_not_found'} | {status:'unknown_models';modelIds}`). Document immutability of the atomic replace.
- [x] 2.2 Implement in `control-plane/src/database/port.ts`: one transaction — `SELECT … FOR UPDATE` the owned tier row (serializes concurrent replacements against the non-deferrable `UNIQUE(tier_id,position)`; else `tier_not_found`); verify every id is an owned model, collect misses (else `unknown_models`); `DELETE` all entries for the tier, insert `0..N-1`, return rows. Reuse existing `ownershipPredicate`/`ownedProviderIds` helpers.
- [x] 2.3 Extend the tenancy port e2e (`test/tenancy/…`): `replaceForTier` replaces atomically, orders `0..N-1`, rejects an unowned/nonexistent model as a unit (no partial write), returns `tier_not_found` for another tenant's tier, and **two concurrent replacements of the same tier both resolve** (row lock serializes them; no position-uniqueness error).

## 3. Service

- [x] 3.1 Add `routing-config/routing-config.service.ts` (`@Injectable`, injects `PERSISTENCE_PORT` + `PERSISTENCE_FACILITIES`). Tiers: `listTiers`/`createTier`/`getTier`/`updateTier`/`deleteTier` — reject reserved (`auto`) and malformed keys, surface unique-key conflict as 409, forbid deleting/renaming `default`, `key` immutable on update.
- [x] 3.2 Entries: `listEntries(principal, tierId)` (404 if tier unowned; ordered, with model info) and `replaceEntries(principal, tierId, modelIds)` — validate length ≤ `MAX_MODELS_PER_TIER` and no duplicates (422) *before* calling `replaceForTier`; map `tier_not_found`→404, `unknown_models`→422.
- [x] 3.3 Rules: `listRules` (sorted `priority` desc, then `created_at`, `id` — a total order for deterministic #10 resolution) / `createRule` / `getRule` / `updateRule` / `deleteRule` — validate `target` via `parseRoutingTarget`, resolve `tier:` against the caller's tiers (by key) and `model:` against `models.findById` (422 on miss/malformed); require `header_value` for `header` rules; normalize `header_name` to a lower-cased HTTP field-name token; validate the **effective merged** row on PATCH (a rule can't be edited into `header`-without-`header_value`). `toSafe*` mappers for all responses.

## 4. DTOs, controllers, module

- [x] 4.1 Add `routing-config/routing-config.dto.ts` (class-validator): `CreateTierDto`/`UpdateTierDto` (key pattern + length; display fields optional; no `key` on update), `ReplaceEntriesDto` (`modelIds: string[]`, `@ArrayMaxSize(5)`, `@IsString({each})`). `CreateRuleDto`: `match_type` `@IsIn` and `target` required; `header_name`/`header_value`/`priority` optional with documented defaults; `priority` `@IsInt` **bounded to a safe non-negative range (`@Min(0)` `@Max(1_000_000)`)** so it can't overflow the `int4` column into a 500. `UpdateRuleDto`: **every field optional** (required for effective-merge PATCH), same per-field validators/bounds. Effective-row and target validation live in the service.
- [x] 4.2 Add `tiers.controller.ts` (`api/routing/tiers`, incl. `GET`/`PUT :tierId/entries`) and `rules.controller.ts` (`api/routing/rules`), using `@CurrentPrincipal()`; `routing-config.module.ts` (`imports:[DatabaseModule]`, both controllers, the service); register `RoutingConfigModule` in `app.module.ts`.

## 5. Tests

- [x] 5.1 Add `routing-config/routing-config.service.spec.ts` (Jest, fake port + facilities): reserved/duplicate key handling, default-tier protection, key immutability, entries cap/dedupe/ownership mapping (404 vs 422), rule target validation (owned tier/model vs miss/malformed), `header_name` normalization, effective-merged PATCH validation, and deterministic rule list ordering.
- [x] 5.2 Add `test/routing/routing-config.e2e-spec.ts` (real Postgres, stub `x-test-user` guard; seed each user's provider+models and `default` tier via the port): full tier CRUD (default delete → 4xx); PUT entries assigns/orders/reorders/unassigns, cap → 4xx, dupe → 4xx, cross-tenant model → 4xx, ordering persists across GET; rule CRUD incl. tier/model target valid + invalid-target 4xx, `priority` out-of-range → 4xx (not 500), and **after deleting a target's tier the rule persists** (unresolved) while **recreating the same tier key rebinds** it; **tenant isolation** — user B cannot read/patch/delete/PUT-entries on user A's tier or rules (404), A's config unchanged.

## 6. Definition of done

- [x] 6.1 `npm test -w packages/shared` (target helper), `npm test -w packages/control-plane` (service), and `npm run test:e2e -w packages/control-plane` (routing CRUD incl. tenant-isolation + ordering + cap) green; `npm run build` passes; lint clean; strict TS, no `any` escapes.
- [x] 6.2 Add a changeset (`@polyrouter/shared` + `@polyrouter/control-plane` minor).
- [x] 6.3 Confirm non-goals hold (no schema/migration, no routing execution/proxy, no `auto` pipeline, no admin/mode gating; #2 constraints and #4/#6/#7/#8 code unmodified); update spec/deltas and leave the change archive-ready.
