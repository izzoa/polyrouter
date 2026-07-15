## ADDED Requirements

### Requirement: One adapter interface over the four provider kinds

The system SHALL expose one provider adapter interface — `chat(request, ctx?)`, `chatStream(request, ctx?)`, `listModels()`, `testConnection()` — implemented for OpenAI-compatible and Anthropic-compatible protocols and covering the four provider kinds (`api_key`, `subscription`, `custom`, `local`). Adapters SHALL consume and produce #5's `Normalized*` IR and SHALL NOT define their own request/response shape (CLAUDE.md invariant 2); wire translation is delegated to #5's translate module (with any `AdapterQuirks` from config). A factory SHALL select the adapter by `protocol` and SHALL reject `kind: "local"` when `mode !== "selfhosted"`.

#### Scenario: Factory selects the adapter by protocol and rejects local outside self-host

- **WHEN** a provider config with `protocol: "anthropic_compatible"` is passed to the factory
- **THEN** an Anthropic-compatible adapter is returned, and `protocol: "openai_compatible"` returns an OpenAI-compatible adapter
- **AND** a config with `kind: "local"` under `mode: "cloud"` is rejected by the factory

#### Scenario: Adapter returns the Normalized IR, not a raw provider shape

- **WHEN** `chat(request)` completes for either protocol
- **THEN** its return value is a `NormalizedResponse` from #5's IR
- **AND** no provider-specific response shape is defined anywhere in the provider adapter module

### Requirement: Transport is JSON with per-protocol headers and stream-safe decoding

Adapters SHALL send `Content-Type: application/json` with a `JSON.stringify`'d body from #5's `requestOut`, and SHALL `JSON.parse` a non-streaming response before `responseIn`. OpenAI-compatible calls SHALL `POST {base_url}/chat/completions`, `GET {base_url}/models`, and authenticate with `Authorization: Bearer <credential>`. Anthropic-compatible calls SHALL `POST {base_url}/v1/messages`, `GET {base_url}/v1/models`, and send `x-api-key: <credential>` plus an `anthropic-version` header, supplying a configured `defaultMaxOutputTokens` to #5 when the IR omits `maxOutputTokens`. Streaming requests SHALL send `Accept: text/event-stream` and decode the byte body through **one persistent streaming `TextDecoder`** so a multibyte character split across chunk boundaries is not corrupted. `config.extraHeaders` SHALL be merged into requests (a seam for subscription/custom providers).

#### Scenario: OpenAI chat sends JSON to the right endpoint with bearer auth

- **WHEN** `chat(request)` runs against an OpenAI-compatible provider
- **THEN** it POSTs `application/json` (the OpenAI wire form of the IR) to `{base_url}/chat/completions` with `Authorization: Bearer <credential>`
- **AND** the decoded response parses back into a `NormalizedResponse` (content, stop reason, usage)

#### Scenario: Anthropic chat sets api-key, version, and the max_tokens default

- **WHEN** an IR request without `maxOutputTokens` is sent through the Anthropic-compatible adapter configured with a default
- **THEN** the request carries `x-api-key`, `anthropic-version`, targets `{base_url}/v1/messages`, and its body's `max_tokens` is the configured default

#### Scenario: A multibyte character split across stream chunks is not corrupted

- **WHEN** a streamed response splits a multibyte UTF-8 character across two byte chunks
- **THEN** the persistent decoder reassembles it and the emitted text is byte-correct

### Requirement: Streaming yields normalized events with a stream-safe guarded connection

`chatStream(request)` SHALL open a streaming request (`stream: true`) through the SSRF-guarded transport and adapt the response body into an ordered `AsyncIterable<NormalizedStreamEvent>` via #5's `streamParse`. The guarded connection lifecycle SHALL be tied to the stream: the underlying dispatcher is closed when the body ends, errors, or is cancelled (never before the first event, so the guarded transport does not deadlock on an open SSE response). A failure before the first event SHALL surface as a typed provider error (so the proxy can fall back before committing); once events flow, an upstream error SHALL surface as a normalized `error` event or a thrown error. This module does not implement the mid-stream commit policy (that is #10/#12).

#### Scenario: The first event arrives before the upstream ends

- **WHEN** `chatStream(request)` runs against a provider that streams a text response over an open connection
- **THEN** the adapter yields the first `NormalizedStreamEvent` before the upstream closes the stream
- **AND** the concatenated text equals the streamed content and the terminal event carries the mapped stop reason and any usage

#### Scenario: Cancelling the consumer closes the guarded connection

