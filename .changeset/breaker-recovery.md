---
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
---

Circuit-breaker recovery under long streams, server-clock cooldowns, and a real buffered idle timeout (FABLE_AUDIT E4).

A half-open probe settled success only at stream end, but LLM streams routinely outlive the 10s probe lease — so the next admission reclaimed the lease and bumped the generation, discarding the in-flight probe's eventual success as stale. Under steady long-stream traffic a recovered provider was throttled to ~1 request per cooldown window forever. `withBreakerStream` now renews the probe's lease on stream activity (fire-and-forget, throttled to ~once per third of a lease, contained so a renewal fault can never stall or fail the stream) via a new `renew` store op backed by a pure `applyRenew` and a `RENEW_LUA` script. An expiry guard (`now < probeExpiresAt`) preserves the silent-probe semantics exactly: a probe that goes quiet longer than its lease is still reclaimed, its late completion still ignored.

The breaker's `DECIDE`/`COMPLETE`/`RENEW` Lua now derive the current time from the **Redis server clock** (`redis.call('TIME')`) instead of each instance's `Date.now()`, so inter-instance wall-clock skew can no longer corrupt cooldown/lease arithmetic (a skewed instance can't defeat a cooldown). The `BreakerStore` interface is unchanged; `InMemoryBreakerStore` keeps its injected clock for deterministic tests.

`ProviderConfig.idleTimeoutMs` was declared but read by no code, so a buffered upstream read that stalled after headers was bounded only by undici's ~300s default `bodyTimeout`. It is now real: every non-streaming read (`chat` and `listModels`) is bounded by an inter-chunk idle deadline that aborts the upstream and fails with a tripping, fallback-eligible `unavailable` error. A new **`PROXY_IDLE_TIMEOUT_MS`** operator knob (default 30000; raise it alongside `PROXY_FIRST_EVENT_TIMEOUT_MS` for slow local models) flows through to the adapter. The streamed inter-event gap remains bounded by core's per-event timeout (no second streaming timer). No schema change; behavior under a healthy provider and a genuine caller abort is unchanged.
