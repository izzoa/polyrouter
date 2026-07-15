---
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

Add fallback chains + mid-stream safety — completing the shippable core (spec §7.4, §6.3, §8, §3.2; invariants 1, 3, 10, 12).

- **Ordered chain**: `RouteDecision` gains a `chain` — a tier resolves to all its entries in position order (chain[0] = primary), an explicit model or `model:` rule target to a single-element chain (no fallback).
- **Fallback walk** (`ProxyCore.runBufferedChain` / `openStreamChain`): walks the chain in the configured order, each attempt wrapped in #6's circuit breaker, trying the next member on a fallback-eligible failure (a retryable `ProviderError`, a circuit-open skip, or a member build failure — a `bad_request` or a client cancellation stops). Non-streaming retries until one returns; streaming retries **until the first successful event commits**, then streams committed — a post-commit failure is the terminal error frame, never a mid-response model swap (invariant 3). Adapters are built **lazily inside the breaker callback**, so an open circuit skips before any SSRF/decrypt/factory work and a broken later member can't fail a healthy primary.
- **Circuit breaker** wired over #6's `RedisBreakerStore` (shared across instances, invariant 10) with an `InMemoryBreakerStore` fallback and a fail-fast Redis deadline so a down/slow Redis degrades promptly without stalling the hot path (invariant 1). Fixes #6's `withBreakerStream` to settle the classified outcome **before yielding** an error event, so the commit gate cancelling the stream can't downgrade an overload/rate-limit to a neutral abandonment (the breaker now actually trips). Fixes #6's `openRequest` to honor an already-aborted signal, so a disconnect/timeout during breaker admission can't still start the upstream.
- **Subscription-first via configuration** (§8): the chain walks the user's configured position order (no silent auto-reorder — §7.4/§5 define an explicit chain); to prefer flat-rate subscription quota, configure the subscription model earlier, and a limit falls through to the paid member behind it.
- **`status = fallback` recording** (#11): the RequestLog records the **served** provider/model (not the primary when a fallback served), a sanitized predecessor-failure trail in `routing_reason`, and a status with precedence — a committed stream that later fails is `error`, else `fallback` when a predecessor failed, else `success`; a whole-chain failure is one `error` row.

Client disconnect aborts a buffered walk too. Reviewed over three codex rounds (design), which hardened the breaker/commit-gate interplay, pre-abort propagation, admission-before-build, subscription-order semantics, bounded Redis degradation, and served-model recording. Backed by pure resolver + chain-walker + breaker unit tests and a real-Postgres, real-stub-upstream e2e (non-streaming fallback, pre-commit stream fallback, post-commit no-swap, and `status=fallback` recording against the served model). No schema migration.

**This completes the ⛔ review-gate scope: #10–12 are the shippable core, ready for human review.**