- **WHEN** the consumer stops iterating early (cancels)
- **THEN** the underlying guarded dispatcher is closed and the upstream connection is released
- **AND** the cancellation is treated as breaker-neutral, not a provider failure

#### Scenario: Pre-first-event failure is a typed error

- **WHEN** the upstream returns a non-2xx status before any stream event
- **THEN** `chatStream` raises a typed provider error (not a partial stream) whose `kind` reflects the status

#### Scenario: A truncated stream (clean EOF before a terminal stop) is a failure, not success

- **WHEN** the upstream connection closes cleanly mid-response, before any `message_delta` carrying a stop reason
- **THEN** `withBreakerStream` treats it as a tripping `unavailable` failure (not success), because #5's parser synthesizes `message_stop` at EOF and a clean return alone does not prove completion
- **AND** a stream that reaches a terminal stop reason before ending is success

### Requirement: Per-call timeout and cancellation are a defined contract

Adapters SHALL accept a per-call `CallContext { signal?, traceId? }`. A first-byte timeout (`config.firstByteTimeoutMs`, default 30s) SHALL abort a call that returns no response headers / first event in time; a stream SHALL NOT be bounded by an overall deadline (an optional idle timeout may bound inter-event gaps). The caller's `signal` SHALL be composed with the timeout so caller cancellation aborts the call, and such caller cancellation SHALL be breaker-neutral. Adapters SHALL NOT auto-retry POSTs. A sanitized upstream request id MAY be preserved in error metadata; the credential SHALL NOT be.

#### Scenario: A stalled pre-first-byte call times out; a long stream is not killed

- **WHEN** a provider accepts the connection but sends no response headers within `firstByteTimeoutMs`
- **THEN** the call aborts with an `unavailable` error
- **AND** a provider that streams events slowly over a long period is not aborted by an overall deadline

#### Scenario: Caller cancellation is neutral

- **WHEN** the caller aborts via its `signal`
- **THEN** the call stops and the outcome is breaker-neutral (neither success nor a tripping failure)

### Requirement: listModels and testConnection are cheap and non-destructive

`listModels()` SHALL return `ProviderModelInfo[]` (`{ id, displayName? }`) parsed from the provider's models endpoint — raw ids only, no pricing, capabilities, or `is_free` (those are #8). `testConnection()` SHALL perform a cheap validating call and return a structured result indicating success or a typed failure, never throwing raw and never returning the credential.

#### Scenario: testConnection reports a typed auth failure without the credential

- **WHEN** `testConnection()` runs against a provider that returns 401
- **THEN** the result indicates failure with `kind: "auth"` and contains no credential material

#### Scenario: listModels returns ids without catalog fields

