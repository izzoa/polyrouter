# inference-proxy — delta for fix-proxy-ingress-and-drain

## MODIFIED Requirements

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

### Requirement: In-flight streams drain on shutdown

The system SHALL drain in-flight streaming responses on shutdown rather than severing them mid-token (spec §3.2.5, §15; invariant 12): shutdown hooks are enabled, a registry tracks active streams, new inference is refused with a protocol-shaped 503 once shutdown begins, and active streams are awaited up to a bounded deadline before the process exits. The bounded deadline SHALL be honored even when a stream is blocked writing to a slow or non-reading client: at the deadline the drain aborts the stream, ends and releases its response socket, and shutdown completes — the process MUST NOT hang past the deadline waiting on a write-blocked connection.

#### Scenario: A deploy drains active completions

- WHEN the process receives a shutdown signal while a completion is streaming
- THEN the in-flight stream is allowed to finish (up to a bounded deadline) and new inference requests are refused with a 503, rather than the live stream being cut mid-token

#### Scenario: Shutdown completes even when a client stops reading

- WHEN a shutdown begins while a stream is blocked on backpressure because its client has stopped reading but kept the connection open
- THEN at the drain deadline the stream's upstream call is aborted, its response socket is ended and destroyed, and `app.close()` resolves within the drain deadline plus a bounded allowance (the registry's poll interval plus a fixed tolerance) rather than hanging until the process is force-killed
