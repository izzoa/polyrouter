# Design: add-dashboard-config

## Context

Reuses: #9's routing-config API (`/api/routing/tiers` incl. `PUT /:id/entries` atomic ordered chain [pos 0 = primary, ≤5], `/api/routing/rules` CRUD with `matchType ∈ {header,default,auto_high,auto_low}` + `target = tier:<key>|model:<id>`); #16's `/api/budgets` CRUD; #15a's `/api/notification-channels` CRUD + `POST /:id/test` (`{ok, error?}`, sanitized); #18's SPA seam (`ApiClient`/`AppProvider`/`FakeApiClient`/`live` + `listTiers`/`replaceTierEntries`/`listModels` already present); the proxy's per-tenant snapshot load. The auto-layer enablement is global env (`ROUTING_AUTO_LAYERS` → `buildRoutingConfig`, boot singleton; `StructuralRouter.evaluate` gates on `cfg.autoLayers.has('structural')`, the cascade branch on `cfg.cascade.enabled` at `proxy.service.ts:537-541`). Governing invariants: **5** (owner-scoped), **1** (smart router degrades, never fails), **8** (write-only secrets).

## Decision 1 — Per-tenant auto-layer setting (storage + accessor)

`routing_settings` table (owner-scoped, one row per tenant): `{ id, ownerUserId (UNIQUE), orgId, structuralEnabled bool, cascadeEnabled bool, createdAt, updatedAt }`. `unique(owner_user_id)` + a DB `check(NOT cascade_enabled OR structural_enabled)` so the stored row can never hold the inconsistent cascade-on/structural-off state (a backstop behind the write-time normalization). `RoutingSettingsRow`; a `routingSettings: { get(principal): Promise<{structuralEnabled;cascadeEnabled}|null>; upsert(principal, v): Promise<...> }` accessor on `PersistencePort` (owner forced from principal; `upsert` via `ON CONFLICT (owner_user_id) DO UPDATE`). One migration (`0007`). No row = the tenant has expressed no preference (inherit the global default). Added to the port; the proxy + the endpoint both read it owner-scoped (invariant 5).

## Decision 2 — Effective model: capability × preference

The instance env `ROUTING_AUTO_LAYERS` is the **capability** (what the operator enabled instance-wide); the per-tenant row is the **preference**. `routing.config.ts` exports a pure `autoLayerCapability(cfg: RoutingConfig): { structural, cascade }` (from `cfg.autoLayers.has('structural')` / `cfg.cascade.enabled`) — it takes the **boot-resolved `ROUTING_CONFIG`** (the same singleton the routers consume, injected via DI), NOT a fresh `loadRoutingConfig()`, so the capability the endpoint reports can never drift from the capability the routers actually enforce. Effective per tenant:

```
structural = global.structural && (row?.structuralEnabled ?? true)   // default: inherit-on within capability
cascade    = global.cascade    && (row?.cascadeEnabled    ?? true)
```

So a tenant can **opt any layer out**, and opt in **within** what the instance enables (with the common default env, both are available, so toggling works both ways). A layer the operator disabled instance-wide stays off for everyone (surfaced as `*Available:false` so the UI greys it, not a silent inert toggle). **Cascade implies structural** is normalized on write (`PUT` with `cascade:true` forces `structural:true`) — mirroring `buildRoutingConfig`'s rule — so cascade always has structural's ambiguity signal to act on.

## Decision 3 — Endpoint (`/api/routing/auto-layers`, session-guarded)

In the routing-config module (a new `AutoLayersController` + a method on `RoutingConfigService`, or a small dedicated service):

- `GET /api/routing/auto-layers` → `{ structural, cascade, structuralAvailable, cascadeAvailable }` — the effective flags + the instance capability (`autoLayerCapability` over the injected boot-resolved `ROUTING_CONFIG`), so the UI shows the toggle state and greys an instance-disabled layer.
- `PUT /api/routing/auto-layers` (body `AutoLayersDto { structural: boolean; cascade: boolean }`, class-validated) → normalize (`cascade → structural`), `routingSettings.upsert`, return the same shape as GET. `no-store`.

## Decision 4 — The proxy honors it live (lazy, degrading)

`ProxyService.prepare` currently: `resolveRoute` → if `ir.model === AUTO_ALIAS && decision.decisionLayer === 'default'` → `structural.evaluate` → (`route`|`ambiguous`+`cascade.enabled`). Change ONLY inside that branch (so non-auto requests are untouched — the setting is read lazily, only for `auto` requests that fell through to `default`, the minority):

```
if (ir.model === AUTO_ALIAS && decision.decisionLayer === 'default') {
  const eff = await this.effectiveAutoLayers(principal);           // owner-scoped read + injected capability; try/catch → capability default
  if (eff.structural) {
    const evaln = await this.structural.evaluate(principal, agentId, ir, snapshot);
    if (evaln.kind === 'route') decision = evaln.decision;
    else if (evaln.kind === 'ambiguous' && eff.cascade && this.cascade.enabled) cascadePlan = this.cascade.plan(snapshot);
  }
}
```

