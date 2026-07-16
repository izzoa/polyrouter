# Design: add-analytics-api

## Context

Reuses: #11's `request_log` (immutable per-request metadata + snapshot `cost`, `status ∈ {success,fallback,error}`, `escalated`, `decision_layer`, `routing_reason`, `usage_estimated`, denormalized `agent_id`/`provider_id`/`model_id`, `tier_assigned` = tier KEY, token columns); #14's `request_attempt` cascade cost ledger (its own `cost`/`model_id`/`provider_id`/`tier_key` + token columns, but **no `agent_id`** — attempts attribute to their parent log); the `(owner_user_id, created_at)` composite index on BOTH tables (added #16) that makes the range scans index-served; #2's `PersistencePort` + `ownershipPredicate` owner-scoping seam + `SessionGuard`/`@CurrentPrincipal()`; the providers/budgets controller+DTO patterns. Governing invariants: **5** (owner-scoped, central), **4** (immutable snapshot cost), **9** (no hot-path tokenizer/LLM — plain SQL). No schema change, no new deps.

## Decision 1 — A tenant-scoped `analytics` accessor on the PersistencePort

Owner-scoping is the load-bearing property, so analytics reads go through the **same central seam** as every other owned access (invariant 5): `PersistencePort.analytics: AnalyticsAccessor`, built in `port.ts`, every query gated by `ownershipPredicate(requestLogs|requestAttempts, principal)`. The (substantial) SQL lives in a new `control-plane/database/analytics.queries.ts` (`createAnalyticsAccessor(db)`) so `port.ts` stays lean; it is a pure reads accessor — no writes, no cross-owner path.

```
interface DateRange { from: Date; to: Date }              // half-open [from, to)
type Bucket = 'hour' | 'day' | 'week' | 'month'
type BreakdownDimension = 'model' | 'provider' | 'agent' | 'tier'

interface AnalyticsAccessor {
  summary(p: Principal, r: DateRange): Promise<AnalyticsSummary>
  timeseries(p: Principal, r: DateRange, bucket: Bucket): Promise<TimeseriesPoint[]>
  breakdown(p: Principal, r: DateRange, dim: BreakdownDimension, limit: number): Promise<BreakdownRow[]>
  listRequests(p: Principal, q: RequestsQuery): Promise<RequestsPage>   // rows: RequestLogRow[]
}
```

## Decision 2 — Spend sums BOTH ledgers in µ$ (reconciles with budgets, immutable)

Spend is computed **exactly as #16's budget reader** so the dashboard figure reconciles with the budget a user set (not merely "the same ledgers"): per-row integer **micro-dollars** `sum(round(coalesce(cost,0) * 1000000))` over EACH ledger, summed, divided by `1e6` for the API's dollar response. Using `sum(cost)` (float) instead would diverge from #16's per-row rounding by cents at volume — so the µ$ expression is load-bearing, not cosmetic. Costs are the immutable per-request snapshots (invariant 4); no re-pricing. A null (unpriced) row contributes 0 spend but still counts as a served request / its tokens.

**Reconciliation caveat (documented):** budgets bucket by UTC calendar period; analytics by an arbitrary `[from,to)`. Both filter EACH ledger by its **own** `created_at` (exactly as `budget.reader.ts`), so for identical range boundaries the two select the same rows and totals agree. But a logical request whose attempt row was inserted a moment later can have its served vs attempt cost fall on **opposite sides of a boundary** (the two rows carry independent DB-default `created_at`s) — so a single request's cost may split across adjacent periods. This is inherent to the two-ledger model and matches how budgets already meter; it is documented, not "fixed" here.

**Served-row semantics:** `requests`, all token totals, and the free/paid/unpriced split classify **served `request_log` rows** (one row = one user request); only `spend` adds the cascade-attempt ledger. So a served request with a null-cost attempt still classifies by its served cost (its unpriced attempt just adds 0 spend) — stated in the contract.

