---
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
---

Client disconnects no longer count as provider failures (closes the follow-up flagged in #21's changeset).

A client that disconnected mid-stream tore down the upstream read, and the HTTP adapters normalized that abort into `ProviderError('unavailable')` (their abort→`CallCancelledError` mapping covers only the pre-headers phase) — so the circuit breaker counted the client's own disconnect as a provider failure. Enough disconnects within the state window falsely OPENED the provider's breaker (every request skipped for the cooldown) and fired a false `provider_down` alert.

The adapters can't fix this (they see only the merged per-attempt signal and can't distinguish a client disconnect from the chain's own mid-stream event timeout — a hung provider that MUST keep tripping). The fix is an additive seam at the layer that knows: `withBreaker`/`withBreakerStream` accept an optional `isCallerAbort` predicate (threaded through the chain-runner options), and the proxy supplies it bound to the PURE client signal at every chain site. When the caller is known to have gone away, the breaker outcome is `neutral` — no failure count, no open, no `provider_down` — regardless of the error's normalized shape.

Deliberately unchanged (minimal variant): the mid-stream event timeout still trips (client present ⇒ provider health), and the cascade cheap-deadline abort still trips (the predicate is bound to the client signal, not the deadline composite — a chronically slow cheap provider keeps being routed around). Existing callers compile untouched; a caller omitting the predicate keeps today's (over-tripping, safe-side) behavior.
