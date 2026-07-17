# Tasks — harden the proxy request-path & recording backlog

## A-3 — client abort is `cancelled`, not a provider error
- [x] Add `'cancelled'` to `RecordStatus` (`recording/request-recorder.ts`) and to both draft
      status unions in `recording/log-writer.ts`.
- [x] Route the buffered `completion` failure, the `stream` pre-commit failure, and both
      cascade non-escalation error sites through the caller-abort decision.
- [x] In the `stream` post-commit `.then`, map an `error` outcome to `cancelled` on a caller
      abort and guard `notifyFailed` accordingly.

## A-10 — breaker store degradation is observable
- [x] Add a `polyrouter_breaker_store_faults_total` counter + `breakerStoreDegraded()` method
      to `ProxyMetrics`.
- [x] In the `PROXY_BREAKER` factory (`proxy.module.ts`), inject `ProxyMetrics` and wire
      `onError` (extracted, testable `breakerStoreErrorHandler`): increment the counter and log
      a throttled (once/60s) **static** WARN. The hook never reads the error and never throws.

## A-14 — orphaned attempt does not poison its batch
- [x] `writeGroup` records each successfully-inserted `request_log` id into a shared `Set`.
- [x] `flushOnce` partitions attempts into insertable vs orphaned, counts+logs the orphans,
      and only groups the insertable ones.
- [x] Defer the threshold flush to a microtask so a same-tick parent+attempt never split.

## A-15 — weekly spend reconciles in micro-dollars
- [x] Extract the `microsSum` SQL fragment into `database/cost-sql.ts`; import it in
      `weekly-spend.reader.ts`, `budget.reader.ts`, and `analytics.queries.ts` (one definition).
- [x] `weeklySpendByOwner` sums both ledgers in µ$ and converts to a dollar `total` once.

## Review-driven hardening (codex, 4 rounds)
- [x] **Causal termination, not a mutable signal.** `StreamOutcome` + `BufferedChainResult` +
      `StreamChainResult` carry `callerAborted`, captured at the failure boundary from the PURE
      client predicate (the composite work signal stops the loop but never sets the cause); the
      streaming outcome settles in `buildFrames`' catch BEFORE the terminal frame so a consumer
      `return()` can't overwrite a provider-error cause. Deleted the signal-based helper.
- [x] **Breaker log is static** (no error read at all) — closes the accessor-reread / identifier
      -shaped-secret / injection class outright.
- [x] **Frontend `cancelled` status** across `RequestStatus` + the exhaustive badge/dot/text
      maps, with neutral fallbacks so a free-form/legacy DB status can't crash the inspector.

## Verification
- [x] `npm run build`, lint, typecheck clean.
- [x] Unit: log-writer (orphan isolation + batch-race), breaker-observability (static/throttle/
      null-safe), core (callerAborted discriminator), frontend maps.
- [x] e2e: stream-lifecycle (client disconnect → `cancelled`, no spike notify), cascade-routing
      (real supertest client abort → `cancelled`), notification-producers (weekly µ$ = budget µ$).
- [x] Changeset added (user-facing: metric accuracy, new counter, `cancelled` status).
