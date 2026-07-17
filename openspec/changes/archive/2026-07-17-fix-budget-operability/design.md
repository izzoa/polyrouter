## Context

Three independent operability gaps in the (correct, race-free) budget enforcement path. All are
"invisible degradation": the enforcement decision is right, but an operator can't see when it has
silently fallen back to the fail mode.

## Goals / Non-Goals

**Goals:** an enforcement fault is logged + metered (not swallowed); the reconcile scheduler survives a
slow Redis (heartbeat still stamped); scheduler job records stay bounded.

**Non-Goals:** changing the enforcement decision (allow/deny), the single-writer reconcile design, or
the fail-mode contract. Backlog A-17/A-18/A-19 are separate.

## Decisions

### E6.1 — Log + meter the fail-open (and fail-closed) fault

`ProxyMetrics` gains `private budgetFaults = new Counter({ name:
'polyrouter_budget_enforcement_faults_total', labelNames: ['mode'] })` and a `recordBudgetFault(mode:
'open' | 'closed')` method (best-effort, wrapped like the other emitters). `BudgetService` injects
`ProxyMetrics` + gets a `Logger`; in `checkBlocked`'s catch:

```
} catch (err) {
  this.recordFault(err);                 // rate-limited warn + metric
  if (this.failOpen) return null;
  throw new BudgetEnforcementUnavailableError();
}
```

`ProxyMetrics` reaches `BudgetService` by adding `ObservabilityModule` to `BudgetsModule.imports`
(clink round 1 — sibling `AppModule` imports don't make the provider visible inside `BudgetsModule`).
`ObservabilityModule` imports nothing, so there is no cycle; direct-construction test fixtures
(`budget-service.spec.ts`, `budget-reconcile.e2e-spec.ts`) pass a `new ProxyMetrics()`.

`recordFault` increments the counter (`mode = failOpen ? 'open' : 'closed'`) always, and `warn`s at
most once per `FAULT_WARN_WINDOW_MS` (e.g. 30s) — naming the mode + `err.constructor.name` (never the
message, which could carry data). The rate-limit is a single `lastWarnAt` timestamp (the fault is a
whole-instance condition, not per-tenant, so one global throttle is right and avoids log floods under
a sustained outage). `SpendCounter`'s connect/error swallow (`.catch(() => {})` and the `'error'`
handler) gets a `Logger` warn (also throttled) so a connection that never comes up is visible; the
per-command rejection still surfaces through `checkBlocked`'s metric.

*Alternative rejected:* a metric only (no log) — an operator watching logs, not Prometheus, would
still miss it; both are cheap.

### E6.2 — Bounded job retention

Both schedulers call `queue.upsertJobScheduler(id, { pattern, tz }, { name: JOB_NAME })`. Add the
job-template `opts` mirroring `notify.queue`'s `BASE_JOB_OPTS`:

```
{ name: JOB_NAME, opts: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } } }
```

BullMQ 5 applies the scheduler template's `opts` to every produced job, so completed records are GC'd
after an hour and failed after a day, instead of accumulating ~525k/year in the enforcement Redis.

### E6.3 — A separate reconcile connection

`SpendCounter` builds TWO duplicated connections:

- `readConn` — the existing fail-fast (`commandTimeout: redisTimeoutMs` = 50ms, `enableOfflineQueue:
  false`, `maxRetriesPerRequest: 1`). Used by `read` (hot-path block check), `heartbeatAgeMs` (also
  hot-path), and `markBlockOnce` (fire-and-forget from `emitBlock`). A slow Redis MUST fail these fast.
- `writeConn` — a generous `commandTimeout: reconcileTimeoutMs` (default 2000ms), same offline/retry
  posture. Used by the scheduler-only `reconcileMax`, `heartbeatSet`, and `markAlertOnce`. A
  managed-Redis RTT of ~100ms then completes the reconcile and stamps the heartbeat, instead of failing
  at 50ms and letting the heartbeat go stale (which would route all block budgets through the fail
  mode — silent-allow by default, or spurious 503s under fail-closed).

**`markOnce` must split (clink round 1):** it is called from two paths with opposite timeout needs —
`emitBlock`'s fire-and-forget block-notify dedup (hot-path-adjacent → fail-fast) AND the scheduler's
alert dedup, which the occurrence **awaits before `heartbeatSet`**. If the scheduler's `markOnce` were
on the 50ms `readConn`, a slow Redis would time it out and abort the occurrence *before* the heartbeat
stamp — recreating the exact stale-heartbeat failure E6.3 fixes. So split into `markBlockOnce`
(readConn) and `markAlertOnce` (writeConn); the scheduler's alert loop calls `markAlertOnce`,
`emitBlock` calls `markBlockOnce`. (Emission still only follows a winning `SET NX`, so this affects
alert *timing/loss under a slow Redis*, never double-alerts.) The generous connection alone isn't
enough (clink round 2): the occurrence AWAITS `markAlertOnce` before `heartbeatSet`, so a
marker-*specific* fault (not just a slow RTT) could still abort the heartbeat. Alert dedup is not
required for counter correctness, so `runBudgetOccurrence` wraps the per-budget alert step
(`markAlertOnce` + emit) in a `try/catch` that logs and continues — the reconcile writes and heartbeat
stamp stay on the enforcement-critical path, the alert step is best-effort. (The fail-mode warn also
states the actual outcome — "request allowed" vs "request rejected (503)" — not a blanket "admitted".)

`waitReady` waits on `readConn` (the enforcement-critical path); `onApplicationShutdown` disconnects
both; both attach the crash-proof `'error'` handler.

*Alternative rejected:* raising the single connection's timeout to 2s — that would slow the HOT-PATH
block check (which must fail fast at 50ms to not add latency, invariant 11). The split keeps each path
on its correct bound.

## Risks / Trade-offs

- **[Two connections double the Redis client count]** — negligible (2 vs 1 per instance); both share the
  base client config and are lazy.
- **[Warn throttle could hide a mode flip]** — the metric is always incremented (unthrottled) and
  labeled by mode, so a fail-open→fail-closed change is visible in Prometheus even if the log is
  throttled; the throttle only bounds log volume.
- **[Retention age vs. debugging]** — 1h completed / 1d failed matches the existing `notify.queue`
  precedent; failed jobs stay a day for triage.

## Migration Plan

Code-only; no schema migration. `BUDGET_RECONCILE_TIMEOUT_MS` is optional (default 2000), so existing
deployments behave identically except the reconcile path tolerates a slower Redis. Rollback is a revert.

## Open Questions

None.
