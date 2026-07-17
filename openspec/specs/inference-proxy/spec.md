# inference-proxy Specification

## Purpose
TBD - created by archiving change add-inference-proxy-core. Update Purpose after archive.
## Requirements
### Requirement: OpenAI- and Anthropic-compatible proxy endpoints on the agent-key plane

The system SHALL expose `POST /v1/chat/completions` (OpenAI wire), `POST /v1/messages` (Anthropic wire), and `GET /v1/models`, each authenticated by the agent-key guard (spec §6.1, invariant 7). The key is verified by prefix lookup + HMAC compare and accepted from **either** `Authorization: Bearer <key>` (OpenAI SDK) **or** `x-api-key: <key>` (Anthropic SDK) so both SDKs are drop-in; an unknown/missing key, or two conflicting credential headers, is rejected with 401 (a key is revoked by deletion — there is no separate "disabled" state). A valid key stamps the agent's `last_used_at` off the request path. All routing config is read scoped to the key's owning principal (invariant 5).

#### Scenario: Either SDK's credential header authenticates; an invalid one is rejected

- WHEN a request carries a valid key as `Authorization: Bearer <key>` (OpenAI SDK) or as `x-api-key: <key>` (Anthropic SDK)
- THEN it is served for that key's owner and the agent's `last_used_at` is updated without blocking the response
- WHEN the key is missing, malformed, unknown, or two credential headers disagree
- THEN the response is 401 (in the caller's protocol envelope) and no upstream call is made

#### Scenario: Config is read only for the key's owner

- WHEN principal A's key is used
- THEN routing resolves only over A's tiers, entries, rules, models, and providers — B's config is never consulted or reachable by id

### Requirement: Explicit route resolution with a defined precedence

The system SHALL resolve each request to a concrete provider+model by ordered phases (spec §6.1, §7.2 Layer 0). Resolution is pure over an owned config snapshot; it MUST **sort rules itself** (`priority` desc, then `created_at`, then `id` — the accessors are unordered) and select a tier's primary by `position === 0` (never array order). Phases, first hit wins:

1. **`model` field** — an *explicit* selection terminates here: a provider-qualified `"<providerId>:<externalId>"`, a bare external id matching exactly one owned model, or a tier key resolves directly. `auto` and an empty `model` make **no** explicit selection and continue to phase 2 (so `auto` still honors a header/rule and `auto` alone lands on `default`; `auto` MUST be accepted — spec §2, smart pipeline is #13/#14). A non-empty value matching nothing returns `unknown_model` (never a silent fall-through to `default`). A bare value that is both a model id and a tier key resolves to the **model** (explicit-model precedence).
2. **A matching custom `header` RoutingRule** (#9) → its target (a `tier:` target's primary, or a `model:` target directly).
3. **The built-in `x-polyrouter-tier` header** naming an owned tier (evaluated before default rules, so it still forces a tier when a default rule exists).
4. **A `default`-match RoutingRule** (if any) → its target.
5. **The seeded `default` tier**.

A resolved tier uses its **primary** (position-0) model; walking the fallback chain is #12. Resolution SHALL emit a `decisionLayer` (`explicit` for a named model/tier, `header` for a header/custom-rule match, `default` for auto / default-rule / default-tier) and a human-readable `routingReason` for #11.

#### Scenario: Naming a model routes to it explicitly; ambiguity is an error, not a guess

- WHEN the `model` field names (bare, or provider-qualified) exactly one concrete model the caller owns
- THEN the request is forwarded to that model's provider, with `decisionLayer = explicit`
- WHEN a bare `model` id matches more than one owned model (the same external id on two providers)
- THEN resolution returns an `ambiguous_model` error (never a nondeterministic pick that could change when a provider is added); the caller disambiguates with the `"<providerId>:<externalId>"` form

#### Scenario: A tier key or header forces a tier; a default rule cannot shadow the header

- WHEN the `model` field is a tier key, or a custom `header` rule matches, or the built-in `x-polyrouter-tier` header names an owned tier
- THEN the resolved tier's primary model serves the request (`decisionLayer = header` for a header/custom-rule match), and the built-in header still forces its tier even if a `default`-match rule exists
- WHEN nothing else is specified
- THEN the `default` tier's primary model serves it (`decisionLayer = default`)

#### Scenario: `auto` is accepted and still honors header/default routing

- WHEN the `model` field is `auto` (or empty) with no header/rule
- THEN the request is served by the `default` tier's primary model (never rejected for being `auto`), so an agent configured with `model: auto` works today and gains smart routing later with no client change
- WHEN the `model` field is `auto` and an `x-polyrouter-tier` header (or custom rule) matches
- THEN that header/rule still forces its tier (auto does not short-circuit header routing)

#### Scenario: An unrecognized model name is not silently defaulted

- WHEN the `model` field is a non-empty value that is neither `auto`, an owned model, nor a tier key, and no header/rule applies
- THEN resolution returns `unknown_model` (a clear 4xx), rather than silently serving the `default` tier and hiding the mistake

### Requirement: Any client protocol reaches any provider protocol

The system SHALL translate every request through #5's `Normalized*` IR so an OpenAI-shaped client can call an Anthropic upstream and vice-versa (spec §6.1, §6.3, invariant 2): the client adapter maps client-wire → IR and IR → client-wire; the #6 provider adapter maps IR → provider-wire and back. The IR's `model` is retargeted to the resolved provider's external model id before the upstream call. System prompt, multi-turn tool calls, stop reasons, and usage MUST survive the round-trip.

#### Scenario: OpenAI client ⟷ Anthropic upstream round-trips

- WHEN an OpenAI-shaped `/v1/chat/completions` request (plain, multi-turn-tool, or streamed) resolves to an Anthropic-protocol provider
- THEN the client receives a correct OpenAI-shaped response, with system prompt, tool arguments, stop reason, and usage mapped correctly
- WHEN an Anthropic-shaped `/v1/messages` request resolves to an OpenAI-protocol provider
- THEN the client receives a correct Anthropic-shaped response by the same round-trip

### Requirement: Streaming with end-to-end backpressure and a mid-stream commit boundary

For `stream: true` the system SHALL stream SSE in the client's protocol; otherwise it returns a single buffered JSON body. Streaming MUST apply **backpressure** end-to-end (spec §3.2.5, invariant 12): a slow client pauses the upstream pull so tokens never buffer unboundedly, `res.write` backpressure is honored without hanging when the client disconnects, and the upstream iterator is always cancelled on completion or disconnect. The **mid-stream commit rule** (invariant 3, spec §6.3) MUST hold and gate on the first *successful* event: an upstream failure *before the first successful event* — whether the upstream throws **or yields an error event first** — is a clean HTTP error with no partial stream; once a successful event has been written the model is **committed**, and a later upstream failure terminates the stream with a **sanitized** terminal error event (fixed message, never the raw upstream body) and the model is **never** silently swapped.

#### Scenario: A slow or disconnecting client backpressures the upstream

- WHEN the client reads a streamed response slowly
- THEN the proxy stops pulling upstream events until the client socket drains, so process memory does not grow unboundedly
- WHEN the client disconnects mid-stream
- THEN the upstream call is aborted and its iterator cancelled promptly (no leaked socket, no hung drain wait)

#### Scenario: Failure before the first successful event vs after it

- WHEN the upstream fails before the first successful event is forwarded (it throws, returns non-2xx, or yields an error event as the first event)
- THEN the client receives a clean protocol-shaped HTTP error (no partial stream), and no response body was committed
- WHEN the upstream fails after a successful event has been written
- THEN the stream is terminated with a sanitized, protocol-correct terminal error event, the response is not silently completed by another model, and it is flagged an error

### Requirement: In-flight streams drain on shutdown

The system SHALL drain in-flight streaming responses on shutdown rather than severing them mid-token (spec §3.2.5, §15; invariant 12): shutdown hooks are enabled, a registry tracks active streams, new inference is refused with a protocol-shaped 503 once shutdown begins, and active streams are awaited up to a bounded deadline before the process exits. The bounded deadline SHALL be honored even when a stream is blocked writing to a slow or non-reading client: at the deadline the drain aborts the stream, ends and releases its response socket, and shutdown completes — the process MUST NOT hang past the deadline waiting on a write-blocked connection.

#### Scenario: A deploy drains active completions

- WHEN the process receives a shutdown signal while a completion is streaming
- THEN the in-flight stream is allowed to finish (up to a bounded deadline) and new inference requests are refused with a 503, rather than the live stream being cut mid-token

#### Scenario: Shutdown completes even when a client stops reading

- WHEN a shutdown begins while a stream is blocked on backpressure because its client has stopped reading but kept the connection open
- THEN at the drain deadline the stream's upstream call is aborted, its response socket is ended and destroyed, and `app.close()` resolves within the drain deadline plus a bounded allowance (the registry's poll interval plus a fixed tolerance) rather than hanging until the process is force-killed

### Requirement: Errors are returned in the client's protocol envelope

The system SHALL render **every** `/v1` failure in the caller's own error shape (OpenAI `{ error: { message, type, code } }` / Anthropic `{ type: "error", error: {…} }`), protocol chosen by route, with sane status codes and fixed messages, never leaking upstream credentials, request ids, or raw bodies. A `/v1` exception filter covers the guard's 401, the resolver's typed errors, and upstream `ProviderError`s; a `/v1`-scoped body-parse error handler covers malformed JSON **and oversized bodies** (which fail in the body parser before the Nest filter) with a protocol-shaped status — a malformed body is a 400 and an over-limit body is a 413. The request body limit SHALL be configurable (`PROXY_MAX_BODY_BYTES`) and default large enough (≥ 10 MB) that realistic agent conversations are not rejected; a body within the limit SHALL be parsed and routed normally. The mapping is exhaustive: resolver `unknown_model`/`ambiguous_model`→404, `empty_tier`/`unresolved_target`→400, `no_default`→500; body too large→413, body parse failure→400; upstream auth→502, rate_limit→429, unavailable→503, bad_request→400, unknown_model→404. This includes the **empty-tier / unresolved-target runtime error** whose contract #9 defined: resolving to a tier with no models, or to a rule target whose tier/model no longer exists, yields a clear client-facing error, not a 500 or a hang.

#### Scenario: A large but valid body is served, not rejected

- WHEN an agent POSTs a valid request whose body is well under `PROXY_MAX_BODY_BYTES` (e.g. a ~200 KB multi-turn conversation) to `/v1/chat/completions` or `/v1/messages`
- THEN the body is parsed and the request is routed normally (no 413), because the default limit is large enough for realistic harness payloads

#### Scenario: An over-limit body is a protocol-shaped 413, never HTML

- WHEN a request body exceeds `PROXY_MAX_BODY_BYTES`
- THEN the client receives a 413 in its own protocol envelope (OpenAI `{ error: {…} }` on `/v1/chat/completions`, Anthropic `{ type: "error", error: {…} }` on `/v1/messages`) with a fixed message — never an HTML page or a stack trace, and no upstream call is made

#### Scenario: A malformed JSON body is a protocol-shaped 400

- WHEN a `/v1` request body is not valid JSON
- THEN the client receives a 400 in its own protocol envelope, not the body parser's default HTML error

#### Scenario: Resolving to an empty or unresolved tier is a clear client error

- WHEN routing resolves to a tier that has no routing entries, or a rule target that no longer resolves to an owned model/tier
- THEN the client receives a clear protocol-shaped error identifying the misconfiguration, with a 4xx status, and no upstream call is made

#### Scenario: An unknown model name is a clear client error

- WHEN the `model` field is a non-empty value that matches no owned model, tier key, or the `auto` alias, and no header/rule/default resolves it
- THEN the client receives a protocol-shaped "model not found" error (4xx), not a silent fallthrough that hides the mistake

#### Scenario: Upstream errors are sanitized

- WHEN the upstream returns an error (auth, rate-limit, unavailable)
- THEN the client receives a protocol-shaped error with a mapped status and a fixed message — never the upstream's raw body, request id, or the provider credential

### Requirement: `GET /v1/models` lists the tenant's models and aliases

The system SHALL return, for the authenticated principal, an OpenAI-list-shaped catalog of **routable** ids — each model's provider-qualified `"<providerId>:<externalId>"` id, each bare external id that is **unambiguous** (present on only one provider), each tier key, and the `auto` alias (spec §6.1) — so every listed id resolves deterministically. Other tenants' models are excluded.

#### Scenario: Only routable ids are advertised

- WHEN a caller requests `GET /v1/models`
- THEN the response lists each tier key, `auto`, every model's provider-qualified id, and a bare external id only when that id is unambiguous — so a listed id never resolves to `ambiguous_model` — and excludes any other tenant's models

### Requirement: A multi-choice (`n > 1`) request is rejected in-protocol

The IR normalizes a single assistant choice and delegates `n > 1` policy to the proxy
(protocol-translation). The proxy SHALL enforce that policy: an OpenAI-wire request whose `n` is a
number greater than 1 SHALL be rejected before any upstream call with a protocol-shaped 400
(`invalid_request_error`) explaining that the router returns a single choice — rather than silently
dropping `n` and returning one choice as if `n` had been honored. A request with `n` absent or equal
to 1 SHALL be unaffected. The rejection SHALL be raised before request normalization so its
explanatory message is not overwritten by the generic invalid-body error.

#### Scenario: n > 1 is a clear 400, not a silent single choice

- **WHEN** a client POSTs `/v1/chat/completions` with `n: 2`
- **THEN** the response is a 400 in the OpenAI error envelope naming that `n > 1` is unsupported, and no upstream call is made

#### Scenario: n = 1 or absent is served normally

- **WHEN** a client sends `n: 1` or omits `n`
- **THEN** the request is routed and served as before

### Requirement: A client abort is recorded as cancelled, never a provider failure

When a proxied request fails **because the caller's own request was aborted** (the client
disconnected or cancelled), the proxy SHALL record it with a distinct terminal status
`cancelled` — never `error` — and SHALL NOT fire the failure-spike notification for it. The
decision is made from the **pure client abort signal** at record time (the same signal the
breaker uses to treat a caller-gone teardown as neutral), not from the upstream error, so a
client hang-up cannot inflate the error-rate metric or the `request_failures_spike` producer
with a provider failure the provider never had. This applies to the buffered chain, the
streaming chain (both before and after the mid-stream commit boundary), and the cascade
paths. A genuine upstream failure (the client is still connected) SHALL continue to record
`error` and fire the failure-spike notify as before.

#### Scenario: A client-aborted request records cancelled and does not alert

- WHEN a buffered or streaming request fails and the caller's request signal is aborted at
  the time the outcome is recorded
- THEN the RequestLog is written with `status = cancelled` (not `error`)
- AND the failure-spike producer is not notified for that request
- AND the error-count analytics (which count `status = error`) do not include it

#### Scenario: A genuine provider failure still records error and alerts

- WHEN a request fails on an upstream/provider error while the caller is still connected (its
  signal is not aborted)
- THEN the RequestLog is written with `status = error` and the failure-spike producer is
  notified, exactly as before this change

