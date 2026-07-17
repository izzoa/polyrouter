## Decisions

- **A-44 (no code change):** the tier DTOs already use `@IsOptional()`, which skips validators for a
  `null` (not just `undefined`), so `displayName: null` passes validation and the owner-scoped update
  persists it (`stripProtected` removes only identity columns). This differs from E10's non-nullable
  rule fields, which use `@IfDefined()` to REJECT a null. An e2e now guards the clear-with-null path.
- **A-45:** `ruleOrder` becomes `<T extends { priority: number; createdAt: Date; id: string }>` so both
  the data-plane resolver's `RouteRule` and the control-plane `RoutingRuleRow` use the one comparator.
  `effectiveAutoLayers(cap, pref)` is a pure function beside `autoLayerCapability` (both in the proxy's
  `routing.config.ts`); `AutoLayersService.effective` spreads it (keeping the `*Available` fields) and the
  proxy's private read returns it. Cross-module import direction is unchanged (control-plane already
  depends on data-plane; both auto-layers users already import `routing.config`).

## Risks / Trade-offs

- Behavior-preserving: the extracted comparator/formula are byte-identical to the inlined ones (verified
  by the unchanged routing/resolve/proxy suites).

## Migration Plan

None — refactor + test only.
