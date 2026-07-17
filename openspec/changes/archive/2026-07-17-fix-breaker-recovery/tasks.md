## 1. E4.1 — Streaming probe lease renewal

- [x] 1.1 Add a pure `applyRenew(rec, tokenGeneration, now, cfg): BreakerRecord` to `breaker.ts`: no-op unless `rec.state === 'half_open' && tokenGeneration === rec.generation && now < rec.probeExpiresAt` (the **expiry guard** stops a late renewal from reviving an already-lapsed lease); else return `{ ...rec, probeExpiresAt: now + cfg.probeLeaseMs }`.
- [x] 1.2 Add `renew(providerId, generation, now, cfg): Promise<void>` to the `BreakerStore` interface; implement in `InMemoryBreakerStore` via `applyRenew`.
- [x] 1.3 Add `RENEW_LUA` and `RedisBreakerStore.renew` (HMGET state/generation/probeExpiresAt → if `state=='half_open' and tokenGen==generation and now<probeExp` then HSET `probeExpiresAt=now+lease` + PEXPIRE ttl); a no-op otherwise. `now` is the server clock (task 2.1).
- [x] 1.4 Add to `CircuitBreaker`: `nowMs()`, `get probeLeaseMs()`, and `renewProbe(token): Promise<void>` (guards `token.isProbe`, calls `token.store.renew(...)` with `this.now()`, contains the store error **and** the `onError` hook itself — invoke `this.onError` inside its own nested try/catch so a throwing caller-supplied hook can't escape; **the returned promise never rejects**, so the fire-and-forget caller in 1.5 needs no `.catch`).
- [x] 1.5 In `withBreakerStream`, on yielded events for `token.isProbe` fire the renewal **fire-and-forget** (`void breaker.renewProbe(token)`, NOT awaited — zero token-path latency, cannot stall the stream), throttled to once per `renewEveryMs = Math.max(1, floor(probeLeaseMs / 3))` of `breaker.nowMs()` time; keep the existing settle-on-error BEFORE yield and only renew when `!settled`.
- [x] 1.6 New unit test `breaker-probe-renew.spec.ts`: `CircuitBreaker` with injected clock + shared `InMemoryBreakerStore`, small `probeLeaseMs`; (a) a half-open probe stream yielding events frequently (gaps well within the lease) over several lease windows CLOSES the breaker on completion; (b) a concurrent `decide` mid-probe returns `skip`; (c) **revert-proof**: WITHOUT renewal the same sequence leaves it `half_open`/`open`; (d) **expiry guard**: a renewal issued at/after `probeExpiresAt` is a no-op — the next `decide` reclaims (generation bumped) and the original probe's completion is ignored; (e) **containment**: with a `renew` store that rejects AND a throwing `onError` hook, the probe stream still completes with no unhandled rejection.

## 2. E4.2 — Redis server clock in the Lua scripts

- [x] 2.1 In `DECIDE_LUA`, `COMPLETE_LUA`, and `RENEW_LUA`, derive `now` from `redis.call('TIME')` (`sec*1000 + floor(usec/1000)`) instead of `ARGV`; renumber the remaining `ARGV` indices down by one.
- [x] 2.2 In `RedisBreakerStore.decide/complete/renew`, stop passing `now` into `eval`; keep the `now` parameter in the method signatures (name it `_now` to satisfy strict TS) so the `BreakerStore` interface and `InMemoryBreakerStore`'s injected clock are unchanged.
- [x] 2.3 Rework `breaker-redis.spec.ts` for the server clock: use small real durations (cooldown/lease in tens–hundreds of ms) with real `await sleep(...)` between phases; keep the InMemory parity assertions only for transitions that don't depend on wall-clock deltas (threshold→open, generation guard, single-probe).
- [x] 2.4 Add a `breaker-redis.spec.ts` case proving server-clock authority: two callers pass wildly divergent `now` values around a cooldown boundary and get identical, correct decisions.
- [x] 2.5 Add a `breaker-redis.spec.ts` case proving Redis-level renewal: renew keeps a probe's lease alive past the base `probeLeaseMs` (real sleeps), and a stale-generation renew is a no-op.

## 3. E4.3 — Buffered-body idle deadline

- [x] 3.1 In `http.ts`, add an idle-guard body wrapper (used by `openRequest` when an `idleTimeoutMs` is supplied): after headers, wrap `res.body` so each chunk resets a `setTimeout(idleTimeoutMs)`; on idle → `ctl.abort()`, cancel the upstream reader, and directly `controller.error(new ProviderError('unavailable', 'provider body idle timeout'))`; override `text()`/`json()` to drain the guarded stream. Clear the timer on done/error and via `dispose`.
- [x] 3.2 Add an optional `idleTimeoutMs` parameter to `openRequest`; apply the guard only when provided.
- [x] 3.3 In `http-adapter.ts`, compute `idleTimeoutMs = config.idleTimeoutMs ?? firstByteTimeoutMs` and pass it to **every non-streaming** `openRequest` call — `chat` and `listModels` (both drain a buffered body and otherwise keep the multi-minute post-headers hang) — but NOT `chatStream` (core's per-event timeout bounds the stream).
- [x] 3.4 Register `PROXY_IDLE_TIMEOUT_MS` (default 30_000, positive int, `max(MAX_TIMEOUT_MS)`) in `proxyConfigSchema`; add `idleTimeoutMs` to `ProxyRawConfig`, `resolveProxyBounds`, and `ProxyRuntime`; pass `idleTimeoutMs: this.rt.idleTimeoutMs` onto `ProviderConfig` in `proxy.service.ts` `buildAdapter`.
- [x] 3.5 New unit test in `http-adapter`/`http` spec: an injected `httpClient` whose body yields one chunk then never resolves → the buffered `chat` rejects with a `ProviderError` kind `unavailable` within a small `idleTimeoutMs`, and a stalled `listModels` does the same; a body that keeps delivering within the bound succeeds. Add a breaker-integration pin (threshold-1 `CircuitBreaker` around the stalling `chat`): the idle timeout is a **tripping** failure while a genuine caller-abort during the buffered body read stays **neutral** (via `isCallerAbort`). Add a `resolveProxyBounds`/config test for the `PROXY_IDLE_TIMEOUT_MS` override + default.

## 4. Verification & wrap-up

- [x] 4.1 `npm run build && npm run lint && npm run typecheck` clean; strict TS, no `any`.
- [x] 4.2 `npm test -w packages/data-plane` green (incl. new probe-renew + idle-timeout unit tests); with `REDIS_URL` set, `npm test -w packages/data-plane -- breaker-redis` green (server-clock + renewal parity).
- [x] 4.3 `npm test -w packages/control-plane` green (proxy config test); `npm run test:e2e -w packages/control-plane` green (no regression; known auth/cascade flakes re-run in isolation).
- [x] 4.4 Add a changeset (user-facing: new `PROXY_IDLE_TIMEOUT_MS` knob + breaker recovery fix); note the README env-table row is deferred to E8.4.
- [x] 4.5 Update `TODOS.md` hardening board + mark E4 tasks ✅ in `FABLE_AUDIT.md` after archive.
