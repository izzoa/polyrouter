# provider-adapters — delta for fix-proxy-ingress-and-drain

## MODIFIED Requirements

### Requirement: Per-call timeout and cancellation are a defined contract

Adapters SHALL accept a per-call `CallContext { signal?, traceId? }`. A first-byte timeout (`config.firstByteTimeoutMs`, default 30s, **configurable via `PROXY_FIRST_EVENT_TIMEOUT_MS`**) SHALL abort a call that returns no response headers / first event in time; a stream SHALL NOT be bounded by an overall deadline (an optional idle timeout may bound inter-event gaps). A **system-imposed** first-byte / first-event timeout (the caller is still connected) SHALL abort the call with a tripping `unavailable` error on **both** the buffered and the streaming paths — it MUST NOT be misclassified as breaker-neutral. This holds regardless of which layer's timer fires first: the streaming first-event bound SHALL be set with a fixed margin above the adapter first-byte bound (so the adapter's typed `unavailable` timeout wins for a pre-headers hang, while the streaming first/inter-event bound remains `first-byte + margin`), and the streaming breaker wrapper SHALL treat a cancellation as neutral only when a supplied caller-abort predicate reports the caller actually went away. The caller's `signal` SHALL be composed with the timeout so caller cancellation aborts the call, and such **caller** cancellation SHALL be breaker-neutral. Adapters SHALL NOT auto-retry POSTs. A sanitized upstream request id MAY be preserved in error metadata; the credential SHALL NOT be.

#### Scenario: A stalled pre-first-byte call times out; a long stream is not killed

- **WHEN** a provider accepts the connection but sends no response headers within the first-byte / first-event timeout, and the caller is still connected
- **THEN** the call aborts with an `unavailable` error, and that outcome is a **tripping** breaker failure on the streaming path as well as the buffered path (a system-imposed timeout counts against provider health)
- **AND** a provider that streams events slowly over a long period is not aborted by an overall deadline

#### Scenario: A hung-at-connect provider is skipped fast after repeated timeouts

- **WHEN** a streaming provider repeatedly accepts connections but never returns headers, enough times to reach the breaker threshold
- **THEN** the breaker opens and subsequent requests skip that provider quickly (rather than each paying the full first-event timeout), and a provider-down signal can fire

#### Scenario: Caller cancellation is neutral

- **WHEN** the caller aborts via its `signal` (the client actually went away)
- **THEN** the call stops and the outcome is breaker-neutral (neither success nor a tripping failure), on both the buffered and streaming paths — a genuine client disconnect never counts against provider health

#### Scenario: The timeout bounds are operator-configurable

- **WHEN** an operator sets `PROXY_FIRST_EVENT_TIMEOUT_MS` (e.g. to 120000 for a slow local model with long CPU prefill)
- **THEN** a stream whose first token arrives after the default 30s but within the configured bound succeeds and the provider's breaker stays closed
- **AND** with the variable unset, the adapter first-byte bound stays 30s and core's first/inter-event bound stays 30s + the fixed margin, so behavior is unchanged from before this change
