---
'@polyrouter/control-plane': patch
---

Make budget-enforcement degraded modes visible and self-healing (FABLE_AUDIT E6).

**Enforcement faults are metered and logged, not swallowed (E6.1).** Any budget-check fault (Redis timeout, cold-cache DB failure, stale reconcile heartbeat) was silently caught to allow-under-fail-open with no signal — an instance with a broken budget connection admitted unlimited spend for weeks, invisibly. Faults now increment a new `polyrouter_budget_enforcement_faults_total{mode="open"|"closed"}` metric (always) and log a rate-limited warn (naming the fail mode and error class — never the error message) stating the actual outcome (allowed vs 503). Allow/deny behavior is unchanged. The `SpendCounter`'s previously silent connect/error swallow is likewise logged.

**Bounded scheduler job retention (E6.2).** The per-minute reconcile scheduler and the weekly-summary scheduler set no BullMQ retention, so completed/failed job records accumulated forever in the same Redis holding the spend counters and breaker state. Both now carry `removeOnComplete: { age: 3600 }` / `removeOnFail: { age: 86400 }` (mirroring the notification queue).

**Reconcile writes get their own connection (E6.3).** The scheduler's reconcile writes shared the 50ms fail-fast hot-path connection, so a managed-Redis RTT near/above 50ms failed every reconcile before the heartbeat was stamped — after `BUDGET_STALE_MS` all block budgets routed through the fail mode. `SpendCounter` now uses a fail-fast connection for the hot-path block check and a generous one (`BUDGET_RECONCILE_TIMEOUT_MS`, default 2s) for the scheduler's reconcile + alert-dedup writes. The alert-dedup step is also made best-effort so a marker fault can never abort the occurrence and skip the heartbeat.

No schema migration. New operator knob `BUDGET_RECONCILE_TIMEOUT_MS` (default 2000) and metric `polyrouter_budget_enforcement_faults_total`.
