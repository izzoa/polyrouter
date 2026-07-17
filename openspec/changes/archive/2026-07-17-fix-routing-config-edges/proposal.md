## Why

Routing precedence and degradation are airtight, but three edge defects produce 500s, brick a usable
tier, or silently defeat shared learning (FABLE_AUDIT E10):

- **Explicit JSON nulls 500 the rule API.** `@IsOptional()` skips validators for `null` (not just
  `undefined`), so a rule PATCH/POST with `{target:null}` → `parseRoutingTarget(null)` TypeError → 500;
  `{priority:null}`/`{matchType:null}` → Postgres NOT NULL → 500; `{headerName:null}` → silently
  rewrites the rule. The spec requires invalid input rejected 4xx, not 500.
- **A cascade-deleted position-0 model bricks a tier.** `resolveTier` requires `position === 0` exactly
  (no silent fallback promotion), but provider deletion cascades `routing_entries` and nothing
  re-compacts, so deleting the primary's provider leaves a tier with healthy models at 1..N returning
  `empty_tier` → every request 400s until a manual re-save. Contradicts §7.4's chain promise.
- **The structural baseline hash saturates and never re-learns.** The per-agent EWMA hash caps at 32
  fields and, when full, rejects new fingerprints **while refreshing the whole-hash TTL** — so a harness
  that interpolates dynamic values (timestamp, cwd, session id) into the system prompt fills the hash in
  32 requests and the shared, cross-instance baseline can then never learn legitimate boilerplate again
  (silently defeating §7.2's de-contamination).

## What Changes

- **E10.1** Replace `@IsOptional()` with a defined-only validator (`@ValidateIf(v !== undefined)`) on the
  non-nullable rule fields (`matchType`, `headerName`, `target`, `priority`) in both rule DTOs, so an
  explicit `null` is a clean 4xx and the stored rule is unchanged (`headerValue` keeps its null-as-clear).
- **E10.2** Compact `routing_entries` positions to contiguous `0..N-1` inside the provider/model delete
  transaction (renumbering ascending to respect the `(tier_id, position)` unique index), so the
  contiguous-position invariant the config layer owns survives a cascade and the surviving next model
  serves. `resolveTier`'s no-silent-promotion stance is unchanged.
- **E10.3** Give `EWMA_LUA` per-field LRU eviction: a parallel per-agent ZSET (field → server-clock
  last-touch); at cap, `ZPOPMIN` + `HDEL` the stalest field before inserting the new one (still one
  atomic script), so a stable boilerplate fingerprint is re-learnable even under a rotating-fingerprint
  flood. Version the key namespace (`…:v2:…`) so legacy ZSET-less hashes are ignored and expire, and
  every new hash carries the LRU ZSET from its first write.

## Capabilities

### Modified Capabilities

- `routing-config`: a rule create/PATCH with an explicit `null` for a non-nullable field SHALL be
  rejected 4xx, not 500, with the stored rule unchanged.
- `provider-management`: deleting a provider/model SHALL leave every affected tier's routing-entry
  positions contiguous from 0 (a surviving fallback still serves).
- `structural-routing`: the per-agent baseline SHALL evict a stale fingerprint at cap (per-field LRU),
  not saturate-and-refuse, so legitimate boilerplate stays learnable in the shared store.

## Impact

- **Code:** `routing-config.dto.ts` (defined-only validators), `database/port.ts` (transactional
  position compaction on provider/model delete + a shared `compactTiers`), `structural/structural-baseline.store.ts`
  (`EWMA_LUA` ZSET eviction + local per-agent cap).
- **Tests:** null-PATCH/POST e2e; a cross-provider 2-model chain e2e (delete the position-0 provider →
  survivor serves); a baseline unit/e2e filling the hash then asserting a repeated fingerprint persists +
  cold-seeds a second store. **No migration** (position column unchanged). Changeset: user-facing.
- Backlog A-21..A-25, A-44 out of scope.
