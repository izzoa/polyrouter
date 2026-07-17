---
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
'@polyrouter/frontend': patch
---

Proxy request-path & recording accuracy hardening (A-3, A-10, A-14, A-15).

- **A client disconnect is now recorded as `cancelled`, not a provider `error`, and no longer fires the failure-spike notify.** The breaker already treated a caller disconnect as neutral; the recording path did not, so a client hang-up inflated the error-rate metric and could trip a false `request_failures_spike`. The abort cause is captured causally at the failure boundary (a new `callerAborted` on the stream outcome and the buffered/streaming chain results, derived from the pure client signal — the composite work/deadline signal stops the chain but never sets the cause) rather than re-read from a mutable `AbortSignal` at record time. The dashboard gains a neutral `cancelled` status.
- **A degraded circuit-breaker store is now observable.** When the shared Redis breaker store faults and the breaker falls back to its per-instance store (cross-replica coordination lost), the proxy increments `polyrouter_breaker_store_faults_total` and logs a throttled (once/60s) static WARN — previously this degradation was silent.
- **An orphaned cascade attempt no longer FK-poisons its per-owner batch.** The log-writer inserts attempts only for parents it wrote this cycle, dropping (counted/logged) a genuine orphan instead of failing the whole batch and taking valid sibling rows with it. The threshold flush is deferred a microtask so a same-tick parent+attempt never split across cycles.
- **The weekly spend summary reconciles exactly with the budget and analytics figures.** It now aggregates in integer micro-dollars (`Σ round(cost × 1e6)`, shared `microsSum`) instead of summing raw floats, so a week's total no longer drifts sub-µ$ from the dashboard/budget.
