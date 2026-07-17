# Tasks — harden catalog / pricing / budget backlog

## A-12 — Anthropic model-list pagination
- [x] Add optional `modelsPagination?: { param: string; nextCursor(pageJson): string | null }`
      to `HttpAdapterSpec`.
- [x] Rewrite `listModels` to loop: append the cursor query param, accumulate `parseModels`
      results with cross-page dedup + the `MAX_PARSED_MODELS` total cap + a page-count safety
      bound; a spec without the hook returns after one page (unchanged OpenAI behavior).
- [x] Anthropic adapter supplies `{ param: 'after_id', nextCursor: has_more ? last_id : null }`.
- [x] Test: a two-page Anthropic response accumulates both pages and sends `after_id`; a
      single-page (no hook) provider is unchanged.

## A-13 — LiteLLM refresh skips invalid entries instead of aborting
- [x] In `applyVersions`, validate each entry; on failure skip + log for `source === 'refresh'`,
      rethrow for trusted sources (`bundled`/`manual`).
- [x] Return/log the skipped count alongside the written count.
- [x] Test: a refresh with one negative-price entry still writes the valid ones (whole refresh
      not aborted); a bad bundled entry still throws.

## A-16 — validate BUDGET_STALE_MS against the reconcile cron
- [x] At config resolution, when `schedEnabled`, parse `BUDGET_SCHED_CRON` (cron-parser) to its
      worst-case fire gap and fail-fast if `staleMs` is below the gap × safety factor.
- [x] Test: the shipped default passes; an hourly cron with the 3-minute default fails-fast
      with a clear message; scheduler-disabled skips the check.

## A-17 — budget cache fail-mode coverage
- [x] Add `budget-cache.spec.ts`: TTL freshness, LRU eviction at cap, single-flight coalescing,
      invalidate-on-write, serve-stale-on-refresh-error, cold-miss error propagation.

## Verification
- [x] `npm run build`, lint, typecheck clean.
- [x] Unit: anthropic-adapter (pagination), pricing.service (skip invalid), budgets.config
      (stale-vs-cron), budget-cache (fail modes).
- [x] Changeset added (user-facing: catalog completeness, pricing-refresh resilience, a new
      boot-time config check).
