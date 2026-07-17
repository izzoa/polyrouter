---
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
---

Catalog / pricing / budget resilience hardening (A-12, A-13, A-16, A-17).

- **Anthropic model catalogs no longer truncate.** `listModels` now follows cursor pagination (`has_more` + `last_id` via `after_id`) when a provider adapter declares it, accumulating all pages (de-duplicated, bounded by the existing parse cap plus a page-count and cursor-cycle guard). OpenAI (single-page) is unchanged.
- **A single bad LiteLLM row no longer aborts the whole price refresh.** The live LiteLLM pull now validates each entry and skips (logs, counts) an invalid one instead of throwing inside the transaction and dropping every other price update. Trusted sources (bundled snapshot, manual override, admin-supplied body) still fail-fast, now validated up front before any DB work.
- **A staleness/reconcile-cron misconfiguration is caught at boot.** When the budget reconcile scheduler is enabled, config resolution now walks the schedule's upcoming fire times and fails-fast if `BUDGET_STALE_MS` is shorter than a reconcile period's margin above a fire gap — so a long cron paired with a too-short stale bound (which would leave a healthy scheduler perpetually stale and silently degrade block enforcement to the fail mode) is a clear boot error instead of a silent degradation. The shipped defaults pass.
- **Budget-cache fail modes are now tested** (`budget-cache.spec.ts`): TTL freshness, LRU eviction, single-flight coalescing, invalidate-on-write, serve-stale on a refresh error, and cold-miss error propagation (so the caller engages the named fail mode).
