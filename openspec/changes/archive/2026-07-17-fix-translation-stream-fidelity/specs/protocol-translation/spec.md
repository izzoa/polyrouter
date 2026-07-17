# protocol-translation — delta for fix-translation-stream-fidelity

## ADDED Requirements

### Requirement: Streamed output to the client is wire-conformant and never fabricates a terminator

When serializing a `NormalizedStreamEvent` sequence to the Anthropic client wire, the serializer SHALL
emit exactly one `message_delta` immediately before `message_stop`, carrying `usage.output_tokens` as a
number (the best-known accumulated value, or `0` when genuinely unknown — Anthropic SDKs require the
field) and a non-null `stop_reason` whenever any stop reason was observed in the stream; a later
usage-only event SHALL NOT clobber an already-known stop reason to null. The IR/recording side SHALL
keep usage `undefined` when unknown (the wire `0` is a wire-only concession, never a recorded zero). If
`message_stop` is reached with no stop reason ever observed, the serializer SHALL emit a normalized
`error` rather than fabricating a stop reason. For streamed requests to an OpenAI-compatible upstream,
`requestOut` SHALL set `stream_options: { include_usage: true }` so the provider's exact usage is
available (prefer provider usage, §7.7). When an upstream stream ends without its protocol terminator
(`[DONE]` / a finish-reason chunk for OpenAI; a `message_stop` event for Anthropic), the parser SHALL
emit a normalized `error` event rather than a clean terminator, so the truncation is recorded as an
error, not laundered into success.

#### Scenario: Every serialized Anthropic message_delta carries usage and a stable stop reason

- **WHEN** an OpenAI upstream stream (finish-reason chunk, then a terminal usage-only chunk) is parsed and serialized with the Anthropic adapter
- **THEN** the serialized stream contains exactly one `message_delta` before `message_stop`, its `usage.output_tokens` is a number, and its `stop_reason` is the mapped non-null reason (not `null`)

#### Scenario: Streamed OpenAI requests opt into usage reporting

- **WHEN** a streamed request (`stream: true`) is serialized with the OpenAI adapter
- **THEN** the outbound request includes `stream_options: { include_usage: true }`
- **AND** a non-streamed request does not

#### Scenario: A truncated upstream stream becomes an error event on either parser

- **WHEN** an OpenAI upstream SSE stream ends without a `[DONE]` sentinel or any finish-reason chunk (or an Anthropic upstream stream ends without a `message_stop` event)
- **THEN** the parser emits a normalized `error` event (type `truncated`) instead of a clean terminator
- **AND** a stream that did end with its terminator still emits `message_stop` as before

### Requirement: Unknown streamed and non-streamed content degrades without throwing or corrupting the stream

Translation SHALL never throw on, or emit malformed events for, unmodeled provider output. In the
Anthropic stream parser, a `content_block_start` of an unrecognized type SHALL be skipped (no IR block
opened) and its subsequent deltas and stop ignored, so an unknown delta (for example a `thinking_delta`)
never reaches the proxy as a `tool_use_delta` with undefined JSON. An unknown non-streamed response
content-block type (for example `thinking` / `redacted_thinking` / `server_tool_use`) SHALL be skipped
rather than producing an `undefined` IR block that crashes a later serialization; an unknown request
content-part type (for example OpenAI `input_audio` / `file`) SHALL be skipped rather than force-read as
an image. An in-band OpenAI stream `error` frame SHALL be recognized and emitted as a normalized `error`
event before the parser reads the chunk's `choices`, never raising a `TypeError`.

#### Scenario: An unknown streaming block does not corrupt the stream

- **WHEN** an Anthropic upstream stream contains a `thinking` content block (start + `thinking_delta` + stop) alongside a normal text block
- **THEN** the thinking block is skipped (no `tool_use_delta` with undefined JSON is emitted) and the text block streams normally, without throwing

#### Scenario: An unknown non-streamed block or request part is skipped

- **WHEN** a provider response contains a `thinking` block followed by a `text` block, or an OpenAI request contains a content part that is neither `text` nor `image_url`
- **THEN** normalization completes without throwing (the unknown block/part is skipped) and the recognized content is preserved

#### Scenario: An in-band OpenAI error frame becomes a normalized error event

- **WHEN** an OpenAI upstream stream emits a frame whose JSON is `{ "error": { … } }` (no `choices`)
- **THEN** the parser yields a normalized `error` event carrying the error's type/message, rather than raising a `TypeError` on `choices`

## MODIFIED Requirements

### Requirement: Golden-file contract suite proves canonical round-trip and cross-translation

The system SHALL ship a golden-file contract test suite (spec §6.3 definition of done) with committed fixtures per protocol across the matrix: plain, multi-turn tool round-trip, streamed, multimodal, and error (in-band stream `error` events and malformed/edge wire payloads — not HTTP transport errors, which are #6/#10). The suite SHALL assert **canonical round-trip equivalence** — `canon(…Out(…In(x)))` deep-equals `canon(x)`, where `canon` coerces content/system to block-array form and normalizes equivalent parameter encodings, and each fixture records which fields are canonicalized vs. intentionally dropped — and **cross-translation** correctness (OpenAI client ⟷ Anthropic upstream and vice-versa) for requests, responses, and streams. The suite SHALL run as `npm test -w packages/data-plane` and require no network, database, or live provider keys; fixture provenance (documented wire-format source/version) SHALL be recorded. The suite SHALL cover the **client-facing Anthropic stream serializer** (`streamSerialize`) — not only the parser — including the cross-direction OpenAI-upstream → Anthropic-client stream (asserting the single conformant `message_delta` with usage and stop reason before `message_stop`), and SHALL include an in-band `error` stream event fixture that is exercised end to end and a malformed streamed tool-call case; the golden README SHALL accurately describe the error coverage it actually ships.

#### Scenario: Canonical round-trip equivalence holds for every fixture

- **WHEN** the contract suite loads a committed request or response fixture and applies `canon(…Out(…In(fixture)))` in the same protocol
- **THEN** the result deep-equals `canon(fixture)`, and the fixture's canonicalized/dropped field list documents any wire fields not carried by the IR
- **AND** the assertion runs without any network or database access

#### Scenario: Cross-translation matches the expected golden output

- **WHEN** the suite translates an OpenAI fixture to Anthropic (and vice-versa) for request, response, and stream cases
- **THEN** the output deep-equals the committed golden expectation for that direction
- **AND** the streamed cases verify concatenated text, assembled tool JSON, mapped stop reason, and usage (incl. cache tokens across the start/delta lifecycle)

#### Scenario: Usage golden cases cover cache hit, write, mixed, and none

- **WHEN** the suite runs the numeric usage fixtures (cache-read only, cache-write only, mixed read+write+fresh, and no usage)
- **THEN** each direction's converted token counts equal the committed expected values (respecting the uncached-component formulas)
- **AND** the no-usage case yields `undefined`, never zero

#### Scenario: The Anthropic stream serializer and in-band error events are covered

- **WHEN** the suite parses an OpenAI upstream stream and serializes it with the Anthropic adapter, and separately parses an in-band `error` stream event and a malformed streamed tool call
- **THEN** the Anthropic-client frames are asserted at the frame level (a regression in event names or required fields fails a test), the `error` event is carried through parsing, and the malformed tool call finalizes as the `inputParseError` variant
- **AND** the golden README's error-coverage description matches the shipped fixtures