`effectiveAutoLayers(principal)` = `routingSettings.get` + the injected `ROUTING_CONFIG` capability (Decision 2), wrapped so a **thrown/rejected** settings-read fault **degrades to the capability default** (invariant 1 — the smart path never fails a request; degrade is best-effort, not a false verdict). Scope of the guarantee: a settings-read that *hangs* is the same Postgres dependency the existing `loadSnapshot` already carries — this change adds no new stall surface beyond one indexed read; a bounded read is a possible hardening, not required. The `StructuralRouter`/`CascadeRouter` classes and their unit tests are **unchanged**: `evaluate`'s internal global gate still holds (effective already requires the capability), so gating the *call* on `eff.structural` composes as redundant-but-correct double gating; the cascade branch ANDs `eff.cascade` with the existing `this.cascade.enabled`. `ProxyService` injects the boot-resolved `ROUTING_CONFIG` (→ `autoLayerCapability` in the ctor) + uses its existing `PERSISTENCE_PORT`. (A per-tenant settings cache like #16's is a later optimization; one owner-indexed read on the minority auto→default path is fine.)

## Decision 5 — Frontend wiring (the three pages)

The `ApiClient` gains: tiers `createTier`/`updateTier`/`deleteTier`/`listTierEntries` (`listTiers`/`replaceTierEntries` exist); rules `listRules`/`createRule`/`deleteRule`; budgets `listBudgets`/`createBudget`/`updateBudget`/`deleteBudget`; channels `listChannels`/`createChannel`/`updateChannel`/`deleteChannel`/`testChannel`; `getAutoLayers`/`setAutoLayers`. Store slices `tiers`/`tierEntries`/`rules`/`budgets`/`channels`/`autoLayers` replace the simulated ones, loaded on the respective page mount.

- **Routing:** each tier renders its entries (`listTierEntries` → model rows via `listModels` for labels/prices); **drag-to-reorder / add / remove** all recompute the ordered `modelIds` and call `replaceTierEntries` (optimistic set + reconcile from the response; ≤5 enforced client-side + the API is the backstop). Header rules list + a create form (`x-polyrouter-tier: <value> → tier:<key>`) + delete. The auto-layer card reads `getAutoLayers`; each toggle `setAutoLayers` (cascade-on auto-enables structural, matching the server); an unavailable layer is greyed with the instance-wide note. Tier create/delete (the `default` tier is protected — no delete) is available.
- **Limits:** budget cards from `listBudgets`; a create/edit modal (name/scope/agentId[when agent]/window/action[alert|block]/amount/notifyChannelIds[multi-select from `listChannels`]/enabled); delete; inline 422 messages (agent-needs-agentId). No live-spend bar (deferred).
- **Notifications:** channel list from `listChannels`; add/edit modal (name/kind + the kind-specific config: SMTP host/port/secure/user/pass/from/to, or Apprise urls; write-only — never render a stored secret) + event-subscription checkboxes (`EVENT_TYPES`); enable toggle (PATCH); **Send test** → `testChannel` → inline `{ok,error?}` + refresh `lastTestStatus`; delete.

## Decision 6 — Test strategy

- **Backend e2e (real Postgres + a slim proxy w/ stub upstream):** seed a tenant with an `auto_high` rule → an `auto` request that structural-routes to it; then `PUT /api/routing/auto-layers {structural:false}` and assert the SAME running instance now leaves the request on the `default` tier (proves live, no-restart per-tenant honoring); re-enable → structural-routes again. Endpoint e2e: `GET` returns effective + availability; `PUT {cascade:true}` normalizes structural-on; owner-scoping (a second tenant's setting is independent); a settings-read fault degrades to the global default. Routing-settings tenant isolation.
- **Frontend Vitest (fake client):** tier reorder/add/remove → the expected `replaceTierEntries(modelIds)`; rule create/delete; budget create (alert & block) + channel wiring + the agent-needs-agentId inline error; channel create + **Send test** rendering `{ok:false, error}` inline; the auto-layer toggle → `setAutoLayers` (+ cascade-on-enables-structural, + greyed-when-unavailable). Update #18/#19's tests for the removed simulated config slices.

## Risks / trade-offs

- **Effective = capability × preference** — a tenant cannot enable a layer the operator disabled instance-wide (surfaced via `*Available`). This is the safe model (operator gates capability); full "override the operator" was rejected as it would also churn the hot-path routers + #13 tests. With the default env (structural+cascade available) the per-tenant toggle is fully functional both ways.
- **One extra owner-indexed read on the auto→default path** — only `auto` requests that fell to `default` pay it; degrades to the global default on fault; a cache is a later optimization.
- **Live budget spend not shown** — the budget API is config-only and the reconciled counter isn't exposed; the Limits page shows config, not a live bar (deferred).
- **One migration (`routing_settings`), no new deps.** Structural thresholds/weights + cascade tuning stay global env (out of scope).
