# Tasks: add-dashboard-config

> Build order: BACKEND per-tenant auto-layers (schema/migration → persistence accessor → global-default export → `/api/routing/auto-layers` endpoint → proxy honors it live → backend tests) → FRONTEND config wiring (client + store → Routing → Limits → Notifications → tests) → DoD. Owner-scoped everywhere (invariant 5); the smart router degrades on a settings fault (invariant 1); secrets write-only (invariant 8). One migration (`routing_settings`); no new deps.

## 1. Backend — per-tenant auto-layer setting

- [x] 1.1 `shared/db/schema.ts`: `routingSettings` (`routing_settings`) — `id()`, `owned.ownerUserId()`/`orgId()`, `structuralEnabled boolean notNull`, `cascadeEnabled boolean notNull`, `createdAt()`, `updatedAt` (timestamp default now). `uniqueIndex('routing_settings_owner_unique').on(ownerUserId)` + `check('routing_settings_cascade_implies_structural', NOT cascade_enabled OR structural_enabled)` (backstops the write-time normalization). `export type RoutingSettingsRow`.
- [x] 1.2 `shared/persistence.ts` + server index: `RoutingSettingsValue { structuralEnabled: boolean; cascadeEnabled: boolean }`; `RoutingSettingsAccessor { get(principal): Promise<RoutingSettingsValue | null>; upsert(principal, v: RoutingSettingsValue): Promise<RoutingSettingsValue> }`; add `routingSettings: RoutingSettingsAccessor` to `PersistencePort`; export types.
- [x] 1.3 `control-plane/database/port.ts`: `createRoutingSettingsAccessor(db)` — `get` = owner-scoped select (`ownershipPredicate`); `upsert` = `insert … onConflictDoUpdate({ target: routingSettings.ownerUserId, set: { structuralEnabled, cascadeEnabled, updatedAt: now } })` with owner forced from the principal (`buildInsertValues`); wire into `buildPersistencePort`.
- [x] 1.4 `npm run db:generate -w packages/control-plane` (→ `0007_*.sql`) + prettier meta; confirm boot migration applies it (unique owner index).

## 2. Backend — global default + endpoint

