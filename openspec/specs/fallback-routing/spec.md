# fallback-routing Specification

## Purpose
TBD - created by archiving change add-fallbacks-and-stream-safety. Update Purpose after archive.
## Requirements
### Requirement: A routed request walks its tier's ordered fallback chain

The system SHALL resolve a tier to its **ordered chain** of up to 5 models (position 0 = primary) and, on a fallback-eligible failure of one member, try the next until one succeeds or the chain is exhausted (spec §7.4). An explicitly-named model or a `model:` rule target resolves to a single-element chain (no fallback). A member fails-eligibly on a provider error/timeout/429/unknown-model (a `ProviderError` whose class is retryable) or a circuit-open skip; a `bad_request` (the caller's fault) or a client cancellation is NOT retried.

#### Scenario: A primary failure falls through to the next model and still succeeds

- WHEN the primary model of a tier fails with a retryable error
- THEN the next model in the tier's position order is tried, and the request succeeds if any chain member succeeds
- AND the response is the successful member's, translated to the client's protocol

#### Scenario: A non-retryable error stops the walk

- WHEN a chain member fails with a `bad_request`, or the client cancels
- THEN the walk stops immediately (the next member is NOT tried) and the error is returned in the client's protocol

#### Scenario: An explicit model has no fallback

- WHEN the request names a concrete model (not a tier)
- THEN the chain is that one model; a failure is returned to the client (no other model is tried)

### Requirement: The chain walks the configured order; subscription-first is expressed by configuration

The system SHALL walk the chain in the tier's **configured position order** — it does NOT silently reorder the user's explicit primary/fallback chain (spec §7.4/§5). §8's "prefer subscription quota first, fall back to paid API when limits hit" is achieved by configuring the `subscription`-kind model earlier in the tier: its quota is used first, and a subscription limit/rate error falls through to the paid `api_key` member behind it.

#### Scenario: A subscription placed first falls through to a paid provider on a limit

- WHEN a tier is configured `[subscription-model, api_key-model]`
- THEN the subscription model is tried first (its quota used first)
- WHEN the subscription model fails with a limit/rate error
- THEN the paid `api_key` model serves the request

#### Scenario: The configured primary is honored

- WHEN position 0 is a healthy `api_key` model and a later member is a `subscription` model
- THEN the position-0 model serves the request (the subscription member is not jumped ahead of the configured primary)

### Requirement: A shared circuit breaker skips down providers fast and degrades gracefully

The system SHALL wrap each provider attempt in #6's circuit breaker, backed by a Redis store shared across instances so a rate-limited/down provider is skipped without a call (spec §8, §3.2, invariant 10). A streaming rate-limit/overload **error event** MUST trip the breaker (the breaker settles the classified outcome before the event is yielded, so the commit gate cancelling the stream cannot downgrade it to a neutral abandonment). If Redis is unavailable the breaker SHALL fall back to a per-instance in-memory store **promptly** (breaker Redis ops are bounded by a short fail-fast deadline so a down Redis does not add hot-path latency) rather than failing the request (invariant 1). A skipped (circuit-open) provider is a fallback-eligible failure — the walk moves to the next member.

#### Scenario: An open circuit is skipped and the walk continues

- WHEN a provider's circuit is open (recent repeated failures, including streamed overload events)
- THEN that member is skipped without an upstream call and the next chain member is tried

#### Scenario: Redis being down does not fail or stall requests

- WHEN the breaker's Redis store is unavailable or slow
- THEN requests still route via the in-memory fallback breaker within a bounded time; the smart-reliability path never blocks the core

### Requirement: Mid-stream fallback is safe (commit boundary preserved)

For a streamed request the fallback walk MUST honor the commit boundary (invariant 3, spec §6.3): a failure **before the first successful event** falls back transparently to the next member (nothing has been sent to the client); once the first event has been forwarded the model is **committed**, and a later upstream failure terminates the stream with the clear terminal error (`status=error`) and is **never** silently swapped to another model mid-response.

#### Scenario: Pre-commit failure falls back transparently while streaming

- WHEN a chain member's stream fails (throws, is skipped, times out, or yields an error event) before its first successful event
- THEN the next member is tried and, if it commits, the client receives one clean streamed response with no sign of the earlier attempts

#### Scenario: Post-commit failure terminates without a swap

- WHEN a chain member has already forwarded its first event and then the upstream fails
- THEN the stream is terminated with the sanitized terminal error frame and no other model is spliced in

### Requirement: The RequestLog records the served model, correct status, and the failure trail

The system SHALL record (via #11) the model/provider that actually **served** the request (not the primary, when a fallback served), a sanitized trail of why earlier members failed (kind + model — no raw messages, spec §7.4), and a status with this precedence: a committed stream that later fails is `error` (never `fallback`, even if earlier members fell back); otherwise `fallback` when at least one earlier member failed; otherwise `success`; a whole-chain failure records one row with `status = error`.

#### Scenario: A fallback is recorded against the served model with the failure trail

- WHEN the primary fails (retryably) and a later member serves the request
- THEN the RequestLog names the **served** provider/model (and its snapshotted price/usage) with `status = fallback`, and the recorded reason includes why the predecessor(s) failed
- WHEN the first member serves it
- THEN `status = success`

#### Scenario: A post-commit failure is recorded as error even after a fallback

- WHEN an earlier member failed pre-commit, a later member committed a stream, and that stream then failed mid-response
- THEN the row is recorded `status = error` (the post-commit failure takes precedence over the earlier fallback)

#### Scenario: A whole-chain failure records one error row

- WHEN every chain member fails
- THEN exactly one RequestLog row is recorded with `status = error`