- **WHEN** `listModels()` succeeds
- **THEN** the result is a list of `{ id, displayName? }` entries with no price, capability, or `is_free` fields (those are attached in #8)

### Requirement: All outbound provider HTTP is SSRF-guarded at connect time

Every outbound provider request SHALL go through #4's guarded transport — `assertUrlSafe` plus a guarded dispatcher (`createGuardedDispatcher`) whose `GuardContext` is derived from the provider's `kind` and the runtime `mode` — so the resolved IP is validated at connect time (defending DNS rebinding at fetch time, not only at CRUD time). Redirects SHALL be rejected as errors (providers do not redirect chat/messages POSTs). The SSRF loopback exception SHALL be enabled only for `kind: "local"` under `MODE=selfhosted`; every other kind and `MODE=cloud` SHALL be denied loopback, private, link-local, and metadata targets. This change SHALL NOT modify #4's SSRF module; it only consumes its exported primitives.

#### Scenario: A host that resolves private at fetch time is refused

- **WHEN** an adapter call is made to a provider whose hostname resolves to a metadata/private IP at connect time
- **THEN** the call is refused with an SSRF error before any request bytes are sent, and no response is returned

#### Scenario: Local kind enables the loopback exception only in self-host mode

- **WHEN** a `local` provider with a loopback `base_url` is called under `MODE=selfhosted`
- **THEN** the guarded transport permits the loopback target
- **AND** the same loopback `base_url` for a non-local kind (or under `MODE=cloud`) is refused

### Requirement: Provider errors are typed, with separate fallback and breaker classifiers

The system SHALL map provider HTTP status and network faults to `kind ∈ { auth (401/403), rate_limit (429), unavailable (5xx/408/network/timeout), bad_request (400/422), unknown_model (404-with-model-not-found body) }`, refining `404` to `unavailable` when the body indicates a wrong path rather than a missing model. Two classifiers SHALL exist: `shouldFallback(kind)` (true for `rate_limit`, `unavailable`, `unknown_model`, `auth`; false for `bad_request`) drives the proxy's chain (#10); `breakerImpact(kind)` (trip for `rate_limit`, `unavailable`, `auth`; **no trip** for `unknown_model` and `bad_request`) drives the provider-level breaker — a retired model must fall back without disabling a healthy provider.

#### Scenario: unknown_model falls back but does not open the provider breaker

- **WHEN** a provider returns a model-not-found 404
- **THEN** `shouldFallback` is true (the proxy tries another model) and `breakerImpact` does not count it toward opening the provider breaker

#### Scenario: rate-limit and timeout trip; bad request does neither harmful thing

- **WHEN** a provider returns 429, and separately a request times out
- **THEN** both map to tripping kinds (`rate_limit`, `unavailable`) that count toward the breaker
- **AND** a provider 400 maps to `bad_request` with `shouldFallback` false and no breaker impact

### Requirement: A Redis-shared circuit breaker skips failing providers across instances

The system SHALL wrap provider calls in a generation-versioned circuit breaker with `closed → open → half-open → closed` states whose state is shared via Redis so all proxy instances skip a down or rate-limited provider fast (§3.2, invariant 10). Admission SHALL return a token carrying the store, generation, and probe flag; completion SHALL apply **only when the token's generation matches** the current generation (a stale completion from a superseded generation is ignored). Each transition SHALL be atomic across instances (a single Lua script on the shared store, using the Redis server clock). After a threshold of tripping failures the breaker SHALL open for a cooldown; after cooldown a **single** half-open probe SHALL be admitted (a probe lease bounds a never-reported probe) — its success closes, its failure re-opens. `withBreakerStream` SHALL wrap streaming calls so failures observed during iteration (thrown errors, resets, normalized `error` events) count, stream completion is success, and consumer cancellation is neutral. If Redis is unavailable the breaker SHALL degrade to a per-instance in-memory decision (never fully open); the cross-instance guarantee under a Redis outage is best-effort local protection.

#### Scenario: Breaker opens, half-opens, and closes across two instances on one shared store

- **WHEN** two breaker instances share one store and one records enough tripping failures to open the breaker
- **THEN** the other instance also sees the provider as open and skips it (a `withBreaker` call raises a circuit-open error without invoking the provider)
- **AND** after the cooldown a single half-open probe is admitted, whose success returns both instances to closed and whose failure re-opens

#### Scenario: A stale completion cannot impersonate the probe

- **WHEN** a request admitted while `closed` completes after the breaker has moved to `half_open` under a new generation
- **THEN** that stale completion does not close or re-open the current generation
- **AND** only the completion of the admitted half-open probe transitions the breaker

#### Scenario: A reclaimed expired probe lease bumps the generation

- **WHEN** a half-open probe A does not report within its lease, a new probe B is admitted, and then A finally completes
- **THEN** reclaiming A's expired lease incremented the generation, so A's completion is a stale generation and is ignored
- **AND** only B's completion transitions the breaker

#### Scenario: A streamed error event is classified, not blanket-tripped

- **WHEN** a normalized `error` event is observed mid-stream
- **THEN** its raw type is mapped through the taxonomy so a model/`invalid_request`-class error falls back without opening the provider breaker
- **AND** an overloaded/5xx-class stream error trips the breaker

#### Scenario: withBreaker health follows whether the provider responded

- **WHEN** a wrapped call throws a `bad_request` error (the provider responded)
- **THEN** the breaker treats it as success (a half-open probe hitting a client fault still closes), while a `rate_limit`/`unavailable`/`auth` error counts as a tripping failure
- **AND** a caller-cancelled call is neutral

#### Scenario: Breaker degrades to per-instance when the shared store errors

- **WHEN** the shared store raises an error during a breaker decision
- **THEN** the breaker falls back to a per-instance in-memory decision and reports via its `onError` hook
- **AND** it never fails open (a locally-known-open provider is still skipped)

### Requirement: Credentials are never logged or surfaced in errors

The adapter SHALL pass the decrypted credential only in the outbound auth header and SHALL NOT include it in any thrown error, log line, or returned result (CLAUDE.md invariant 8). The credential is provided already-decrypted by the caller (#7); this module stores nothing.

#### Scenario: A failing call never leaks the credential

- **WHEN** a provider call fails (any status) and raises a typed error
- **THEN** the credential string appears in neither the error message nor any emitted log, and `testConnection()`'s failure result likewise omits it
