# protocol-translation — delta for fix-translation-request-fidelity

## ADDED Requirements

### Requirement: Cache-control, structured-output, and reasoning controls are carried without loss on the same protocol

The IR SHALL model, as optional opaque passthrough, the request-side controls both wire protocols carry
but the core does not interpret: a per-block/-tool/-system `cacheControl` marker (Anthropic prompt
caching), a `responseFormat` (OpenAI JSON / json_schema structured output), and a `reasoning` control
(OpenAI `reasoning_effort` / Anthropic `thinking`). Because the IR is created from the client protocol
but serialized to the (possibly different) provider protocol, the `reasoning` control SHALL carry its
source protocol so serialization can distinguish same-protocol emission from cross-protocol drop.
`requestIn` SHALL read these from the wire and `requestOut` SHALL re-emit each **only when serializing
back to the protocol that owns the field** — so a same-protocol passthrough never silently changes
model behavior, and a control with no equivalent in the target protocol is **dropped deliberately and
documented** (golden README / fixture dropped-field list), never mapped to an incorrect value. The
translator SHALL NOT validate or interpret the opaque payloads.

#### Scenario: Anthropic cache_control survives a same-protocol round-trip

- **WHEN** an Anthropic request carrying `cache_control` on a system block and on a tool is normalized and serialized back with the Anthropic adapter
- **THEN** the outbound request carries the same `cache_control` marker on the same block and tool
- **AND** the system prompt is emitted as a block array (not a fused string) so the marker's position is preserved

#### Scenario: OpenAI response_format and reasoning survive a same-protocol round-trip

- **WHEN** an OpenAI request with `response_format: { type: "json_schema", … }` and `reasoning_effort: "high"` is normalized and serialized back with the OpenAI adapter
- **THEN** the outbound request contains `response_format` and `reasoning_effort` equivalent to the input, rather than dropping them

#### Scenario: A control with no target-protocol equivalent is a documented drop, not a fabricated map

- **WHEN** an OpenAI request with `reasoning_effort` is serialized with the Anthropic adapter (or an Anthropic `thinking` request is serialized with the OpenAI adapter)
- **THEN** the control is omitted from the outbound request (recorded as an intentional dropped field), and no `thinking`/`reasoning_effort` value is fabricated in the other protocol

### Requirement: Multi-block content and system prompts are not fused into one string

When an IR message or system prompt holds more than one text block, the adapters SHALL preserve the
block boundaries in the outbound wire form rather than concatenating them into a single string: the
Anthropic adapter SHALL emit a `system` text-block array (carrying per-block `cache_control`), and the
OpenAI adapter SHALL emit a content-parts array for message/system content. A single text block MAY
still serialize to a plain string (canonically equivalent). No adapter SHALL join adjacent text blocks
without a separator, which would alter the prompt text and destroy the caching layout.

#### Scenario: A two-block system prompt round-trips without fusion

- **WHEN** an Anthropic request whose `system` is two text blocks is normalized and serialized back with the Anthropic adapter
- **THEN** the outbound `system` is a two-element block array whose blocks equal the originals (canonical round-trip equivalence holds), not a single fused string
- **AND** the same IR serialized with the OpenAI adapter yields multi-part system content, never `blockA.text + blockB.text`

### Requirement: Cross-protocol temperature is clamped to the target protocol's range

Because OpenAI `temperature` ranges 0–2 and Anthropic's is 0–1, the Anthropic adapter's `requestOut`
SHALL clamp `temperature` to `[0, 1]` so a legal OpenAI request routed to an Anthropic model produces a
valid upstream request (rather than an upstream 400 that is classified `bad_request` and refuses
fallback). Same-protocol Anthropic input is already in range and is unaffected. The clamp SHALL be
documented as a lossy mapping in the golden README.

#### Scenario: An out-of-range OpenAI temperature is clamped for Anthropic

- **WHEN** an OpenAI request with `temperature: 1.5` is serialized with the Anthropic adapter
- **THEN** the outbound Anthropic request has `temperature: 1`
- **AND** an in-range value (e.g. `0.7`) is passed through unchanged
