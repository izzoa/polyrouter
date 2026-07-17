## Context

The breaker (`packages/data-plane/src/providers/breaker.ts`) is a generation-versioned
`closed → open → half-open → closed` state machine with two stores: `InMemoryBreakerStore` (pure,
synchronous, injected clock — the per-instance fallback and the test double) and `RedisBreakerStore`
(the same math in `DECIDE_LUA`/`COMPLETE_LUA`). A half-open probe is admitted after cooldown with a
lease (`probeExpiresAt = now + probeLeaseMs`, default 10s); if it does not report within the lease,
the next admission reclaims it and bumps the generation, so the stale probe's late completion is
ignored (`applyComplete` generation guard).

Three load-bearing invariants (FABLE_AUDIT §4) constrain this change and must survive:
- **settle-before-yield** — `withBreakerStream` settles the breaker outcome *before* yielding an
  error event, so a commit-gated consumer that `.return()`s on the error can't launder it to neutral.
- **caller-abort neutrality** (commit `8abd4b6`) — a genuine client-gone teardown is neutral; a
  system-imposed timeout while the caller is present trips (E1.3's `isCallerAbort` predicate owns it).
- **reclaimed-expired-lease** — a probe that reports *nothing* within its lease is still superseded.

## Goals / Non-Goals

**Goals:**
- A long-lived streaming half-open probe (frequent events, total duration ≫ `probeLeaseMs`) keeps its
  lease and closes the breaker on completion (E4.1).
- Breaker cooldown/lease arithmetic is driven by the Redis server clock, immune to inter-instance
  wall-clock skew (E4.2).
- A buffered upstream read that stalls after headers fails `unavailable` within a configurable idle
  bound; `ProviderConfig.idleTimeoutMs` stops being dead config (E4.3).

**Non-Goals:**
- Changing the single-probe guarantee, the generation-guard, settle-before-yield, or caller-abort
  neutrality.
- Adding a second inter-event timer to the streaming path (core's per-event timeout from E1.4 already
  bounds streamed inter-event gaps; E4.3 is the *buffered* body deadline only).
- Keeping a streaming probe alive across an inter-event gap *longer than the probe lease* — such a gap
  is treated as an unhealthy/silent probe and is superseded (unchanged semantics).

## Decisions

### E4.1 — Renew the probe lease on stream activity

Add a fourth store op `renew(providerId, generation, now, cfg): Promise<void>` alongside
`decide`/`complete`, backed by a pure `applyRenew(rec, tokenGeneration, now, cfg)`:

```
applyRenew: if rec.state !== 'half_open'
            || tokenGeneration !== rec.generation
            || now >= rec.probeExpiresAt          // EXPIRY GUARD — do not revive an expired lease
              → no-op (return rec)
            else → { ...rec, probeExpiresAt: now + cfg.probeLeaseMs }
```

The **expiry guard** (`now < probeExpiresAt`) is essential (clink round 1): without it, a probe whose
first event arrives *after* its lease already lapsed could re-extend the dead lease before a competing
admission reclaims it, defeating the silent-probe/reclaimed-expired-lease semantics. With the guard,
an already-expired probe never renews — the next `decide` reclaims it and bumps the generation as
today. Renewal also only ever *extends the current generation's* lease (generation-mismatch → no-op),
so it can never resurrect a superseded probe. In `RENEW_LUA` the same `now < probeExp` guard uses the
Redis server clock (E4.2).

`CircuitBreaker` gains `nowMs()`, `get probeLeaseMs()`, and `renewProbe(token)` (guards
`token.isProbe`, routes to the admitting store, contains the store fault **and** the caller-supplied
`onError` hook — `onError` is invoked inside its own nested try/catch so a throwing hook can't escape
— so the returned promise **never rejects**; a fire-and-forget renewal can never leak an unhandled
rejection or break the stream). `withBreakerStream` fires the renewal
**fire-and-forget (not awaited)** on yielded events, throttled, so it injects zero store latency into
the token path and cannot stall the stream:

```
let lastRenewAt = breaker.nowMs();
const renewEveryMs = Math.max(1, Math.floor(breaker.probeLeaseMs / 3));
for await (const ev of gen()) {
  ...settle-on-error (unchanged, still BEFORE yield)...
  if (token.isProbe && !settled) {
    const t = breaker.nowMs();
    if (t - lastRenewAt >= renewEveryMs) { lastRenewAt = t; void breaker.renewProbe(token); }
  }
  yield ev;
}
```

**Guarantee (honest — clink round 1 refuted the naive "gap ≤ full lease" claim):** because the
throttle skips renewals for up to `renewEveryMs` and the base lease is `probeLeaseMs`, the safe
inter-event bound is `probeLeaseMs − renewEveryMs`. With `renewEveryMs = floor(probeLeaseMs / 3)`
that is ≈ `2/3 · probeLeaseMs` of headroom. So the stated guarantee is: **a streaming probe that
keeps yielding events well within the probe lease** (the normal case — sub-second token gaps over a
multi-lease-window total) renews across windows and closes the breaker on completion; a probe that
goes silent longer than its lease is still reclaimed. A fire-and-forget renewal that lands after a
competing reclaim is a harmless no-op (generation-mismatch **and** expiry guards).

*Alternatives rejected:* (a) settle `success` on the first event instead of stream end — violates
settle-before-yield and would close the breaker before knowing the stream stays healthy (a post-first
error should re-open). (b) renew (awaited) every event with no throttle — injects a Redis round-trip
into the token path and hammers Redis on a long stream. (c) simply lengthen `probeLeaseMs` — no fixed
lease covers an unbounded stream.

### E4.2 — Redis server clock in the Lua scripts

`DECIDE_LUA`, `COMPLETE_LUA`, and the new `RENEW_LUA` derive `now` from the server:

```
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
```

`RedisBreakerStore.decide/complete/renew` stop passing `now` into `eval` and the `ARGV` indices
renumber down by one. The `BreakerStore` interface keeps its `now` parameter (unused in the Redis
impl, named `_now` there to satisfy strict TS) so `InMemoryBreakerStore` and the pure transitions
keep their injected clock — deterministic unit tests are unaffected. Redis 7 replicates *script
effects* (not the script body), so a `TIME` call inside a writing script is allowed by default.

**Test consequence (called out in the proposal):** `breaker-redis.spec.ts`'s existing "parity"
sequence drives transitions with injected `now` values (0, 500, 1000). Once Redis reads the server
clock, those deltas no longer control cooldown/lease, so the injected-`now` parity assertions become
meaningless for the Redis store. The Redis suite is re-expressed with **small real durations**
(cooldown/lease in the tens-to-hundreds of ms) and real `await sleep(...)` between phases; a new case
proves two callers passing wildly divergent `now` values produce identical decisions (server-time
authority). InMemory parity is retained only for the transitions that don't depend on wall-clock
deltas (threshold→open, generation guard, single-probe).

### E4.3 — Buffered-body idle deadline

The buffered `chat` path (`http-adapter.ts`) reads `res.json()` / `res.text()`, whose drain has no
adapter deadline today (only undici's ~300s `bodyTimeout`). `openRequest` gains an optional
`idleTimeoutMs`; when set, after headers arrive it wraps the response body in an idle guard that:

- arms a `setTimeout(idleTimeoutMs)` reset on every body chunk;
- on idle: aborts the request controller (`ctl.abort()` — prompt real-socket teardown, avoiding the
  graceful-`dispatcher.close()` hang the module header warns about), cancels the upstream reader, and
  **directly errors the guarded stream** with `new ProviderError('unavailable', 'provider body idle
  timeout')`. The direct error is what surfaces promptly even against a stalled body whose underlying
  `read()` never rejects (and it's exactly the fake the unit test injects);
- overrides `text()`/`json()` to drain the guarded stream (the originals close over the inner body).

The typed `unavailable` propagates through `rethrowTyped` unchanged; because the caller is still
present, `withBreaker`'s `isCallerAbort()` is false → it trips the breaker and is fallback-eligible.
`idleTimeoutMs` is applied to **every non-streaming read** — `chat` *and* `listModels` (clink round 1:
the delta says "any buffered read", and `listModels`/`testConnection` otherwise keep the multi-minute
post-headers hang) — using `config.idleTimeoutMs ?? firstByteTimeoutMs`; it is **not** applied to
`chatStream` (see below). A new `PROXY_IDLE_TIMEOUT_MS` (default 30000, via the shared registry) flows
`resolveProxyBounds → ProxyRuntime.idleTimeoutMs → ProviderConfig`.

**Why not the streaming body too:** the streamed inter-event gap is bounded by core's per-event
timeout (E1.4, `nextWithTimeout`), which on timeout aborts the call — and undici honors the
`AbortSignal`, so the upstream read rejects and the timeout surfaces. That holds for real transports;
a hypothetical transport that ignored the abort could leave core awaiting a non-settling `next()`
(`core.ts:308`), but that is a pre-existing core concern, not a regression here, and adding a second
adapter-level streaming timer would only duplicate the event timer. E4.3 therefore covers the
genuinely-unbounded buffered drains and leaves the streamed path to core's existing bound (the
core non-settling-`next()` edge is logged as related backlog, not fixed in this scope-limited change).

*Alternatives rejected:* (a) a total (non-idle) body deadline — kills large, legitimately slow
buffered responses; idle (per-chunk reset) only fires on a genuine stall. (b) rely on `ctl.abort()`
alone and let `classifyNetworkError` map the AbortError — a truly wedged body's `read()` may never
reject, so nothing surfaces; the direct typed error is required. (c) add the guard to the streaming
path too — redundant with E1.4's core per-event timeout.

## Risks / Trade-offs

- **[Renewal throttle vs. slow token streams]** A probe whose inter-event gap exceeds the renewal
  headroom (`probeLeaseMs − renewEveryMs` ≈ 2/3 of the lease) is still superseded and may not close
  the breaker on that probe → the next admission becomes a fresh probe; under steady traffic the
  breaker still closes when a probe completes within its renewed windows. Documented as an explicit
  non-goal; the common case (sub-second gaps, long total) is fully fixed. Operators with very slow
  local models already raise the event timeouts (E1.4). The expiry guard ensures a late/silent probe
  degrades to a clean re-probe rather than corrupting the generation.
- **[Real-time Redis tests are slower/could flake]** Mitigated by keeping durations small (tens of ms)
  with margins, and the suite is env-gated behind `REDIS_URL` (required only in CI per E7.1), so it
  never runs on the unit-test hot path.
- **[`TIME` non-determinism in Lua]** Allowed under Redis 7 effects replication; the scripts remain
  single-round-trip and atomic. No behavioral change for a single instance.
- **[Idle abort racing a just-arrived chunk]** Benign: worst case a healthy chunk lands as the timer
  fires; the request fails `unavailable` and falls back — never a wrong answer, never a hang.

## Migration Plan

Code-only; no schema migration, no API change. `PROXY_IDLE_TIMEOUT_MS` is optional with an unchanged
default, so existing deployments behave identically. Rollback is a straight revert.

## Open Questions

None. Scope is the three E4 tasks; backlog A-10/A-11/A-12 (breaker spec import fix already handled in
E7, missing production `onError`, Anthropic `listModels` pagination) are out of scope for this change.
