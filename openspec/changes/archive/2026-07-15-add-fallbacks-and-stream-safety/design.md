# Design: add-fallbacks-and-stream-safety

## Context

#10 resolves a tier to its position-0 primary and calls it once behind a commit-gated `openStream` (pre-commit failure → `{kind:'error'}`; post-commit → terminal frame), built so #12 can fall back before commit. #6 ships the breaker (`withBreaker`/`withBreakerStream`, `RedisBreakerStore`, `ProviderCircuitOpenError`) and `shouldFallback`/`breakerImpact`. #11 records the request. #12 walks the chain behind the boundary — respecting the user's configured order.

## Decision 1 — Ordered chain in `RouteDecision` (additive, pure)

`RouteDecision` gains `readonly chain: readonly RouteTarget[]` (`RouteTarget = { providerId, modelId, externalModelId }`), `chain[0]` = the existing primary. `resolveTier` collects **all** entries sorted by position (empty → `empty_tier`); a direct `model:` target / explicit model → `chain = [self]`. Pure over the snapshot.

## Decision 2 — Walk in the CONFIGURED order (no subscription auto-reorder)

The chain is walked in the user's position order — §7.4/§5 define an explicit primary/fallback order, so #12 does **not** silently move a position-4 subscription ahead of a position-0 API model. §8's "prefer subscription quota first, fall to paid on limits" is expressed by **configuring the subscription model earlier**: a subscription at position 0 uses its quota first and, on a limit/rate error, the walk falls through to the paid member behind it. (An explicit per-tier "subscription-first" policy can come later; auto-reorder is intentionally omitted.)

## Decision 3 — Chain walkers in `ProxyCore`, lazy adapters, raw-error eligibility

