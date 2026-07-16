# Proposal: fix-breaker-cancellation-classification

## Why

A client that disconnects mid-stream currently counts as a PROVIDER failure. The abort tears down the upstream body read; the HTTP adapters normalize the resulting raw error to `ProviderError('unavailable')` (their abort→`CallCancelledError` mapping covers only the pre-headers phase), and the breaker's `outcomeForError` then records a trip. Five client disconnects within the 5-minute state window falsely OPEN that provider's breaker — every request to it is skipped for the 30s cooldown — and a false `provider_down` alert fires. This was surfaced by #21's observability review (the metrics side was fixed there via the client signal; the breaker/alert side was explicitly deferred as a behavior decision — now decided: fix, minimal variant).

The adapter cannot fix this: it sees only the merged per-attempt signal and cannot distinguish a client disconnect from the chain's own mid-stream event timeout (a hung provider, which MUST keep tripping). Only the chain layer holds the client's signal separately.

## What Changes

One additive data-plane seam, the exact mirror of #21's `onBreakerState`:

1. `withBreaker`/`withBreakerStream` gain an optional `isCallerAbort?: () => boolean`. On a thrown/settled error, when the CALLER is known to have gone away (`isCallerAbort()` true), the breaker outcome is **`neutral`** — never a trip, never a `justOpened`/`provider_down` — regardless of the error's normalized shape. A cancellation-shaped error (`CallCancelledError`/`AbortError`) stays neutral as today.
2. The chain runners thread it: `runBufferedChain`'s ctx and `ProxyStreamOptions` gain `isCallerAbort?`, passed down to the wrappers.
3. The proxy (control-plane) supplies `() => clientSignal.aborted` at every chain call site using the PURE client signal — for the cascade cheap chain explicitly NOT the `AbortSignal.any(client, deadline)` composite, so a cheap-deadline abort still reads `isCallerAbort() === false` and **keeps tripping** (a chronically slow cheap provider keeps being routed around — the minimal-semantic-change variant the user chose).
4. Unchanged: mid-stream event timeouts trip (client still connected); streamed rate-limit/overload error events trip (settled before yield, as today); consumer-abandonment neutrality; all existing callers compile untouched.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities
- `fallback-routing`: the shared-circuit-breaker requirement gains the caller-cancellation rule — a client cancellation is breaker-neutral even when the teardown error reaches the breaker in a normalized (`ProviderError`) shape; infrastructure timeouts imposed on the provider still trip.

## Impact

- **Code:** `packages/data-plane/src/providers/breaker.ts` (the two wrappers + outcome selection), `packages/data-plane/src/proxy/core.ts` (options threading), `packages/data-plane/src/providers/index.ts` (type export if any), `packages/control-plane/src/proxy/proxy.service.ts` (supply the predicate at the 6 chain sites with the pure client signal). No schema, config, or API changes; no new dependencies.
- **Tests:** data-plane — a failing call with `isCallerAbort` true records neutral (no failure count accrues across threshold repeats; no open); an event-timeout-shaped `ProviderError` with `isCallerAbort` false still trips; the stream wrapper honors the predicate for thrown teardown errors; chain-level threading covered via `runBufferedChain`. Existing breaker/chain/proxy suites unchanged and green.
- **Behavior delta:** ONLY caller-abort cases flip from trip→neutral (and stop emitting false `provider_down`). Deadline/timeout trips are preserved byte-for-byte.
