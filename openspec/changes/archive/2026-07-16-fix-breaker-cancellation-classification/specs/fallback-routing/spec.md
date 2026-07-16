# fallback-routing (delta)

## MODIFIED Requirements

### Requirement: A shared circuit breaker skips down providers fast and degrades gracefully

The system SHALL wrap each provider attempt in #6's circuit breaker, backed by a Redis store shared across instances so a rate-limited/down provider is skipped without a call (spec §8, §3.2, invariant 10). A streaming rate-limit/overload **error event** MUST trip the breaker (the breaker settles the classified outcome before the event is yielded, so the commit gate cancelling the stream cannot downgrade it to a neutral abandonment). If Redis is unavailable the breaker SHALL fall back to a per-instance in-memory store **promptly** (breaker Redis ops are bounded by a short fail-fast deadline so a down Redis does not add hot-path latency) rather than failing the request (invariant 1). A skipped (circuit-open) provider is a fallback-eligible failure — the walk moves to the next member.

**Caller cancellations are breaker-neutral.** A failure caused by the CLIENT going away SHALL never count against provider health — no failure increment, no open transition, no `provider_down` — even when the teardown error reaches the breaker in a normalized provider-error shape (a mid-body abort is converted by the adapters before the breaker sees it). The chain supplies the breaker a caller-abort predicate bound to the PURE client signal; timeouts the SYSTEM imposes on the provider (the mid-stream event timeout, the cascade cheap deadline) are provider-health signals and SHALL keep tripping.

#### Scenario: An open circuit is skipped and the walk continues

- WHEN a provider's circuit is open (recent repeated failures, including streamed overload events)
- THEN that member is skipped without an upstream call and the next chain member is tried

#### Scenario: Redis being down does not fail or stall requests

- WHEN the breaker's Redis store is unavailable or slow
- THEN requests still route via the in-memory fallback breaker within a bounded time; the smart-reliability path never blocks the core

#### Scenario: A client disconnect never trips the breaker or alerts

- WHEN clients repeatedly disconnect mid-stream from a healthy provider (each teardown error arriving breaker-side as a normalized provider error), more times than the trip threshold within the state window
- THEN the provider's breaker stays closed, the next request is admitted normally, and no `provider_down` notification fires

#### Scenario: A hung provider still trips through the same path

- WHEN the mid-stream event timeout aborts a hung upstream while the client is still connected
- THEN the failure counts against the provider and repeated occurrences open its breaker exactly as before
