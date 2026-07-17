## Why

Two routing-config backlog nits (FABLE_AUDIT A-44, A-45):

- **A-44** A tier's nullable display fields (`displayName`/`description`) should be clearable by an
  explicit `null` PATCH. On review this already works — the DTOs are `@IsOptional()` (null-tolerant) and
  the update persists the null — but it was untested, so a regression could silently break it.
- **A-45** The deterministic rule-evaluation comparator (`priority` desc → `created_at` → `id`) and the
  "effective auto-layers" formula (`capable && (preference ?? true)`) were each **duplicated** — the
  comparator in the config service AND the data-plane resolver; the formula in `AutoLayersService` AND
  the proxy's per-request read. Duplicates drift.

## What Changes

- **A-44** Add an e2e assertion that a tier PATCH with `displayName: null` returns 200 and clears the
  field (regression guard; no code change).
- **A-45** Make the data-plane `ruleOrder` comparator generic over `{priority, createdAt, id}` and reuse
  it in the config service's rule listing (dropping the inline copy). Add a shared `effectiveAutoLayers`
  helper next to `autoLayerCapability` and use it in both `AutoLayersService` and the proxy — one
  definition each, so display and enforcement can't drift.

## Capabilities

### Modified Capabilities

- `routing-config`: a tier's nullable display fields are clearable via an explicit `null`; the
  rule-resolution order and the effective-auto-layers formula each have a single shared implementation.

## Impact

- **Code:** `data-plane/routing/resolve.ts` (`ruleOrder` generic), `control-plane/routing-config.service.ts`
  (reuse it), `control-plane/proxy/routing.config.ts` (`effectiveAutoLayers` helper),
  `auto-layers.service.ts` + `proxy.service.ts` (reuse it). Pure refactor — behavior-preserving. No
  schema change.
- **Tests:** the tier null-clear e2e; existing routing/auto-layers/proxy/resolve suites stay green
  (behavior unchanged). No changeset (internal refactor + test).
