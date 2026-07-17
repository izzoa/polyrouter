## 1. E10.1 — Reject explicit nulls on the rule DTOs

- [x] 1.1 In `routing-config.dto.ts`, add an `IfDefined()` helper (`ValidateIf((_o,v)=>v!==undefined)`) and apply it in place of `@IsOptional()` on `matchType`/`headerName`/`target`/`priority` in both rule DTOs (keep `headerValue` `@IsOptional` — it stays nullable at the DTO layer; the effective-merged validation still requires a `header` rule to carry a value).
- [x] 1.2 e2e in `routing-config.e2e-spec.ts`: a rule POST/PATCH with `{target:null}`, `{priority:null}`, `{matchType:null}`, `{headerName:null}` each returns 4xx and (on PATCH) leaves the stored rule unchanged.

## 2. E10.2 — Compact tier positions on provider/model delete

- [x] 2.1 In `database/port.ts`, add a shared owner-scoped `compactTiers(tx, principal)` that, for each of the owner's tiers with entries, reads survivors ordered by position and — if not already `0..N-1` — renumbers gaps, applying updates in ASCENDING position order (each lower target already vacated → no `(tier_id, position)` unique-index collision).
- [x] 2.2 Give `providers.remove` and `models.remove` bespoke transactional impls: run the existing owner-scoped delete (cascade removes entries), then call `compactTiers(tx, principal)` — compact ALL owner tiers on the POST-delete state (not a pre-captured subset), so a concurrent chain mutation can't leave an uncaptured gap (the model FK serializes the only dangerous add-vs-delete interleaving). Preserve the exact ownership fences.
- [x] 2.3 e2e: a cross-provider 2-model tier (A@0, B@1); delete A's provider; POST to the tier → B serves (not `empty_tier`); deleting the sole-model provider leaves the tier empty. Existing `resolve.spec` no-silent-promotion test stays green (unchanged resolver).

## 3. E10.3 — Per-field LRU eviction in the baseline store

- [x] 3.1 In `structural-baseline.store.ts`, **version the key namespace** (`route:sbaseline:v2:…` hash + a sibling `…:z` ZSET) so legacy ZSET-less hashes are ignored and expire on their TTL. Rewrite `EWMA_LUA` to take the ZSET as `KEYS[2]` and, on a new field at cap, `ZPOPMIN`+`HDEL` the stalest field before `HSET`; every call `ZADD`s the field scored by the Redis server clock (`TIME`); both keys get the sliding TTL. Pass `KEYS[2]` from `runFlush`.
- [x] 3.2 (Dropped — local per-agent cap.) The acceptance is about the shared store; the global 10k LRU bounds memory and a churned local entry re-seeds from Redis. A correctly-bounded secondary per-agent index is deferred to backlog.
- [x] 3.3 Unit/e2e (`structural-baseline` spec, real Redis): fill an agent's v2 hash past the cap with distinct fingerprints, then flush a recurring fingerprint and assert it persists in Redis (HGET non-null, HLEN ≤ cap, HLEN == ZCARD) and cold-seeds a fresh store instance via `read`.

## 4. Verification & wrap-up

- [x] 4.1 `npm run build && npm run lint && npm run typecheck` clean.
- [x] 4.2 `npm test -w packages/control-plane -w packages/data-plane` green; `npm run test:e2e -w packages/control-plane` green (null-PATCH, cross-provider delete, baseline eviction).
- [x] 4.3 Changeset (user-facing: null-rule 4xx, tier survives cascade delete, baseline re-learns).
- [x] 4.4 Update `TODOS.md` board + mark E10 tasks ✅ in `FABLE_AUDIT.md` after archive.
