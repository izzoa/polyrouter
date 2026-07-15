# Add routing configuration (tiers, ordered entries, header rules)

## Why

The proxy (#10) routes on **explicit** configuration — the dependable, zero-latency core (spec §7.1/§7.2, invariant 1). That configuration is three tenant-scoped things (spec §5): **Tiers** (`default` + user-defined), **RoutingEntries** (an ordered, ≤5-model fallback chain per tier — spec §7.4), and **RoutingRules** (`x-polyrouter-tier` header → a tier or a specific model). #2 already created the tables and the cap/uniqueness constraints, and #3 provisions the `default` tier at signup; what is missing is the **management REST API** (spec §6.2) and the **validation/target contract** #10 depends on. This change adds exactly that — CRUD only, no routing execution.

Two design pressures shape it: the `routing_entry` `UNIQUE(tier_id, position)` is **non-deferrable**, so reordering one row at a time collides mid-swap; and a RoutingRule's `target` is a single opaque column that #10 must parse unambiguously. Both are solved here so #10 inherits a clean, tested surface.

## What Changes

- **Tier CRUD** under `/api/routing/tiers` (session-guarded, tenant-scoped): list, create (validated key — lowercase slug, `auto` reserved, unique-per-owner), get, patch (display name/description; `key` immutable), delete. The `default` tier cannot be deleted.
- **Ordered routing entries** under `/api/routing/tiers/:tierId/entries`: `GET` returns the position-ordered chain (with model info); **`PUT { modelIds: [...] }` atomically replaces the whole chain** — this single primitive expresses assign, unassign, reorder, and set-primary (position 0). It enforces the ≤5 cap, rejects duplicate model ids, and validates every model is owned, sidestepping the non-deferrable-unique collision entirely (concurrent replacements of a tier serialize on a `FOR UPDATE` row lock).
- **RoutingRule CRUD** under `/api/routing/rules`: `match_type` (`header`|`default`), `header_name` (default `x-polyrouter-tier`, normalized), `header_value`, a **structured `target`** (`tier:<key>` | `model:<id>`), `priority`. Targets are validated at write time against the caller's own tiers/models (best-effort — a target can go unresolved after a later deletion, which #10 handles at runtime); PATCH validates the effective merged row; `listRules` returns a deterministic total order (`priority` desc, then `created_at`, `id`) so #10 resolves deterministically.
- **New atomic persistence accessor** `routingEntries.replaceForTier(principal, tierId, orderedModelIds)` returning a discriminated result (`ok` | `tier_not_found` | `unknown_models`) so the service maps ownership failures to 404/422 precisely. (Additive, precedented by #7's `upsertForProvider`.)
- **Shared pure helpers** in `@polyrouter/shared/server`: `parseRoutingTarget`/`formatRoutingTarget` and routing constants (`DEFAULT_TIER_KEY`, `TIER_HEADER_NAME`, `AUTO_ALIAS`, `MAX_MODELS_PER_TIER`, tier-key pattern) — the single source of truth #10 reuses.
- **Empty tiers** (a tier that exists with zero entries) are a valid config state exposed as `[]`. Distinctly, a rule `target` can become **unresolved** if its tier/model is deleted (the rule persists — no FK); a `tier:<key>` target is *late-bound by key*, so recreating that key rebinds the rule to the new tier. The *runtime* error for a resolved-but-empty tier or an unresolved target is defined and owned by #10; #9 only guarantees these states are observable, never silently routable — covered by tests.

## Impact

- Affected specs: **new capability `routing-config`**.
- Affected code: new `packages/control-plane/src/routing-config/` (module, controllers, service, DTOs); additive `routingEntries.replaceForTier` in `shared/src/server/persistence.ts` + `control-plane/src/database/port.ts`; new `shared/src/server/routing/` (target + constants) exported from `@polyrouter/shared/server`.
- **No schema migration** — the tables and the ≤5-model cap already exist (#2). No routing execution, proxy, or `auto` pipeline (that is #10/#13/#14). #4/#6/#7/#8 code is unmodified.
- Tenant isolation (invariant 5) is enforced through the existing owned repositories and the new atomic accessor; covered by cross-tenant e2e.