Walkers take `ChainAttempt = { providerId, externalModelId, buildAdapter: () => Promise<ProviderAdapter> }`. `buildAdapter` (SSRF re-gate + decrypt + #6 factory) is built **lazily** AND is invoked **inside the breaker-protected callback** — so an **open circuit is skipped before any build work** (no SSRF DNS / decrypt / factory on a skip — the "skip fast" requirement), and a broken/misconfigured later fallback can't fail or delay a healthy primary. `buildAdapter` throws a `ProviderError('unavailable', …)` on a setup failure so it is uniformly classified (eligible + trips the breaker — a persistently-misconfigured provider gets skipped fast on subsequent requests). Each attempt is short-circuited if `signal.aborted` (client gone). Results echo `servedIndex` + ordered `failures: { index, error: ProviderError }[]`.

- `runBufferedChain(breaker, attempts, client, request, ctx, signal) → { ok: true, wire, response, servedIndex, failures } | { ok: false, error, failures }` — it **returns** (does not throw) on exhaustion so `ProxyService` can record the total-failure row WITH the failure trail. Per attempt (unless `signal.aborted`): `withBreaker(breaker, providerId, async () => { const a = await buildAdapter(); return a.chat(req, {signal}); })`. On a fallback-eligible error, record a failure and continue; on success, `{ ok: true }`; on exhaustion/non-eligible, `{ ok: false, error, failures }`.
- `openStreamChain(breaker, attempts, client, request, opts) → {kind:'error',error,failures} | {kind:'stream',frames,outcome,servedIndex,failures}` — per attempt (unless aborted): run the single-attempt commit gate over `withBreakerStream(breaker, providerId, async function*(){ const a = await buildAdapter(); yield* a.chatStream(req,{signal}); })`. Pre-commit `{kind:'error'}` eligible with members remaining → next; `{kind:'stream'}` (first successful event) → **commit** and return (post-commit failure = the #10 terminal frame, no swap); exhausted → `{kind:'error'}` with the last error + failures.

**Signal-aware gate.** The single-attempt gate is refactored to `openAttemptStream(streamFactory: (signal) => AsyncGenerator, client, opts)`: it creates its `AbortController` FIRST, then builds the generator with that signal (so the first-event timeout can actually cancel the upstream). The chain passes `(signal) => withBreakerStream(breaker, providerId, () => adapter.chatStream(req, {signal}))`.

**Eligibility on the RAW error** (before any normalization): `false` for a client cancellation (`CallCancelledError`/`AbortError` — the client is gone) and a `ProviderError` with `shouldFallback === false` (`bad_request`); `true` for a `ProviderCircuitOpenError` skip, a build failure, and a retryable `ProviderError` (incl. `unknown_model`). Only after "not eligible / exhausted" is the last error mapped for the client — and `proxy-errors` maps `ProviderCircuitOpenError` → 503 (not a generic 500).

## Decision 4 — Breaker: settle-before-yield on error events; bounded Redis

**Fix #6's `withBreakerStream`**: it currently records an error event's kind and settles only after the loop — but the commit gate `iterator.return()`s the generator on seeing an error event, so its `finally` settles `neutral` first and an overload/rate-limit event never trips the breaker. Change it to **settle the classified outcome (`breakerImpact` → trip/success) immediately before yielding an `error` event**, guarded by the existing once-only `settle`; the post-loop terminal-stop/truncation logic stays for the no-error case, and consumer-abandon stays `neutral`.

A single `CircuitBreaker` is provided in the proxy module over `RedisBreakerStore` (shared across instances, invariant 10) with an `InMemoryBreakerStore` fallback (invariant 1). To bound hot-path latency when Redis is down, the breaker's `BreakerRedis.eval` is wrapped with a short fail-fast deadline (race → throw) so `before` degrades to the in-memory store promptly instead of waiting on ioredis retries. Documented accurately: `before` falls to the in-memory store on error; `complete` fail-opens (a lost completion doesn't update local state — an acceptable best-effort for health tracking).

## Decision 5 — Record the SERVED model, correct status, and the failure trail

`ProxyService` keeps a paired `attempts[]`/`meta[]` (per member: provider base_url/kind, model prices/isFree, ids). After the walk, recording (via #11) uses `meta[servedIndex]` for the served provider/model/pricing (NOT the primary decision), with **status precedence**: for streaming, `outcome.status === 'error'` → `error` (a committed stream that later fails is `error` regardless of earlier fallbacks); else `failures.length > 0` → `fallback`; else `success`. A whole-chain failure records one row `status='error'` against the primary. The `routing_reason` is extended with the sanitized failure trail (`kind@externalModelId` per predecessor — no raw messages) to satisfy §7.4's "record why earlier ones failed" without a migration. `RecordingContext` carries explicit served ids; `RecordOutcome.status`, **`RequestLogDraft.status`**, and the recorder all widen to `success|error|fallback` (the `request_log.status` column is free text, so no migration).

## Decision 6 — Reuse #10's boundary, drain, backpressure

The terminal-error frame, backpressure pump, abort/disconnect lifecycle, and drain registry are #10's, unchanged; #12 wraps them in the walk + breaker. The buffered path also gains an `AbortController` (wired to `res` close) so a disconnect cancels an in-progress buffered walk. **Pre-abort fix**: #6's `openRequest` (`http.ts`) currently only attaches an abort listener, so a signal already aborted (during breaker admission / build) still starts the call; it is fixed to throw `CallCancelledError` immediately when `signal.aborted`. Combined with the walkers' per-attempt `signal.aborted` short-circuit, a disconnect or first-event timeout stops the chain end-to-end. The first-chunk / first-N-ms buffer (§6.3 "optionally") is **deferred** — commit-on-first-event is the safe default.

## Risks / trade-offs

- **Configured order is authoritative** — subscription-preference is a configuration choice, not an auto-override (resolves the §7.4-vs-§8 tension; documented).
- **A committed stream can't fall back** — by invariant 3; a post-commit failure is a terminal error recorded `status=error`.
- **`complete` fail-open on Redis loss** — health tracking is best-effort; correctness (requests still route) holds via the in-memory `before` fallback + bounded eval deadline.
