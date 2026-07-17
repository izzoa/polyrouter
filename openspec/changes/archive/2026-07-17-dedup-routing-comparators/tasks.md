## 1. A-44 — nullable display fields are clearable

- [x] 1.1 Confirm (and guard with an e2e) that a tier PATCH with `displayName: null` returns 200 and clears the field — already works via the `@IsOptional()` DTOs; no code change.

## 2. A-45 — one shared comparator + formula

- [x] 2.1 Make `ruleOrder` generic over `{priority, createdAt, id}` in `data-plane/routing/resolve.ts`; reuse it in `routing-config.service.ts` (drop the inline copy).
- [x] 2.2 Add `effectiveAutoLayers(cap, pref)` beside `autoLayerCapability` in `proxy/routing.config.ts`; use it in `AutoLayersService.effective` and the proxy's per-request read (drop both inline copies).

## 3. Wrap-up

- [x] 3.1 build/lint/typecheck green; data-plane resolve + control-plane routing/auto-layers/proxy suites green.
- [x] 3.2 Update TODOS + mark A-44/A-45 ✅ in FABLE_AUDIT after archive.