- [x] 2.1 `control-plane/src/proxy/routing.config.ts`: export a pure `autoLayerCapability(cfg: RoutingConfig): { structural: boolean; cascade: boolean }` = `{ structural: cfg.autoLayers.has('structural'), cascade: cfg.cascade.enabled }`. It takes the **injected boot-resolved `ROUTING_CONFIG`** (the routers' singleton) — NOT a fresh `loadRoutingConfig()` — so the endpoint's capability can't drift from the routers'. Reused by the endpoint + the proxy (both inject `ROUTING_CONFIG`).
- [x] 2.2 `control-plane/src/routing-config/auto-layers.dto.ts`: `AutoLayersDto { structural: boolean @IsBoolean; cascade: boolean @IsBoolean }`.
- [x] 2.3 `control-plane/src/routing-config/*` (service + a controller route; the service injects the boot-resolved `ROUTING_CONFIG` for `autoLayerCapability`): `resolveEffective(principal)` = `routingSettings.get` combined with the capability per design (effective = `available && (pref ?? true)`); `setPreference(principal, dto)` normalizes `cascade → structural` then `routingSettings.upsert`. `GET /api/routing/auto-layers` → `{ structural, cascade, structuralAvailable, cascadeAvailable }`; `PUT /api/routing/auto-layers` (`AutoLayersDto`, **both booleans required** — full replacement) → same shape, `no-store`. Session-guarded, `@CurrentPrincipal()`. (The routing-config module imports `ROUTING_CONFIG` — provide it there too, or a shared provider — plus `PERSISTENCE_PORT`.)

## 3. Backend — the proxy honors it live

- [x] 3.1 `control-plane/src/proxy/proxy.service.ts`: **inject the boot-resolved `ROUTING_CONFIG`** and derive `autoLayerCapability(cfg)` in the ctor. Add `private effectiveAutoLayers(principal): Promise<{structural;cascade}>` = `PERSISTENCE_PORT.routingSettings.get` combined with the capability, `try/catch` → **degrade to the capability default** on a thrown/rejected fault (invariant 1). In the `ir.model === AUTO_ALIAS && decision.decisionLayer === 'default'` branch ONLY: read `eff` once; gate `structural.evaluate` on `eff.structural` and the cascade branch on `eff.cascade && this.cascade.enabled`. Non-auto requests unchanged; no `StructuralRouter`/`CascadeRouter` changes.
- [x] 3.2 Verify the existing proxy/structural/cascade **unit + e2e suites still pass** (the change composes with the routers' internal global gate — effective already requires the global flag).

## 4. Backend — tests

- [x] 4.1 `control-plane` e2e — **the live per-tenant toggle** (slim proxy + stub upstream + real Postgres, MODE=selfhosted, `ROUTING_AUTO_LAYERS=cascade` so both are available): seed a tenant with `auto_high`/`auto_low` rules. **Use a DISTINCT canonical system prompt per assertion phase** so the structural EWMA baseline (which de-escalates repeated same-shaped requests — see `structural-routing.e2e-spec.ts`) can't confound the off/on verdict; ensure the toggle write and the proxied request resolve to the SAME owner. Structural: a `model:'auto'` request structural-routes to the band (assert served tier/model); then `PUT /api/routing/auto-layers {structural:false, cascade:false}` and assert the SAME running app leaves a fresh-prompt `auto` request on the `default` tier (no restart); re-`PUT {structural:true, cascade:false}` → structural-routes again. **Cascade through the proxy:** with `{structural:true, cascade:true}` an ambiguous request produces a cascade route; with `{structural:true, cascade:false}` it stays default. A second tenant's setting is independent (isolation).
- [x] 4.2 `control-plane` e2e — the endpoint: `GET` returns effective + `*Available` from the injected capability; **`PUT {structural:false, cascade:true}`** normalizes to `structural:true` (both returned true — the DTO requires both booleans); owner-scoping (the accessor is owner-scoped). **Degrade-on-fault:** fault-inject `ProxyService`'s routing-settings read (a rejecting `get`) and assert the request still succeeds using the capability default. Unit: `resolveEffective`/`autoLayerCapability` truth table (capability × preference, cascade-implies-structural).

## 5. Frontend — API client + store

- [x] 5.1 `frontend/src/data/api.ts`: types + `ApiClient` methods — tiers `createTier`/`updateTier`/`deleteTier`/`listTierEntries` (`listTiers`/`replaceTierEntries` exist); rules `listRules`/`createRule`/`deleteRule`; budgets `listBudgets`/`createBudget`/`updateBudget`/`deleteBudget`; channels `listChannels`/`createChannel`/`updateChannel`/`deleteChannel`/`testChannel`; `getAutoLayers`/`setAutoLayers`. All relative `/api/*`, `credentials:'include'`.
- [x] 5.2 `frontend/src/state/appState.ts`: replace the simulated config slices (`tiers`/`autoLayers`/`rules`/`limits`/`channels` + `reorderChain`/`addToChain`/`removeFromChain`/`toggleLayer`/`removeRule`/`createLimit`/`toggleChannel`/`testChannel`/`addChannel`) with fetched slices + real actions (loaders per page; each with loading/error). Reorder/add/remove recompute `modelIds` → `replaceTierEntries` (optimistic + reconcile). Toggle-layer → `setAutoLayers` (cascade-on enables structural). Budget/channel actions call the CRUD; test-channel stores the returned `{ok,error?}`.

## 6. Frontend — Routing page

- [x] 6.1 `frontend/src/pages/Routing.tsx`: remove `PreviewBanner`; render tiers from the real slices; drag-to-reorder / add (model picker from `listModels`) / remove / set-primary persist via `replaceTierEntries`; ≤5 client guard; the model row shows the real externalModelId + price (from `listModels`, incl. #18's `inputPricePer1m`/`outputPricePer1m`). Header rules list + create (`x-polyrouter-tier` value → `tier:<key>`) + delete. The auto-layer card: `getAutoLayers` on mount; each toggle → `setAutoLayers`; a layer with `*Available:false` is greyed + "off instance-wide (ROUTING_AUTO_LAYERS)"; L2 semantic stays locked. Loading/error states.

## 7. Frontend — Limits page

- [x] 7.1 `frontend/src/pages/Limits.tsx` + the budget modal (`components/Modals.tsx`): budget cards from `listBudgets` (name/scope/window/action badge/amount/channels/enabled); a create/edit modal (name; scope global|agent + agentId picker when agent [from `listAgents`]; window day|week|month; action **alert|block**; amount; **notifyChannelIds** multi-select from `listChannels`; enabled); delete; inline 422 (agent-needs-agentId). Drop the simulated live "current spend" bar (config-only; deferred note).

## 8. Frontend — Notifications (Settings)

- [x] 8.1 `frontend/src/pages/Settings.tsx` + the channel modal: remove the notifications `PreviewBanner`; channel list from `listChannels` (name/kind chip/enabled/`hasConfig`/`lastTestStatus`); an add/edit modal (name; kind smtp|apprise + the kind-specific config — SMTP host/port/secure/user/pass/from/to, or Apprise urls, **write-only**; event-subscription checkboxes from `EVENT_TYPES`); enable toggle → PATCH; **Send test** → `testChannel` → inline `{ok,error?}` + refresh; delete. (The body-logging toggle is left as-is — no opt-in API; out of scope.)

## 9. Frontend — tests

- [x] 9.1 `frontend/src/test/fakeClient.ts`: add tiers/rules/budgets/channels CRUD + `getAutoLayers`/`setAutoLayers` (mutable, so actions are observable); `testChannel` returns a settable `{ok,error?}`.
- [x] 9.2 Vitest (via `AppProvider`+fake): tier reorder/add/remove → the expected `replaceTierEntries(modelIds)`; rule create/delete; budget create (alert & block) + channel wiring + agent-needs-agentId inline error; channel create + **Send test** rendering `{ok:false,error}` inline; the auto-layer toggle → `setAutoLayers` (+ cascade-on-enables-structural, + greyed when `*Available:false`). Update #18/#19's `App.test.tsx`/`appState.test.ts` for the removed simulated config slices.

## 10. Definition of done

- [x] 10.1 `npm test -w packages/frontend` + `npm test -w packages/control-plane` + `npm run test:e2e -w packages/control-plane` green (incl. the live auto-layer-toggle e2e); `npm run build` (shared → control-plane → frontend) passes; lint + format clean; strict TS, no `any`; the `0007` migration generated + applied on boot.
- [x] 10.2 DoD (§15): routing + limits fully configurable from the UI; notification test-send surfaces success/failure inline; **toggling an auto layer takes effect without a restart** (the e2e proves the same running instance honors a per-tenant `PUT`). Verified by the e2e + a manual check.
- [x] 10.3 Changeset (`@polyrouter/shared` + `@polyrouter/control-plane` minor; frontend private). Confirm invariants: routing-settings + all config reads/writes owner-scoped (5); the proxy's per-tenant read degrades to the global default and never fails a request (1); channel/provider secrets write-only, test-send sanitized (8). Update TODOS.md #20 (Phase F complete); archive.
