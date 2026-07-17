# Harden catalog / pricing / budget backlog (A-12, A-13, A-16, A-17)

## Why

Four backlog findings from `FABLE_AUDIT.md` (Appendix A) in the catalog-sync, pricing-refresh,
and budget-enforcement paths — each a correctness/robustness gap where a large upstream, one
bad external row, or a misconfiguration silently degrades a subsystem:

- **A-12 — Anthropic `listModels` ignores pagination, so large catalogs truncate.** The
  shared HTTP adapter's `listModels` fetches exactly one page. Anthropic's `/v1/models` is
  cursor-paginated (`has_more` + `last_id`); a tenant with more models than one page gets a
  silently truncated catalog (some models unroutable by bare id).
- **A-13 — the LiteLLM pricing refresh never validates entries, so one bad row aborts the
  whole refresh.** `applyVersions` inserts every parsed entry inside one advisory-locked
  transaction without calling `validate()`. A single negative/non-finite price from the
  external LiteLLM catalog throws (DB CHECK or the insert), rolls back the transaction, and
  drops the *entire* refresh — every other price update lost to one malformed upstream row.
- **A-16 — `BUDGET_STALE_MS` vs the reconcile cron is unvalidated, so a misconfiguration
  silently breaks enforcement.** The block check treats counters older than `BUDGET_STALE_MS`
  as untrustworthy and routes through the fail mode. If the cron period exceeds `staleMs`
  (e.g. an hourly cron with the 3-minute default), the heartbeat is *always* stale between
  runs, so enforcement is perpetually in fail mode — nothing warns.
- **A-17 — the budget cache's fail modes are untested.** There is no `budget-cache.spec.ts`;
  the cold-miss-propagates-vs-serve-stale contract (which decides whether the fail mode
  engages) and the LRU/TTL/single-flight behavior have no direct coverage, so a regression in
  the enforcement-critical cache would ship green.

## What changes

- **A-12:** Add an optional `modelsPagination` hook to the HTTP adapter spec
  (`{ param, nextCursor(pageJson) }`). When present, `listModels` follows pages (appending the
  cursor query param) until `nextCursor` returns null, accumulating results with cross-page
  dedup and the existing `MAX_PARSED_MODELS` total cap plus a page-count safety bound. The
  Anthropic adapter supplies `{ param: 'after_id', nextCursor: has_more ? last_id : null }`.
  OpenAI (no hook) keeps single-page behavior byte-for-byte.
- **A-13:** `applyVersions` validates each entry. For the untrusted `refresh` source, an
  invalid entry is **skipped and logged** (the refresh continues and records the valid ones);
  for trusted sources (`bundled`/`manual`) a validation failure still throws (fail-fast — a
  bad bundled table is a real bug).
- **A-16:** At config resolution, when the reconcile scheduler is enabled, parse
  `BUDGET_SCHED_CRON` (cron-parser, already a transitive dep) to its worst-case fire gap and
  fail-fast if `BUDGET_STALE_MS` is not at least a safety factor above it — a clear boot error
  instead of silently-broken enforcement.
- **A-17:** Add `budget-cache.spec.ts` covering TTL freshness, LRU eviction at cap,
  single-flight coalescing, invalidate-on-write, **serve-stale on a refresh error**, and
  **cold-miss error propagation** (so `checkBlocked` applies the named fail mode).

## Impact

- Affected specs: `provider-adapters` (paginated model listing), `pricing-catalog`
  (refresh skips invalid rows), `spend-limits` (stale-vs-cron validation + cache fail-mode
  coverage).
- Affected code: `packages/data-plane/src/providers/http-adapter.ts`,
  `packages/data-plane/src/providers/anthropic-adapter.ts`,
  `packages/control-plane/src/pricing/pricing.service.ts`,
  `packages/control-plane/src/budgets/budgets.config.ts`.
- New test: `packages/control-plane/src/budgets/budget-cache.spec.ts`.
- No schema change, no migration. A-16 is a new boot-time fail-fast on a specific
  misconfiguration; the shipped defaults (every-minute cron, 3-minute stale) pass.
