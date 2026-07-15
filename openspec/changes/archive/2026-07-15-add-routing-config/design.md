# Design: add-routing-config

## Context

#2 created `tiers`, `routing_entries`, `routing_rules`; #3 provisions the `default` tier per user at signup. The persistence port already exposes `tiers`/`routingRules` as `OwnedRepository`, `routingEntries` as an accessor (`listForTier`/`add`/`setPosition`/`remove`), and `models` transitively owned through providers. This change is the **control-plane REST layer + validation contract** on top — no schema, no routing execution.

## Decision 1 — Ordering primitive: atomic "replace the whole chain", not row-by-row

`routing_entries` has `UNIQUE(tier_id, position)` (non-deferrable) and `CHECK(position BETWEEN 0 AND 4)`. Reordering by mutating one row's position collides with the row currently holding the target position (Postgres checks uniqueness per-statement). Rather than juggle temporary positions, the ordering API is a single `PUT /tiers/:tierId/entries { modelIds: ordered }` that **deletes all of the tier's entries and re-inserts `0..N-1`** in one transaction. This one primitive expresses assign, unassign, reorder, and set-primary; it can never hit a transient collision; and churning entry ids is harmless (nothing references `routing_entry.id` — RequestLog references `model_id`). Granular add/remove/set-position endpoints are intentionally **deferred** (the accessor methods remain for internal/other use); the dashboard drives everything through `PUT`.

## Decision 2 — New atomic accessor `routingEntries.replaceForTier`

Composing replace-all in the service from `listForTier`+`remove`+`add` works but nests a savepoint per `add` and splits ownership checks. Instead add one accessor (precedent: #7's `upsertForProvider`):

```ts
type ReplaceEntriesResult =
  | { status: 'ok'; entries: RoutingEntryRow[] }
  | { status: 'tier_not_found' }
  | { status: 'unknown_models'; modelIds: string[] };

replaceForTier(principal, tierId, orderedModelIds): Promise<ReplaceEntriesResult>;
```

In one transaction it: **`SELECT … FROM tiers WHERE id=$1 AND <owned> FOR UPDATE`** (acquiring the tier row lock so concurrent replacements of the same tier serialize instead of racing on the non-deferrable `UNIQUE(tier_id,position)` — a plain delete-then-insert transaction does *not* prevent two PUTs from both deleting and then colliding on position 0); `tier_not_found` → 404 if unowned; verifies every id is an owned model, collecting any that are not (`unknown_models` → 422); then `DELETE … WHERE tier_id = $1` and inserts `0..N-1`, returning the rows. The discriminated result lets the service map ownership failures to precise status codes without leaking which tenant owns what. Cap (≤5) and dedupe are validated in the service *before* the call (cheap, no DB); the `CHECK`/`UNIQUE` remain the backstop.

## Decision 3 — Structured `target`: `tier:<key>` | `model:<id>` in shared

The `target` column is one opaque string; #10 must parse it unambiguously. Define a pure helper in `@polyrouter/shared/server` (mirrors #8's `canonicalModelKey` single-source-of-truth pattern):

```ts
type RoutingTarget = { kind: 'tier'; key: string } | { kind: 'model'; id: string };
parseRoutingTarget(s: string): RoutingTarget | null;   // null on malformed, never throws
formatRoutingTarget(t: RoutingTarget): string;
```

Write-time validation resolves `tier:` targets against `tiers.list(principal)` (few rows) by key and `model:` targets against `models.findById(principal, id)`; a miss is a 422. This is **best-effort referential integrity at write time**, not a permanent guarantee: `target` is an opaque string with no FK, so deleting the referenced tier/model later makes the target *unresolved* (there is no cascade). Targets are **late-bound by key/id**, so recreating a deleted tier's key rebinds the rule to the replacement tier (intended — targets carry no identity beyond the key). An unresolved target is the same family as a resolved-but-empty tier — the proxy (#10) surfaces it as a stable client-facing routing error. #9 deliberately does **not** broaden into FK-backed targets or cascade-on-delete; it validates what it cheaply can and documents the runtime contract.

## Decision 4 — Rule semantics fixed here, executed in #10

#9 does not route, but it pins the stored-config semantics #10 will implement so the data is unambiguous: (a) `listRules` returns a **total order** — `priority` desc, then `created_at`, then `id` — so resolution is deterministic even with equal priorities or duplicate rules (the generic `OwnedRepository.list` is unordered, so the service sorts); (b) `header_name` is validated as an HTTP field-name token and stored **lower-cased** (headers are case-insensitive); (c) header-value matching is exact/case-sensitive (documented; compared in #10); (d) a `default` rule, if present, supplies the fallthrough, else the seeded `default` tier. PATCH validates the **effective merged** row (like providers.service's base_url handling), so a rule can't be edited into an invalid `header`-without-`header_value` state.

## Decision 5 — Empty-tier: observable here, error owned by #10

A rule may point at a currently-empty tier (models are assigned later), so config-time does **not** reject empty targets. `GET entries` returns a clean `[]`. The exact request-time error (status/code/body) for resolving to an empty *or unresolved* tier is defined and owned by #10 — #9 only guarantees the state is observable and never silently treated as routable. Nothing here executes routing.

## Decision 6 — Module shape

`packages/control-plane/src/routing-config/` (spec §4 name): `routing-config.module.ts` (`imports: [DatabaseModule]`, registered in `app.module`), `tiers.controller.ts` (`api/routing/tiers` + nested `:tierId/entries`), `rules.controller.ts` (`api/routing/rules`), one `RoutingConfigService` (injects `PERSISTENCE_PORT` + `PERSISTENCE_FACILITIES`), and `*.dto.ts` (class-validator, matching #7's style). `toSafe*` mappers shape output. Session-guarded by the global `SessionGuard`; no admin/mode gating (this is per-tenant config, unlike #8's global catalog).

## Risks

- **Churned entry ids on every reorder** — acceptable; ids are not referenced elsewhere, chains are ≤5.
- **Rule targets are validated best-effort, not permanently** — deleting the referenced tier/model leaves the target unresolved (there is no FK), and a `tier:<key>` target late-binds so recreating the key rebinds it. This is by design, not a bug: unresolved targets collapse into the same runtime contract #10 owns. #9 does not add FK-backed targets or cascade-on-delete (that would broaden scope into provider/model deletion behavior).
- **Concurrent chain replacement** — resolved by the `FOR UPDATE` tier-row lock in `replaceForTier` (Decision 2); covered by a concurrency test firing two replacements at once.
- **`tiers.list` scan for key lookup** — tiers per tenant are a handful; a scan is cheaper than a new `findByKey` accessor.
