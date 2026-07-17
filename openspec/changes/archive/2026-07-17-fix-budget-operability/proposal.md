## Why

The budget-enforcement design is race-free and correct, but its degraded modes are invisible and one
of them is self-inflicted (FABLE_AUDIT E6). Under the default fail-open, any enforcement fault (Redis
timeout, cold-cache DB failure, stale heartbeat) is swallowed to `null` (allow) with **no log line and
no metric** — a single instance with a broken budget connection admits unlimited spend for weeks,
invisibly (the spend-limits design doc flagged the missing metric; it was never added). The reconcile
scheduler's writes share the 50ms fail-fast hot-path connection, so a managed-Redis RTT near/above
50ms fails every reconcile before the heartbeat is stamped → after `BUDGET_STALE_MS` all block budgets
route through the fail mode. And the per-minute reconcile + weekly-summary BullMQ jobs set no
retention, so completed/failed job records accumulate forever in the same Redis holding the spend
counters and breaker state.

## What Changes

- **E6.1** `BudgetService.checkBlocked`'s bare `catch` gains a rate-limited/deduped `warn` (naming the
  engaged fail mode + error class) and a new ProxyMetrics counter
  `polyrouter_budget_enforcement_faults_total{mode="open"|"closed"}`. Allow/deny behavior is unchanged.
  The same warn is applied to `SpendCounter`'s silent connect/error swallow.
- **E6.2** Both scheduler job templates (`budget.scheduler`, `weekly-summary.scheduler`) gain the
  `notify.queue` `BASE_JOB_OPTS` retention (`removeOnComplete: { age: 3600 }`, `removeOnFail:
  { age: 86400 }`), so completed/failed job records stay bounded instead of growing unbounded.
- **E6.3** `SpendCounter` splits into two connections: the existing fail-fast (50ms) connection stays
  for the hot-path block-check `read`, `heartbeatAgeMs`, and the fire-and-forget `markOnce`; a new
  connection with a generous timeout (`BUDGET_RECONCILE_TIMEOUT_MS`, default 2s) handles the scheduler's
  `reconcileMax` and `heartbeatSet`, so a slow-but-healthy Redis still stamps the heartbeat and keeps
  block enforcement available.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `spend-limits`: enforcement faults SHALL be logged (rate-limited) and metered; reconcile writes SHALL
  use a separate generous-timeout connection so a slow Redis doesn't stall the heartbeat; the reconcile
  scheduler's job records SHALL be retention-bounded.
- `observability`: `/metrics` SHALL expose `polyrouter_budget_enforcement_faults_total{mode}`.
- `notification-producers`: the weekly-summary scheduler's job records SHALL be retention-bounded.

## Impact

- **Code:** `budgets/budget-service.ts` (Logger + ProxyMetrics inject, fault log+metric),
  `observability/proxy-metrics.ts` (new counter + `recordBudgetFault`), `budgets/spend-counter.ts`
  (second connection + connect-swallow warn), `budgets/budgets.config.ts`
  (`BUDGET_RECONCILE_TIMEOUT_MS`), `budgets/budget.scheduler.ts` + `producers/weekly-summary.scheduler.ts`
  (job-template retention).
- **Tests:** `budget-service.spec.ts` (failing read + fail-open → warn/metric invoked), a delayed-fake
  connection test for the reconcile split, scheduler template opts asserted.
- **No migration.** **Changeset:** operator-facing (new fault metric + `BUDGET_RECONCILE_TIMEOUT_MS`).
  Backlog A-17/A-18/A-19 (budget-cache e2e, cron/stale pairing, CRUD input validation) are out of scope.
