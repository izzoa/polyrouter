# Design — harden the proxy request-path & recording backlog

## A-3 — client abort is `cancelled`, never a provider error

**Root cause.** `runBufferedChain`/`openStreamChain` return
`ProviderError('unavailable', 'cancelled')` on a caller abort, indistinguishable at the
call site from a genuine upstream failure. The proxy records `status='error'` and calls
`notifyFailed` at every failure site. The breaker already disambiguates via the
`isCallerAbort` predicate (commit `8abd4b6`); the recording path never got the same seam.

**Decision.** Decide the recorded status from the *pure client signal* at record time, not
from the error. A single helper centralizes it:

```ts
// signal.aborted at record time ⇒ the CLIENT tore this down: not a provider error
// and not an alertable failure (mirrors the breaker's neutral treatment, A-3).
private recordChainFailure(ctx: RecordingContext, signal: AbortSignal): void {
  const cancelled = signal.aborted;
  this.recorder.record(ctx, { status: cancelled ? 'cancelled' : 'error', outputChars: 0 });
  if (!cancelled) this.notifyFailed(ctx.principal);
}
```

Used at the buffered-chain failure, the stream pre-commit failure, and both cascade
non-escalation error sites. The stream **post-commit** `.then` is special: it already
maps `o.status === 'error'` → `error`; that becomes
`o.status === 'error' ? (signal.aborted ? 'cancelled' : 'error') : …` with the notify
guarded the same way — a mid-stream client disconnect (which the adapters normalize to a
provider error the outcome surfaces) is `cancelled`, not `error`.

**Why a new status, not "skip recording".** The request happened and consumed routing
work; dropping it loses observability. `cancelled` keeps the row visible while the
`errorCount` query (`status = 'error'`) and `requests_total{status}` series stay accurate.
`request_log.status` is free-form `text`, so no migration; `RecordStatus` gains
`'cancelled'` and both writer draft unions follow.

**Causal capture, not a mutable signal at record time.** The abort state is captured at the
**failure boundary** and carried on the result, never re-read from the `AbortSignal` after
the fact:
- Streaming: `StreamOutcome.callerAborted` is set inside `buildFrames`' `catch` (and
  `settle` is called there, *before* the terminal frame is yielded, so a consumer
  `return()` during the terminal-frame suspension can't overwrite the provider-error cause);
  a consumer `return()` (`onEarlyEnd`) is inherently a caller stop → `callerAborted=true`.
- Buffered/pre-commit: `BufferedChainResult`/`StreamChainResult` carry `callerAborted`, set
  from the pure client signal (what the breaker also trusts) at the point the chain gives up
  — the adapters normalize a caller abort into `unavailable`, so the error alone can't
  distinguish it.

**Known residual (accepted).** The buffered/pre-commit `callerAborted` is read at the chain
boundary, which is still *after* the per-attempt breaker-persistence `await` inside
`withBreaker`. So the one narrow race that remains is: a genuine provider failure whose
client disconnects during that sub-millisecond persistence window records `cancelled` and
skips one notify. Fully closing it needs an explicit `provider_error | client_abort |
system_abort` cause threaded through the breaker itself — a larger data-plane refactor
deferred here. Impact is negligible: a real provider outage fails the majority of requests
with clients still connected, so the spike alert still fires; only a request the client
already abandoned is under-counted. A system-shutdown abort also maps to `cancelled`/no-notify,
which is the intended behavior (a drained straggler is not a provider fault).

**Scope guard.** The cascade escalation sites that already record `error` on a *provider*
failure are unchanged where the failure is genuinely upstream; only the caller-abort branch
flips to `cancelled`. The existing "signal.aborted ⇒ no escalation, no notifyFailed" cascade
branches already skip notify — this change makes their recorded **status** `cancelled` too,
for consistency.

## A-10 — breaker store degradation is observable

**Root cause.** `CircuitBreaker.onError` defaults to a no-op; production passes no override,
so the Redis→in-memory fallback is silent.

**Decision.** In the `PROXY_BREAKER` factory, inject `ProxyMetrics` alongside `REDIS_CLIENT`
and wire `onError` to:
- `metrics.breakerStoreDegraded()` — a new `polyrouter_breaker_store_faults_total` counter
  (no labels; the fault is store-wide, not per-provider), so operators can alert on it.
- a **time-throttled** WARN (once / 60 s) — the hook fires on *every* degraded call, so a
  latch-per-outage would over- or under-log; a 60 s throttle logs promptly, suppresses the
  storm, and re-logs if the outage persists. It names only `err.code ?? err.name` (never
  `err.message` — invariant 8, secrets/connection detail never logged).

`onError` must never throw (it runs inside the breaker's hot path); the body is
allocation-light and self-contained.

## A-14 — orphaned attempt does not poison its batch

**Root cause.** `writeAttemptGroup` inserts a principal's attempts in one `insertMany`; a
single FK violation (parent `request_log` dropped/evicted) fails the whole batch and every
retry.

**Invariant that makes the fix safe.** A cascade served-log and its attempts are enqueued
**synchronously in the same tick** (`record()` returns the id, then `recordCheapAttempt`
runs immediately; the `void flush()` triggered by `enqueue` is a microtask that can't
interleave). So parent and attempts always land in the *same* `flushOnce` splice.

**Decision.** Thread a `Set<string>` of successfully-inserted log ids through the log-group
writes; in `flushOnce`, partition attempts into insertable (parent written) vs orphaned
(parent absent) *before* grouping. Orphans are counted (`dropped`, `logRowsDroppedBy`) and
logged, exactly like any other drop — they cannot be inserted regardless (no parent row).
Valid siblings now commit instead of being dropped with the orphan.

This is strictly safer than today: the worst prior case (whole owner batch lost to one
orphan) becomes (only the true orphan lost). The `written` set is populated only on insert
*success*, so a parent that gave up after retries correctly orphans its children.

## A-15 — weekly spend reconciles in micro-dollars

**Root cause.** `weeklySpendByOwner` sums `coalesce(sum(cost), 0)` (float); budget and
analytics sum `coalesce(sum(round(coalesce(cost,0) * 1e6)), 0)` (integer µ$, rounded
per-row) and divide by 1e6 once. Float summation diverges at the sub-µ$ margin.

**Decision.** Extract the one true `microsSum` SQL fragment into a shared helper
(`packages/control-plane/src/database/cost-sql.ts`) and have all three readers
(`weekly-spend`, `budget`, `analytics.queries`) import it, so they can never drift again.
The weekly reader sums both ledgers in µ$ and converts to a dollar `total` once when
building the per-owner result. The public `WeeklySpendReader` interface (dollar `total`) is
unchanged — only the arithmetic path.

## Testing

- **A-3:** proxy service/e2e — a completion/stream whose only failure is a caller abort
  records `status='cancelled'` and does **not** call the failure-spike producer; a genuine
  provider error still records `error` + notifies.
- **A-10:** a unit test drives the factory's `onError` (or a small extracted helper) and
  asserts the counter increments and the log is throttled; `err.message` never appears.
- **A-14:** a log-writer unit test enqueues an attempt whose parent id was never enqueued
  (or whose parent group fails) alongside a valid parent+attempt pair, and asserts the valid
  attempt is inserted while the orphan is counted-dropped — not the whole batch lost.
- **A-15:** a weekly-spend reader test over rows chosen so float-sum ≠ µ$-sum asserts the
  reader's total equals the budget reader's µ$/1e6 for the same window.
