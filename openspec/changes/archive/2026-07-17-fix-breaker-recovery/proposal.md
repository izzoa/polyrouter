## Why

The Redis-shared circuit breaker opens correctly but can fail to ever close again under the
product's dominant workload — long LLM streams. A streaming half-open probe reports success only
at stream end, but streams routinely outlive the 10s probe lease; the next admission reclaims the
lease and bumps the generation, so the in-flight probe's eventual success is discarded as stale.
Under steady long-stream traffic a recovered provider is throttled to ~1 request per cooldown
window forever. Two adjacent defects undermine the breaker's multi-instance correctness and its
hang protection: the Lua scripts take `now` from each instance's wall clock (the spec mandates the
Redis server clock — clock skew corrupts cooldown/lease arithmetic fleet-wide), and
`ProviderConfig.idleTimeoutMs` is declared but read by no code, so a buffered upstream read that
stalls after headers is bounded only by undici's default ~300s `bodyTimeout` (FABLE_AUDIT E4).

## What Changes

- **E4.1** `withBreakerStream` renews the half-open probe's lease on stream activity, so a long-lived
  streaming probe stays the current generation and its completion closes the breaker. A probe that
  yields *nothing* within its lease still expires and is superseded (unchanged). Add a `renew`
  store op (pure `applyRenew` + `InMemoryBreakerStore` + a `RENEW_LUA` Redis script), throttled to
  at most ~once per half-lease so a long stream does not hammer Redis.
- **E4.2** Both breaker Lua scripts derive `now` from `redis.call('TIME')` (the Redis server clock)
  instead of the caller's `ARGV`; `RedisBreakerStore` stops forwarding `now` (the `BreakerStore`
  interface is unchanged — `InMemoryBreakerStore`/pure transitions keep the injected clock for
  deterministic tests). Brings the code into conformance with the existing spec text.
- **E4.3** Make `idleTimeoutMs` real for the buffered read path: keep the request abortable after
  headers and enforce an inter-chunk idle deadline (default `firstByteTimeoutMs`) on the buffered
  body drain; an idle stall aborts the upstream and fails with a trip-eligible, fallback-eligible
  `unavailable` error. Add a `PROXY_IDLE_TIMEOUT_MS` operator knob and wire it through the runtime
  onto `ProviderConfig.idleTimeoutMs`. (The streaming inter-event gap is already bounded by core's
  per-event timeout from E1.4 — E4.3 does not add a second streaming timer.)

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `provider-adapters`: the circuit-breaker requirement gains lease renewal for an active streaming
  probe and a server-clock scenario; the adapter-timeout requirement gains a buffered-body idle
  deadline. No change to the mid-stream commit boundary, caller-abort neutrality, settle-before-yield
  ordering, or the reclaimed-expired-lease semantics for a silent probe.

## Impact

- **Code:** `packages/data-plane/src/providers/breaker.ts` (`BreakerStore.renew`, `applyRenew`,
  `RENEW_LUA`, server-clock `DECIDE_LUA`/`COMPLETE_LUA`, `CircuitBreaker.renewProbe`,
  `withBreakerStream` renewal), `http.ts` (buffered idle guard) + `http-adapter.ts` (wire
  `idleTimeoutMs` into the buffered `chat`), `packages/control-plane/src/proxy/proxy.config.ts`
  (`PROXY_IDLE_TIMEOUT_MS` + `ProxyRuntime.idleTimeoutMs`) and `proxy.service.ts` (pass it onto
  `ProviderConfig`).
- **Tests:** new pure/InMemory probe-renewal unit test; extended `breaker-redis.spec.ts` (real-Redis
  renewal + server-clock skew-independence — **note:** the server-clock change means the existing
  injected-`now` parity sequences must be re-expressed with real elapsed time / small durations);
  new buffered idle-timeout adapter unit test. All env-gated behind `REDIS_URL` (required in CI per
  E7.1).
- **Config/docs:** one new optional env var (`PROXY_IDLE_TIMEOUT_MS`, default 30000) through the
  shared registry; README env table (defer the doc row to E8.4, note it in the changeset).
- **No migration** (no schema change). **No API contract change.** Behavior under a healthy provider
  and a genuine caller abort is unchanged.
