## Why

Invariant 4's cost machinery is correct (immutable snapshots, append-only catalog), but the spend
record that budgets and dashboards reconcile from can be silently under-counted three ways (FABLE_AUDIT
E5): rows are lost at shutdown without being counted as dropped, a cancelled cascade cheap leg writes
no row at all, and four first-class spec-§8 BYOK provider families (Qwen/MiniMax/Kimi/GLM) are
structurally unpriceable so they record `cost=null` forever. A fourth defect lets a stale user-set
`$0` price silently override the catalog after a provider's kind changes.

## What Changes

- **E5.1** `LogWriter.flush()` early-returns while a flush is in flight, and timer flushes are
  un-awaited — so `onApplicationShutdown` no-ops if it races a flush, losing every draft enqueued
  after that flush's splice (including final rows from drained streams) **without** counting them as
  dropped. Make flush coalesce onto the in-flight promise and add a shutdown drain loop that runs
  until both queues are empty (or the drafts are counted as dropped), bounded by the retry policy.
- **E5.2** The two cascade client-disconnect branches (`cascadeCompletion`, `cascadeStream`) `throw`
  without recording, so a cancelled cascade request vanishes from the spend record and inspector.
  Record exactly one `status='error'` row (cheap meta at index 0, `escalated:false`, `outputChars:0`)
  before throwing — and do **not** `notifyFailed` (a client disconnect is not a provider failure).
- **E5.3** Add the missing LiteLLM-aligned host→family mappings — `dashscope` (Qwen), `moonshot`
  (Kimi), `minimax`, `zai` (GLM/Z.ai) — plus the `xai`/`cohere` hosts' missing bundled rows, and
  extend the bundled snapshot with real per-token entries for each (verified against LiteLLM's
  canonical `model_prices_and_context_window.json`), bumping `BUNDLED_CATALOG_VERSION`. A Qwen BYOK
  provider then resolves a catalog snapshot instead of `cost=null`.
- **E5.4** When `ProvidersService.update` moves a provider's kind from `custom`/`local` to
  `api_key`/`subscription`, clear the provider's models' user-set `inputPricePer1m`/`outputPricePer1m`/
  `isFree` in the same operation (a new tenant-scoped bulk port method), so subsequent requests price
  from the catalog instead of a stale `$0` that `resolveModelPrice` ranks above the catalog.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `request-logging`: the shutdown flush SHALL drain both queues (or count drops); a cancelled cascade
  cheap leg SHALL record exactly one error row.
- `pricing-catalog`: the §8 BYOK families (Qwen/MiniMax/Kimi/GLM) SHALL be resolvable to a catalog key,
  and the bundled seed SHALL contain ≥1 row per §8 BYOK family.
- `provider-management`: a kind change away from `custom`/`local` SHALL NOT leave a stale user price
  that overrides the catalog.

## Impact

- **Code:** `packages/control-plane/src/recording/log-writer.ts` (drain), `.../proxy/proxy.service.ts`
  (two cascade cancel records), `packages/shared/src/server/pricing/resolve.ts` (`PROVIDER_FAMILY_HOSTS`),
  `packages/control-plane/src/pricing/bundled-catalog.ts` (new rows + version bump),
  `.../providers/providers.service.ts` (kind-change price clear) + a new tenant-scoped
  `models.clearPricingForProvider` port method (`persistence.ts` + `database/port.ts`).
- **Tests:** log-writer drain unit (deferred insert + late enqueue), cascade-cancel e2e (one error row,
  no attempt rows), `resolveForModel`/pricing-catalog family unit + e2e, provider kind-change e2e.
- **No migration** (columns already nullable). **Changeset:** user-facing (new BYOK pricing coverage +
  `BUNDLED_CATALOG_VERSION` bump). Related backlog A-13/A-14/A-15/A-16 are adjacent but out of scope
  (Appendix-A sweep).
