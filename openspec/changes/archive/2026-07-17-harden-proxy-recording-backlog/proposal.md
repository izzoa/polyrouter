# Harden the proxy request-path & recording backlog (A-3, A-10, A-14, A-15)

## Why

Four backlog findings from `FABLE_AUDIT.md` (Appendix A) share one theme — the proxy
request lifecycle and its recording/observability path record or degrade in ways that
silently distort the numbers operators trust (error rate, spend, breaker health):

- **A-3 — a client abort is recorded as a provider `error` and fires the failure-spike
  notify.** The breaker was already taught that a client disconnect is neutral (commit
  `8abd4b6`), but the *recording* path still writes `status='error'` and calls
  `notifyFailed` when the caller's own `AbortSignal` tripped. A client hanging up inflates
  the error-rate metric and can trip a false `request_failures_spike` alert — a provider
  outage the provider never had.
- **A-10 — the production breaker wires no `onError`, so a Redis-outage degradation is
  silent.** When the shared Redis breaker store faults, `CircuitBreaker` falls back to the
  per-instance in-memory store — the circuit stops being coordinated across replicas — but
  the production factory passes no `onError`, so nothing is logged or metered. Operators
  can't tell the breaker is running degraded.
- **A-14 — one orphaned cascade attempt FK-poisons its whole per-owner batch.** The
  log-writer inserts all of a principal's `request_attempt` rows in one `insertMany`. If a
  single attempt's parent `request_log` was dropped (its group's insert gave up, or it was
  queue-evicted), that attempt violates the FK and fails the *entire* owner batch — dropping
  valid sibling rows whose parents *were* written, and re-failing identically on every retry.
- **A-15 — the weekly-spend reader sums raw floats, diverging sub-µ$ from every other
  reader.** Budget enforcement and analytics sum `round(cost × 1e6)` per row (integer
  micro-dollars) so figures reconcile exactly; the weekly summary sums `sum(cost)` as a
  float, so a week's summary can disagree with the dashboard/budget at the sub-cent margin.

## What changes

- **A-3:** Thread the caller-abort signal into the proxy's failure-recording sites. When
  the chain fails because the *client* aborted, record a new `status='cancelled'` (distinct
  from `error`, so the `errorCount` query and `requests_total{status}` series stay clean)
  and skip `notifyFailed`. Adds `'cancelled'` to `RecordStatus` and the writer's draft
  status union. Applies to the buffered chain, the streaming chain (pre- and post-commit),
  and both cascade paths.
- **A-10:** Wire an `onError` into the production `PROXY_BREAKER` factory that (a) increments
  a new `polyrouter_breaker_store_faults_total` counter and (b) logs a throttled (once/60s)
  WARN naming only `err.code ?? err.name` (never the message — invariant 8), so a degraded
  breaker is observable without amplifying the log during the outage.
- **A-14:** In the writer's flush, record which `request_log` ids were actually written this
  cycle and drop any attempt whose parent is not among them *before* grouping — counted and
  logged like any other drop. An orphan can't be inserted regardless (no parent row); this
  just stops it from poisoning valid siblings.
- **A-15:** Sum the weekly ledgers with the same `round(cost × 1e6)` per-row micro-dollar
  aggregate the budget/analytics readers use, converting to dollars once at the end, so the
  weekly summary reconciles exactly with every other spend figure.

## Impact

- Affected specs: `inference-proxy` (client-abort recording), `observability` (breaker-store
  fault visibility), `request-logging` (orphan-attempt isolation), `notification-producers`
  (weekly µ$ reconciliation).
- Affected code: `packages/control-plane/src/proxy/proxy.service.ts`,
  `packages/control-plane/src/recording/{request-recorder,log-writer}.ts`,
  `packages/control-plane/src/observability/proxy-metrics.ts`,
  `packages/control-plane/src/proxy/proxy.module.ts`,
  `packages/control-plane/src/database/weekly-spend.reader.ts`.
- No schema change: `request_log.status` is free-form `text`; `'cancelled'` is a new value,
  not a new column. No migration.
- Backward-compatible: existing `success`/`error`/`fallback` semantics are unchanged; the
  new status only appears for client-initiated aborts that previously mis-recorded as errors.
