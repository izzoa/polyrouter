## 1. E6.1 — Log + meter enforcement faults

- [x] 1.1 In `proxy-metrics.ts`, add `budgetFaults = new Counter({ name: 'polyrouter_budget_enforcement_faults_total', help, labelNames: ['mode'], registers: [...] })` and a best-effort `recordBudgetFault(mode: 'open' | 'closed')` (wrapped like the other emitters).
- [x] 1.2 In `budget-service.ts`, inject `ProxyMetrics`, add a `Logger`, and a private `recordFault(err)` that increments `recordBudgetFault(this.failOpen ? 'open' : 'closed')` (always) and `warn`s at most once per `FAULT_WARN_WINDOW_MS` (~30s via a single `lastWarnAt`), naming the mode + `err?.constructor.name` (never the message). Call it in `checkBlocked`'s catch before the fail-mode branch. Wire it up: add `ObservabilityModule` to `BudgetsModule.imports` (no cycle — it imports nothing), and update the direct-construction fixtures (`budget-service.spec.ts`, `budget-reconcile.e2e-spec.ts`) to pass `new ProxyMetrics()`.
- [x] 1.3 In `spend-counter.ts`, give the constructor a `Logger` and replace the silent `.catch(() => {})` connect swallow + the `'error'` handler with a throttled warn (a connection that never comes up is visible; per-command faults still surface via 1.2's metric).
- [x] 1.4 Unit tests in `budget-service.spec.ts` (fake timers): (a) a failing `counter.read` under fail-open → `checkBlocked` admits AND `recordBudgetFault('open')` + a warn fire; fail-closed → throws `BudgetEnforcementUnavailableError` + metric `mode='closed'`; (b) TWO faults inside the 30s window → TWO metric increments but ONE warn; a fault after the window warns again; (c) the warn contains the error CLASS and NOT a sentinel error message (no data leak). A `spend-counter` test asserts a connect/`'error'` event is warned (throttled) on both connections.

## 2. E6.2 — Bounded BullMQ job retention

- [x] 2.1 In `budget.scheduler.ts` `applySchedule`, add the job template `opts: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } }` to the `upsertJobScheduler(id, {pattern,tz}, { name: JOB_NAME, opts })` call (mirroring `notify.queue`'s `BASE_JOB_OPTS`).
- [x] 2.2 Same in `weekly-summary.scheduler.ts` `applySchedule`.
- [x] 2.3 Coverage: the schedulers construct their `Queue` internally (not injected), so a dedicated template-opts unit test would require mocking the whole `bullmq` module — disproportionate for a 2-line mirror of `notify.queue`'s already-tested `BASE_JOB_OPTS`. The shape is compile-checked (`JobsOptions`) and the real registration is exercised by `budget-reconcile.e2e`; rely on those rather than a literal-asserting mock.

## 3. E6.3 — A separate reconcile connection

- [x] 3.1 In `budgets.config.ts`, register `BUDGET_RECONCILE_TIMEOUT_MS` (coerce int, min 1, default 2000); add `reconcileTimeoutMs` to `BudgetsRawConfig`, `BudgetsConfig`, and `resolveBudgetsConfig`.
- [x] 3.2 In `spend-counter.ts`, build two duplicated connections: `readConn` (existing fail-fast `redisTimeoutMs`) for `read`/`heartbeatAgeMs`; `writeConn` (`reconcileTimeoutMs`) for `reconcileMax`/`heartbeatSet`. Split `markOnce` into `markBlockOnce` (readConn, fail-fast) and `markAlertOnce` (writeConn, generous); update call sites — `emitBlock` → `markBlockOnce`, `budget.scheduler`'s alert loop → `markAlertOnce`. Both connections get the crash-proof `'error'` handler + lazy connect; `waitReady` waits on `readConn`; `onApplicationShutdown` disconnects both.
- [x] 3.3 Unit test: a fake `writeConn` whose commands resolve after ~100ms lets `reconcileMax`/`heartbeatSet`/`markAlertOnce` complete (generous timeout), while a `readConn` with a 50ms bound rejects a ~100ms `read` — proving the split. Include an over-threshold-alert path assertion that the occurrence reaches `heartbeatSet` (the scheduler's `markAlertOnce` doesn't abort it under a slow Redis).

## 4. Verification & wrap-up

- [x] 4.1 `npm run build && npm run lint && npm run typecheck` clean.
- [x] 4.2 `npm test -w packages/control-plane` green (budget-service, spend-counter, scheduler specs); `npm run test:e2e -w packages/control-plane` green (budget-proxy, metrics e2e — assert the fault counter appears).
- [x] 4.3 Changeset (operator-facing: new `budget_enforcement_faults_total` metric + `BUDGET_RECONCILE_TIMEOUT_MS`).
- [x] 4.4 Update `TODOS.md` board + mark E6 tasks ✅ in `FABLE_AUDIT.md` after archive.
