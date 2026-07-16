---
'@polyrouter/shared': minor
'@polyrouter/control-plane': minor
---

Add the analytics aggregation API (#17, spec §9) — the tenant-scoped `/api/analytics` endpoints that power the dashboard's Observe pages (unblocks #19). A new owner-scoped `analytics` accessor on the central `PersistencePort` (every query carries `ownershipPredicate` — no unscoped-by-owner fetch, invariant 5) with four reads over the immutable RequestLog (#11) + its cascade `request_attempt` cost ledger (#14), plus a session-guarded `AnalyticsController`:

- `GET /summary` — spend, request count, tokens, success/fallback/error counts, escalated + estimated counts, and a free/paid/unpriced request split.
- `GET /timeseries` — `date_trunc` buckets (`hour`/`day`/`week`/`month`, UTC-aligned to match #16's periods) for the messages-over-time / spend charts.
- `GET /breakdown` — top-N by spend for `model`/`provider`/`agent`/`tier`, with owner-scoped labels (null if the catalog row was deleted; the `agent` breakdown attributes cascade attempts via their parent).
- `GET /requests` — keyset-paginated request log with the `decision_layer` + `routing_reason` inspector fields, per-row attempt cost, and model/provider/agent labels, filterable by status/layer/escalated.

Spend sums BOTH cost ledgers with the **same per-row integer micro-dollar rounding the budget reader uses** (#16), so dashboard spend reconciles with the budget a user set (a float sum would diverge by cents); it reads the immutable per-request snapshots and is never re-priced (invariant 4). Request counts, tokens, and the free/paid split are over served `request_log` rows; only spend adds the attempt ledger. All aggregation is plain SQL — no tokenizer or generative call (invariant 9). Inputs are validated (bad enum/ISO → 400; `from ≥ to` / an over-400-day window / a malformed cursor → 422); the `bucket`/`dimension` values select fixed SQL branches so no user input is interpolated into a query. No schema change (reuses the `(owner_user_id, created_at)` composite index from #16) and no new deps. The analytics UI, a subscription-vs-API cost split, and zero-filled buckets are deferred (#19 / cloud graduations).
