## Context

Three independent routing edge fixes. Precedence, atomic replace, and safe degradation are already
correct — these are input-validation, cascade-invariant, and shared-learning-eviction gaps.

## Goals / Non-Goals

**Goals:** null rule input → 4xx not 500; a cascade delete leaves tiers routable; the shared baseline
re-learns boilerplate under a rotating-fingerprint flood.

**Non-Goals:** changing `resolveTier`'s no-silent-promotion rule (the fix is upstream at delete time),
the EWMA math, or the fingerprint canonicalization (per-field eviction keeps fingerprint semantics —
chosen over the structure-only-digest alternative to avoid changing routing decisions).

## Decisions

### E10.1 — Defined-only validators
`@IsOptional()` treats `null` like `undefined` (skips validators). Replace it with
`@ValidateIf((_o, v) => v !== undefined)` on `matchType`/`headerName`/`target`/`priority` in both rule
DTOs, so an explicit `null` runs the validators (`@IsString`/`@IsInt`/`@IsIn` reject it → 4xx) instead of
reaching `parseRoutingTarget(null)` (TypeError 500) or the NOT NULL column (500). `headerValue` keeps
`@IsOptional()` (null = match-any is meaningful). Create-required fields (`matchType`, `target`) already
reject null via their base validators.

### E10.2 — Position compaction at delete
`resolveTier` needs `position === 0`; provider deletion cascades `routing_entries` and leaves gaps.
Bespoke transactional `providers.remove`/`models.remove` that, after the owner-scoped delete:

1. Delete (owner-scoped, unchanged fences: provider = `id AND ownershipPredicate`; model = `id AND
   provider_id ∈ ownedProviderIds`); the FK `ON DELETE CASCADE` removes the entries.
2. **Compact every one of the owner's tiers** (not a captured subset) via a shared, owner-scoped
   `compactTiers(tx, principal)`: for each owner tier with entries, read the survivors ordered by
   position; if not already `0..N-1`, renumber, applying the updates in **ascending** position order so
   every new (lower) target position is already vacated — never transiently colliding with the
   `(tier_id, position)` unique index (the `0..4` CHECK forbids the usual bump-to-high-offset trick).

**Race-robust WITHOUT a lock protocol (clink round 1):** compacting the *whole* owner tier set on the
post-delete committed state (rather than a set captured before the delete) sidesteps the "a concurrent
`add` affected an uncaptured tier" race — and the `routing_entries.model_id → models` FK already
serializes the only dangerous interleaving: an `add` of a soon-cascaded model either commits before the
cascade (so the compaction sees and fixes that tier) or FK-fails against the committed model delete (so
no orphaned gap is created). Ownership is preserved; `resolveTier` and its no-silent-promotion unit test
are untouched.

### E10.3 — Per-field LRU eviction in the baseline
`EWMA_LUA` at cap `EXPIRE`s and returns 0 (refuses the field) — so a full hash never lapses and never
re-learns. Add a parallel per-agent ZSET `KEYS[2]` (field → last-touch, scored by the **Redis server
clock** via `TIME`, skew-free like E4.2; allowed in a writing script under Redis 7 effects replication).
On a new field at cap, `ZPOPMIN` + `HDEL` the stalest field, then `HSET` the new one; every touch
`ZADD`s the field's score; both keys get the sliding TTL. So a rotating flood evicts its own transients
while a frequently-seen boilerplate fingerprint survives and stays learnable — and a full hash's TTL
still lapses if the agent goes quiet.

**Legacy saturated hashes (clink round 1):** existing hashes were created without a ZSET, so a
post-upgrade `ZPOPMIN` on them evicts nothing and their 32 legacy fields become immortal — the exact
saturated installs E10.3 targets would stay broken. Fix by **versioning the key namespace**
(`route:sbaseline:v2:…` for the hash, a sibling `…:z` for the ZSET): the old v1 hashes are simply
ignored and expire on their existing 30-day TTL, and every v2 hash carries the ZSET from its first
write — no in-place reconciliation. Baselines are best-effort and relearn within a few requests, so the
one-time reset is invisible.

*Not doing (clink round 1):* a local-cache per-agent cap. The acceptance is about the SHARED store
(re-learn + cold-seed a second instance), which the Lua fix delivers; a correctly-bounded secondary
per-agent index synchronized with every global-LRU eviction is real complexity for a
degrades-gracefully-anyway concern (a busy agent churning the 10k local LRU is re-seeded from Redis on
the next cold miss). The global 10k LRU already bounds memory. Left as backlog.

*Alternative rejected (structure-only fingerprint digest):* would also collapse a fully-dynamic-prompt
agent to one fingerprint, but changes structural-routing decision semantics (invariant-1 sensitive) and
lives upstream in the data-plane canonicalizer — bigger blast radius than the store-local eviction that
satisfies the acceptance.

## Risks / Trade-offs

- **[Compaction touches the hot delete path]** — bounded: ≤5 entries per tier (the `0..4` CHECK), a
  handful of affected tiers; all inside the existing delete transaction.
- **[ZSET doubles baseline keys]** — one ZSET per agent hash, same TTL, hard-bounded by the same field
  cap; negligible.
- **[A fully-dynamic-prompt agent still gets no stable baseline]** — correct and safe: it has no
  boilerplate to learn, so structural routing degrades to no-baseline (invariant 1), never erring.

## Migration Plan

Code-only; no schema migration (positions/columns unchanged). Rollback is a revert; the compaction only
tightens an invariant the config layer already assumed.

## Open Questions

None.
