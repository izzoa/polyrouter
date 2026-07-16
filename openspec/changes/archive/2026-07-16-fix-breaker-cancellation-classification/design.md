# Design: fix-breaker-cancellation-classification

## Context

Abort-source anatomy on the per-attempt signal (`openAttemptStream`'s controller / the buffered walk's signal): (a) the CLIENT disconnected (propagated via `onCallerAbort`), (b) the chain's mid-stream event timeout (`nextWithTimeout` aborts a hung upstream), (c) the cascade cheap deadline (`AbortSignal.any(client, timeout)` in the proxy). The adapters map aborts to `CallCancelledError` only around `openRequest` (headers phase); a mid-body abort rejects the read with a raw undici error that `rethrowTyped`→`classifyNetworkError` converts to `ProviderError('unavailable')` before it exits the adapter. `withBreaker`/`withBreakerStream` then classify via `outcomeForError` — `CallCancelledError` → neutral, tripping `ProviderError` → trip — so case (a) trips when it reaches them in converted form. #21's `observeAdapter` already disambiguates for METRICS using a `clientAborted()` predicate closed over the pure client signal; the breaker has no such input.

## Goals / Non-Goals

**Goals:** a client cancellation is breaker-neutral end-to-end (no failure count, no open, no `provider_down`) regardless of the error shape it arrives in; hung-provider timeouts and streamed error events keep tripping; zero change for existing callers; the cascade cheap deadline keeps tripping (the chosen minimal variant).

**Non-Goals:** changing the adapters' error normalization (the layering stays: adapters normalize, the chain classifies); changing fallback eligibility (a client-gone walk already stops); metrics (done in #21); any rate/threshold tuning.

## Decisions

1. **The predicate lives at the breaker wrappers** — `isCallerAbort?: () => boolean` as a new trailing optional param on `withBreaker` and `withBreakerStream` (mirroring `onState` from #21). Outcome selection: in `withBreaker`'s catch, `isCallerAbort?.() ? 'neutral' : outcomeForError(err)`; in `withBreakerStream`'s catch, `isCancellation(err) || isCallerAbort?.() === true ? 'neutral' : outcomeForError(err)`. A genuine provider failure racing a disconnect reads neutral — accepted (rare, and the same call already returns nothing to anyone). The consumer-abandonment `finally` (already neutral) and the settle-before-yield error-event rule are untouched.
2. **Threading:** `runBufferedChain`'s `ctx` and `ProxyStreamOptions` gain `isCallerAbort?: () => boolean`, forwarded verbatim to the wrappers. Purely additive.
3. **The proxy supplies the PURE client signal.** All six chain call sites pass `isCallerAbort: () => signal.aborted` where `signal` is the request's client signal — for the cascade cheap chain this is deliberately NOT the `AbortSignal.any(...)` composite passed as the walk signal, so a deadline abort still trips (chosen variant). A tiny helper (`callerAbortOf(signal)`) keeps the sites uniform.
4. **Evidence:** data-plane unit specs — (i) `withBreaker` with a converted-shape error (`ProviderError('unavailable')`) and `isCallerAbort` true, repeated past the threshold → the breaker never opens and the next admission still allows; the same without the predicate → opens (the regression pin); (ii) `withBreakerStream` teardown-throw with the predicate true → neutral (no `justOpened`), with it false → trips; (iii) `runBufferedChain` threads the ctx predicate (member throws while "client gone" → breaker stays closed). Control-plane suites re-run unchanged (the wiring is six one-line args).

## Risks / Trade-offs

- **Racing disconnects mask a real failure as neutral** — accepted: the breaker under-counts at most one failure per genuine race, vs. today over-counting every disconnect.
- **A future caller forgetting the predicate** just keeps today's (safe-side, over-tripping) behavior — the seam degrades to the status quo, never worse.
- **Param-list growth on the wrappers** (4 optionals) — accepted for source compatibility; a breaking options-object refactor isn't worth it here.
