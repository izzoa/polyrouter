# analytics-api Specification

## Purpose
TBD - created by archiving change add-analytics-api. Update Purpose after archive.
## Requirements
### Requirement: Tenant-scoped analytics aggregations over the request log

The system SHALL expose session-guarded, owner-scoped analytics reads at `/api/analytics` over the immutable RequestLog (§9): a **summary** (spend, request count, tokens, success/fallback/error counts, escalated + estimated counts, and a free/paid/unpriced request split), a **timeseries** (`date_trunc` buckets of `hour`/`day`/`week`/`month`), a **breakdown** (top-N by spend for `model`/`provider`/`agent`/`tier`), and a **paginated request listing**. Every query SHALL be scoped to the current principal (invariant 5) through the central persistence seam — no aggregate or row for another tenant is ever returned. The reads use plain SQL `GROUP BY` (no tokenizer or generative call — invariant 9).

#### Scenario: Analytics never cross tenants

- WHEN owner A requests any analytics endpoint over a range in which owner B also has request logs
- THEN only A's rows contribute to A's summary/timeseries/breakdown/listing, and none of B's spend, counts, or request rows appear

#### Scenario: A breakdown ranks a dimension by spend with resolved labels

- WHEN owner A requests a `model` (or `provider`/`agent`/`tier`) breakdown for a range
- THEN the top rows are ordered by spend descending, each carries the dimension's human label (resolved from the owned catalog, or null if that row was since deleted), and the agent breakdown attributes a cascade attempt's cost via its parent request's agent

### Requirement: Analytics spend is the immutable both-ledger total, matching budgets

Every analytics spend figure SHALL be computed from the **immutable per-request snapshot cost** recorded on the request log (invariant 4 — never re-priced against the current catalog), summing **both** cost ledgers — `request_log.cost` plus the cascade `request_attempt.cost` — with the **same per-row integer micro-dollar rounding the budget counters use** (#16), so dashboard spend reconciles with the budget a user set over the same range (a plain float sum would diverge by cents). Request counts, token totals, and the free/paid/unpriced split are over **served `request_log` rows** (one row = one user request); only spend adds the attempt ledger. Unpriced (null-cost) rows count toward request/token totals but contribute zero spend. (Because each ledger is filtered by its own `created_at`, a request whose attempt row lands just past a period boundary may split its served vs attempt cost across adjacent buckets — inherent to the two-ledger model and consistent with how budgets meter.)

#### Scenario: A cascade escalation's attempt cost is included in spend

- WHEN a request was served after a cascade escalation (a served request-log row plus a superseded `request_attempt` row, each with its own cost)
- THEN the summary/timeseries/breakdown spend for that range includes BOTH the served cost and the attempt cost — the same total the budget counters meter

#### Scenario: A later price change does not move historical analytics spend

- WHEN a model's current price is edited after some requests were recorded
- THEN analytics spend for the earlier range is unchanged (it reads the snapshots on the logs, not the current catalog)

### Requirement: The request listing is keyset-paginated with the decision inspector fields

The request listing SHALL return owner-scoped request-log rows newest-first with the transparency fields (`decision_layer` + `routing_reason`, §9) plus tokens, snapshot prices, the served cost, this request's attempt cost, latency, status, escalation, and owner-scoped model/provider/agent labels (id fallback when a catalog row was deleted), as a **safe view** that never includes ownership columns. It SHALL paginate by a stable keyset cursor (over `created_at`,`id`, tie-broken by the PK so batch-inserted equal timestamps don't skip or duplicate rows) so walking all pages returns every in-range row exactly once, and SHALL support filtering by `status`, `decision_layer`, and `escalated`.

#### Scenario: Paging walks every row once

- WHEN a client pages through the request listing for a range using the returned `nextCursor`
- THEN each in-range row appears exactly once across pages in newest-first order, and the final page returns a null cursor

#### Scenario: The listing omits ownership columns

- WHEN the request listing is returned
- THEN each row exposes the metadata/decision/cost fields but not `owner_user_id`/`org_id`

### Requirement: Analytics ranges are bounded and validated

Analytics endpoints SHALL validate their inputs: `from`/`to` are ISO timestamps with `from < to` and a bounded maximum window, `bucket`/`dimension` are from fixed allow-lists, `limit` is bounded, and a pagination cursor is well-formed — rejecting a bad request rather than issuing an unbounded scan of the hot log table. Malformed primitives/enums are rejected at the validation layer (400); the semantic range and cursor checks reject with 422. The queries SHALL be written owner-and-range-first so they are served by the `(owner_user_id, created_at)` index rather than scanning the whole log; all time math is UTC. The `bucket`/`dimension` values select fixed SQL branches — no user input is ever interpolated into a query.

#### Scenario: A malformed or unbounded range is rejected before any query

- WHEN a request has an unknown `bucket`/`dimension` or a non-ISO `from`/`to` (rejected 400 at validation), OR `from >= to`, a window beyond the allowed maximum, or a malformed cursor (rejected 422)
- THEN it is rejected and no query runs