- **summary**: one aggregate over `request_log` (count, token sums, µ$ spend, `count(*) filter (where status='success'|'fallback'|'error')`, `filter (where escalated)`, `filter (where usage_estimated)`, free/paid/unpriced = `filter (where cost=0 / cost>0 / cost is null)`) + a µ$ `sum` over `request_attempt`; add the two µ$ spends and `/1e6` in JS.
- **timeseries**: `date_trunc(<unit>, created_at AT TIME ZONE 'UTC')` (UTC-aligned, matching budgets' UTC periods — NOT the session tz) grouped over each ledger; merge the two bucket→metrics maps in JS (attempts bucket by their own `created_at`). Sparse (only non-empty buckets), ascending; the UI fills gaps.
- **breakdown**: `model`/`provider`/`tier` union both ledgers grouped by their own id / `tier_key` (log uses `tier_assigned`); `agent` groups `request_log` by `agent_id` and INNER-JOINs `request_attempt` to its parent log for `agent_id` — with `ownershipPredicate` on **BOTH** `request_attempt` AND the joined `request_log` (attempt ownership is independent of its parent's; belt-and-suspenders against a mismatched row). `spend` (µ$) from both ledgers, `requests` = request_log rows for the dimension (a model/provider seen only as a cascade attempt shows spend with 0 served requests — rare, documented). Order by spend desc, take `limit`. `label` via **owner-scoped** LEFT JOIN — providers/agents joined on `id = key AND owner = principal`, models through their provider (`ownedProviderIds`), so a deleted or foreign id yields `label:null`, never another tenant's name. A null dimension key → `key:''`, `label:null`.

## Decision 3 — `listRequests`: keyset pagination + labelled safe view

Keyset (not OFFSET) so deep pages stay index-served on `(owner_user_id, created_at)`: `WHERE owner=… AND created_at ∈ [from,to) [AND status=… AND decision_layer=… AND escalated=…] AND (created_at, id) < (cursor.created_at, cursor.id) ORDER BY created_at DESC, id DESC LIMIT limit+1`. `id` (the PK) is the deterministic tiebreak (batch inserts make equal `created_at`s common, so the tuple comparison — not `created_at` alone — is essential). **Pagination fix:** fetch `limit+1`, `hasMore = rows.length > limit`, return `rows.slice(0, limit)`, and set `nextCursor` from the **last RETURNED** row (`rows[limit-1]`) when `hasMore`, else null — computing the cursor from the extra (limit+1)th row would skip it. Cursor = `base64("<createdAtISO>|<id>")`, decoded + shape-validated (bad → 422).

Filters: `status`, `decisionLayer`, and **`escalated`** (the Requests UI filters on it). The controller maps `RequestLogRow` → a **safe view**: drops `ownerUserId`/`orgId`; keeps the inspector fields (`decisionLayer`, `routingReason`, tokens, snapshot prices, `cost` [served], `durationMs`, `status`, `escalated`, `usageEstimated`, `qualitySignal`, the denormalized ids + `tierAssigned`); adds **owner-scoped labels** (`modelLabel`=externalModelId, `providerLabel`=name, `agentLabel`=name — LEFT JOINs scoped like the breakdown, null if deleted, so the table renders names without the client re-resolving) and **`attemptCostMicros`** (a correlated `sum(round(cost*1e6))` of this request's `request_attempt` rows, 0 if none) so the UI can show `total = servedCost + attemptCost` reconciling with summary spend.

## Decision 4 — Controller + DTOs (`/api/analytics`, session-guarded)

`AnalyticsController` (`@Controller('api/analytics')`, session guard covers `/api`), `@CurrentPrincipal()` on every route:

- `GET /summary`, `/timeseries`, `/breakdown`, `/requests`, each a class-validated query DTO. **Primitive/enum validation is DTO-level → 400** (the global `ValidationPipe` default — `@IsISO8601` `from`/`to`, `bucket` `@IsIn(['hour','day','week','month'])` default `day`, `dimension` `@IsIn(['model','provider','agent','tier'])`, `limit` `@IsInt @Min(1) @Max(100)` default 10/50, `status`/`layer` optional `@IsString`, `escalated` optional bool, `cursor` optional `@IsString`). **Semantic checks are service-level → 422** (`UnprocessableEntityException`): `from < to`, `to − from ≤ MAX_RANGE_MS` (400 days) so a pathological range can't scan the whole table, and cursor decode (`base64 "<iso>|<id>"`, else 422). All time math is **UTC** (buckets via `AT TIME ZONE 'UTC'`, matching #16). Responses are safe views; the API returns raw counts (the client derives rates).

## Decision 5 — Test strategy

- **Correctness e2e (real Postgres):** seed a fixed set of `request_log` + `request_attempt` rows for two owners across a known time span, then assert: `summary` totals/counts/free-paid/estimated; `spend` **includes attempt cost** (a request with an escalation attempt sums both); `timeseries` buckets by hour/day with the right per-bucket sums; `breakdown` top-N ordering by spend + correct labels + the `agent` attempt-via-parent attribution + a null-key row; `listRequests` keyset pagination walks all rows once with a stable `nextCursor` and honors `status`/`layer` filters. **Tenant isolation:** owner B's seeded rows never appear in owner A's summary/timeseries/breakdown/requests; a cross-owner total is impossible through the accessor. **Range guard:** `from ≥ to` and an over-long window → 422; a malformed `cursor` → 422.
- **Adversarial ownership:** seed an owner-A `request_attempt` whose parent `request_log` is owner B's (a mismatch the insert path doesn't prevent) and assert the agent breakdown never surfaces B's `agent_id`/label to A (both-sides `ownershipPredicate`).
- **Index check (not a brittle EXPLAIN-no-seqscan):** Postgres correctly chooses a seq scan on a tiny test table, so asserting "no Seq Scan" is flaky. Instead assert the `request_log_owner_created_idx` index **exists** (via `pg_indexes`) and that the queries are written owner+range-first so they are index-eligible; document that a per-query `statement_timeout` (deferred to config) is the operational cardinality guard and the 400-day window bounds the *range*, not row count.

## Risks / trade-offs

- **Sparse buckets** — `timeseries` returns only non-empty buckets; the UI zero-fills. Server-side `generate_series` gap-filling is deferred (avoids a heavier query for a UI concern).
- **Attempt-only dimensions** — a model/provider seen only as a cascade attempt shows spend with 0 served `requests` in a breakdown; documented, rare.
- **No subscription-vs-API split** — the free/paid split is by cost (0 / >0 / null); a subscription-vs-API sub-split needs provider-kind denormalized onto the log (deferred).
- **In-JS ledger merge** — timeseries/breakdown merge two grouped result sets in JS rather than a SQL `UNION ALL` subquery; simpler and clearer at dashboard volumes, and both inputs are already index-served + bounded by the range.
- **The range guard bounds range, not cardinality** — the `(owner, created_at)` index locates the owner+range efficiently, but grouping millions of rows within a 400-day window is still work. The operational guard is a `statement_timeout` (deferred to config) and, at true multi-tenant volume, the §3.3 Timescale continuous-aggregate graduation — not this baseline.
- **Cross-boundary split** — a request whose attempt row lands just past a period boundary can split its served vs attempt cost across adjacent buckets (independent `created_at`s); inherent to the two-ledger model, matches budgets, documented (Decision 2).
- **No new migration / deps.**
