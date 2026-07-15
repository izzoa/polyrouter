## ADDED Requirements

### Requirement: Normalized intermediate representation is the single canonical shape

The system SHALL define one `Normalized*` intermediate representation (IR) in `data-plane/src/proxy/translate/` that covers requests, responses, and streaming events, and it SHALL be the only place a normalized (protocol-agnostic) message shape is defined. Provider adapters (#6) and the proxy (#10) consume this IR; no other module defines a competing normalized shape (CLAUDE.md invariant 2).

The IR SHALL be content-blocks-everywhere: a `NormalizedMessage` has a `role` (`user` | `assistant` | `tool`) and a `content` array of blocks; a block is a discriminated union of `text`, `image`, `tool_use`, and `tool_result`. The system prompt SHALL be a top-level `NormalizedRequest.system` field (not a message). Tool-call arguments SHALL be carried as parsed objects on success, never as a stringified JSON string. The IR SHALL normalize a single assistant choice (`n = 1`); fanning out multiple choices is out of scope (the proxy, #10, decides policy for `n > 1`).

#### Scenario: IR is the sole normalized shape

- **WHEN** a downstream module (provider adapter or proxy) needs a protocol-agnostic request, response, or stream event
- **THEN** it references the `Normalized*` types from `data-plane/src/proxy/translate/`
- **AND** no normalized/canonical message shape is defined anywhere else in the codebase

#### Scenario: Tool input is a parsed object in the IR

- **WHEN** a request or response containing a tool call with valid-JSON arguments is normalized into the IR
- **THEN** the `tool_use` block's `input` is a parsed object (e.g. `{ location: "SF" }`), not a JSON string
- **AND** re-serializing to a protocol that expects a string (OpenAI `arguments`) produces the stringified form only at the adapter boundary

### Requirement: Request translation preserves system prompt, tools, tool choice, and parameters both ways

The system SHALL translate a client request in either protocol into the IR (`requestIn`) and serialize the IR back into either protocol (`requestOut`). OpenAI's leading `role:"system"` message SHALL map to/from the IR's top-level `system` field; Anthropic's top-level `system` SHALL map to/from the same field. Tool/function definitions and generation parameters (temperature, top_p, max output tokens, stop sequences) SHALL be carried without loss for fields both protocols share, mapping each protocol's field names (`max_completion_tokens`/legacy `max_tokens` ⟷ IR `maxOutputTokens` ⟷ Anthropic `max_tokens`). Because Anthropic requires `max_tokens` but OpenAI's is optional, the IR `maxOutputTokens` SHALL be optional and the Anthropic adapter SHALL resolve the outbound `max_tokens` from IR `maxOutputTokens` or an adapter `defaultMaxOutputTokens` option; with neither, `requestOut` SHALL return a structured serialization error (a precondition on our own outbound request), which the proxy (#10) — knowing the model's limit — always satisfies. Tool-selection control SHALL be carried as a canonical `toolChoice` (`auto` | `none` | `required` | `{ toolName }`) and a parallel-call control (`allowParallelTools`), mapped both ways (OpenAI `tool_choice` + `parallel_tool_calls`; Anthropic `tool_choice.type` with `any`⟷`required`, `tool`⟷`{toolName}`, and `disable_parallel_tool_use = !allowParallelTools`).

#### Scenario: OpenAI system message becomes the IR system field

- **WHEN** an OpenAI request whose first message is `{ role: "system", content: "You are…" }` is passed to `requestIn`
- **THEN** the IR's top-level `system` field holds that text as a block array
- **AND** the IR `messages` array does not contain a system-role message

#### Scenario: Anthropic system field round-trips through the IR

- **WHEN** an Anthropic request with a top-level `system` string is normalized and then serialized back with the Anthropic adapter's `requestOut`
- **THEN** the resulting request's `system` (in canonical form) equals the original's canonical form
- **AND** no system content leaks into the `messages` array

#### Scenario: Cross-protocol request translation extracts system and maps tools

- **WHEN** an OpenAI request with a system message and tool definitions is normalized and serialized with the Anthropic adapter's `requestOut`
- **THEN** the system prompt appears in Anthropic's top-level `system` field
- **AND** the tools appear in Anthropic's `tools` array with `input_schema` derived from the OpenAI `parameters`

#### Scenario: Forced tool choice is preserved across protocols

- **WHEN** an OpenAI request with `tool_choice: { type: "function", function: { name: "get_weather" } }` and `parallel_tool_calls: false` is normalized and serialized with the Anthropic adapter
- **THEN** the Anthropic request has `tool_choice: { type: "tool", name: "get_weather", disable_parallel_tool_use: true }`
- **AND** normalizing OpenAI `tool_choice: "required"` yields Anthropic `tool_choice: { type: "any" }` and back

#### Scenario: Missing max output tokens resolves from the adapter default

- **WHEN** an OpenAI request with no token limit is normalized (IR `maxOutputTokens` undefined) and serialized with the Anthropic adapter configured with `defaultMaxOutputTokens: 4096`
- **THEN** the Anthropic request's `max_tokens` is `4096`
- **AND** serializing with an Anthropic adapter that has no default and no IR `maxOutputTokens` returns a structured serialization error rather than emitting an invalid request

### Requirement: Response translation maps content, stop reasons, and usage both ways

The system SHALL translate a provider response in either protocol into the IR (`responseIn`) and serialize the IR into either protocol (`responseOut`). Assistant content blocks (text and tool_use) SHALL be preserved. Response envelope identity SHALL be carried in the IR — `id` and `model` always, and `created` as an **optional** field (OpenAI supplies it; Anthropic responses have none). Because the module is pure and deterministic (no clock reads), when serializing to a protocol that requires `created` and the IR lacks it, `responseOut` SHALL take an optional serialization context `{ created?: number }` (the proxy supplies the request-time value); absent both, it SHALL emit `created: 0` as a documented placeholder, never a wall-clock read. Finish/stop reasons SHALL map onto a canonical `NormalizedStopReason` (`stop` | `length` | `tool_use` | `content_filter` | `pause` | `error` | `other`) and back to each protocol's nearest native value; the original provider value SHALL be preserved as `rawStopReason`, and Anthropic's matched stop sequence as `stopSequence`.

#### Scenario: OpenAI finish_reason maps to canonical and back

- **WHEN** an OpenAI response with `finish_reason: "tool_calls"` is normalized
- **THEN** the IR's `stopReason` is `tool_use` and `rawStopReason` is `"tool_calls"`
- **AND** serializing back with the OpenAI adapter yields `finish_reason: "tool_calls"`
- **AND** serializing with the Anthropic adapter yields `stop_reason: "tool_use"`

#### Scenario: Anthropic stop_sequence preserves the matched sequence

- **WHEN** an Anthropic response with `stop_reason: "stop_sequence"` and `stop_sequence: "\n\nHuman:"` is normalized
- **THEN** the IR's `stopReason` is `stop`, `rawStopReason` is `"stop_sequence"`, and `stopSequence` is `"\n\nHuman:"`
- **AND** serializing back with the Anthropic adapter restores both fields

#### Scenario: Refusal and continuation stops map to distinct canonical values

- **WHEN** an Anthropic response has `stop_reason: "refusal"`, and separately one has `stop_reason: "pause_turn"`
- **THEN** the first maps to `content_filter` and the second to `pause` (kept distinct because it is continuation-required)
- **AND** both preserve their `rawStopReason`

#### Scenario: Unknown stop reason degrades, never throws

- **WHEN** a response carries a stop reason not in either protocol's known set
- **THEN** the IR's `stopReason` is `other` and `rawStopReason` holds the original value
- **AND** translation completes without throwing

#### Scenario: Missing `created` is supplied by context, never by the clock

- **WHEN** an Anthropic response (which has no `created`) is normalized and serialized to OpenAI with a serialization context `{ created: 1700000000 }`
- **THEN** the OpenAI response's `created` is `1700000000`
- **AND** serializing without a context yields `created: 0` (a documented placeholder), and no code path reads the wall clock

### Requirement: Tool-call round-trips survive multi-turn, parallel calls, and trailing text

The system SHALL correctly translate a full tool-use conversation in both directions. An assistant turn with one or more `tool_use` blocks (parallel calls) SHALL preserve every call with its `id`, `name`, and parsed `input`, in order. Each tool result SHALL be carried as its own `role:"tool"` message holding exactly one `tool_result` block keyed by `toolUseId`. The OpenAI adapter SHALL map one `role:"tool"` message ⟷ one OpenAI tool message per `tool_call_id`. The Anthropic adapter SHALL group a run of consecutive `role:"tool"` messages into a single `user` message with the `tool_result` blocks first, appending any immediately-following `role:"user"` message's blocks as trailing content of that same user message; on the way in it SHALL split an Anthropic `user` message of `[tool_result…][text/image…]` back into the ordered `role:"tool"` messages plus a following `role:"user"` message for the trailing blocks.

#### Scenario: Parallel tool calls in one assistant turn are preserved

- **WHEN** an assistant response with two `tool_use` blocks (e.g. `get_weather` and `get_time`) is normalized and re-serialized in the same protocol
- **THEN** both tool calls are present with their original `id`, `name`, and parsed `input`
- **AND** their order is preserved

#### Scenario: Anthropic groups tool results and trailing text into one user message

- **WHEN** an IR conversation with two consecutive `role:"tool"` messages (results for two parallel calls, one an error result) followed by a `role:"user"` text message is serialized with the Anthropic adapter
- **THEN** both `tool_result` blocks (one with `is_error: true`) appear first inside a single `user` message, followed by the text block
- **AND** serializing the same IR with the OpenAI adapter yields two separate `role:"tool"` messages (one per `tool_call_id`) plus a separate `role:"user"` text message

#### Scenario: Full multi-turn tool round-trip cross-translates without loss

- **WHEN** an OpenAI multi-turn tool conversation (assistant tool_calls → tool results → assistant final answer) is normalized and serialized with the Anthropic adapter, then normalized again and serialized back with the OpenAI adapter
- **THEN** the final OpenAI conversation is canonically equivalent to the original (same tool call ids linked to the same results, same message order, same parsed inputs)

### Requirement: Malformed tool-argument JSON is represented, never thrown

The system SHALL treat invalid-JSON tool arguments (which OpenAI documents can occur) as data, not an error. A `tool_use` block SHALL be `{ id, name, input: object }` on successful parse or `{ id, name, inputRaw: string, inputParseError: true }` on failure. No translation function SHALL throw on malformed model output. Serializing the failure variant SHALL re-emit the raw string as the tool arguments.

#### Scenario: Non-streaming malformed arguments are preserved as raw

- **WHEN** an OpenAI response contains a `tool_calls` entry whose `arguments` is `"{ location: "` (invalid JSON) and is normalized
- **THEN** the IR `tool_use` block is the `{ inputRaw: "{ location: ", inputParseError: true }` variant
- **AND** translation does not throw, and serializing back re-emits the raw `arguments` string

#### Scenario: Streamed malformed arguments finalize as raw at block stop

- **WHEN** a streamed tool call's accumulated argument fragments do not form valid JSON by `block_stop`
- **THEN** the finalized `tool_use` block is the `inputParseError` variant carrying the raw accumulated string
- **AND** no exception is raised mid-stream

### Requirement: Multimodal content normalizes with encoding and detail, without fetching remote URLs

The system SHALL normalize image content from both protocols into an IR `image` block that is `{ data, mediaType, detail? }` or `{ url, detail? }` with `detail?` one of `auto`/`low`/`high`. OpenAI `image_url` (`data:` URL or http(s) URL, with `detail`) and Anthropic `source` (`base64` or `url`) SHALL map in; each adapter SHALL emit its native shape out (OpenAI carries `detail`; Anthropic omits it but the IR preserves it for the reverse trip). The translator SHALL NOT fetch remote image URLs (fetching is the proxy's SSRF-guarded concern, #6/#10); a remote `http(s)` URL is preserved as the `{ url }` variant.

#### Scenario: Detail survives an OpenAI same-protocol round-trip

- **WHEN** an OpenAI message with an `image_url` `data:` URL and `detail: "high"` is normalized and serialized back with the OpenAI adapter
- **THEN** the result carries the same bytes, media type, and `detail: "high"`

#### Scenario: Detail is intentionally dropped across an Anthropic wire boundary

- **WHEN** an OpenAI image with `detail: "high"` is serialized to the Anthropic wire, then re-normalized and serialized back to OpenAI
- **THEN** the Anthropic form carries the base64 `source` with the same bytes and media type but no detail (Anthropic has no such field)
- **AND** the final OpenAI form omits `detail` (documented as a dropped field in the golden), rather than fabricating a value

#### Scenario: Remote image URL is preserved, not fetched

- **WHEN** an OpenAI message with an `image_url` pointing at `https://example.com/cat.png` is normalized
- **THEN** the IR `image` block holds `{ url: "https://example.com/cat.png" }`
- **AND** no network request is made during translation

### Requirement: Usage translation uses uncached components and preserves cache tokens

The system SHALL translate token usage into `NormalizedUsage { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }` where `inputTokens` is the **uncached (fresh)** input count and `totalInput = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)`. Because Anthropic `input_tokens` excludes cache tokens while OpenAI `prompt_tokens` includes cached tokens, the adapters SHALL convert by formula, not field-for-field: Anthropic `input_tokens`→`inputTokens`, `cache_read_input_tokens`→`cacheReadTokens`, `cache_creation_input_tokens`→`cacheWriteTokens`; OpenAI `cached_tokens`→`cacheReadTokens` and `inputTokens = prompt_tokens − cached_tokens` (in: OpenAI has no cache-write; out: `prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`, `cached_tokens = cacheReadTokens`). Missing usage SHALL remain `undefined` (the proxy flags `usage_estimated`, #11) — never a silent zero (spec §7.7, invariant 4).

#### Scenario: Anthropic cache tokens map by component

- **WHEN** an Anthropic response reports `input_tokens: 20`, `cache_read_input_tokens: 80`, `cache_creation_input_tokens: 10`, `output_tokens: 5`
- **THEN** the IR usage is `{ inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 10, outputTokens: 5 }`
- **AND** serializing with the OpenAI adapter yields `prompt_tokens: 110`, `prompt_tokens_details.cached_tokens: 80`, `completion_tokens: 5`

#### Scenario: OpenAI cached tokens are subtracted to get uncached input

- **WHEN** an OpenAI response reports `prompt_tokens: 100`, `prompt_tokens_details.cached_tokens: 80`, `completion_tokens: 5`
- **THEN** the IR usage is `{ inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 }`
- **AND** serializing back with the OpenAI adapter restores `prompt_tokens: 100` and `cached_tokens: 80`

#### Scenario: Missing usage stays undefined, not zero

- **WHEN** a response carries no usage object
- **THEN** the IR `usage` is `undefined`
- **AND** translation does not fabricate zero-valued token counts

### Requirement: Streaming translation reassembles text, tool JSON, stop reason, and usage across the lifecycle

The system SHALL parse an upstream SSE byte stream in either protocol into an ordered `NormalizedStreamEvent` sequence (`message_start`, `text_delta`, `tool_use_start`, `tool_use_delta`, `block_stop`, `message_delta`, `message_stop`, `error`) and serialize that sequence into the client protocol's SSE frames. Text deltas SHALL be concatenated in order; tool-call argument JSON fragments SHALL be accumulated per canonical block index and finalized only at `block_stop`, which SHALL carry the finalized block as `finalizedToolUse` (the parsed-or-`inputParseError` `tool_use` variant) for a tool block. Because OpenAI and Anthropic disagree on when usage arrives, both `message_start` and `message_delta` SHALL carry a *partial* `NormalizedUsage`, merged **per component** (`inputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`outputTokens`) — Anthropic supplies input/cache up front and output at the delta, while OpenAI supplies the complete usage in its terminal chunk. When mapping OpenAI's separate text (`delta.content`) and `delta.tool_calls[].index` namespaces into the IR's single content-block index space, the parser SHALL allocate canonical indices in emission order (leading text is block 0, then tool_call index *i* → block `textBlockCount + i`). The parser SHALL tolerate SSE frames split across chunk boundaries and SHALL handle OpenAI's nominal final usage chunk whose `choices` array is empty (with `stream_options.include_usage`).

#### Scenario: Anthropic event stream serializes to OpenAI chunks with merged usage

- **WHEN** an Anthropic stream (`message_start` with input/cache usage → `content_block_delta` text → `message_delta` with output usage + `stop_reason` → `message_stop`) is parsed and serialized with the OpenAI adapter
- **THEN** the output is `chat.completion.chunk` frames whose concatenated `choices[].delta.content` equals the original text
- **AND** the finish-reason chunk carries the mapped `finish_reason`, followed by a final empty-`choices` chunk whose `usage` reflects the merged input/cache/output tokens

#### Scenario: OpenAI empty-choices usage chunk is parsed into usage

- **WHEN** an OpenAI stream ends with a finish-reason chunk and then a separate chunk with `choices: []` and a `usage` object
- **THEN** the parser emits a `message_delta`/`message_stop` carrying that usage (not a spurious empty text delta)
- **AND** an interrupted stream with no such chunk leaves usage partial/undefined rather than zero

#### Scenario: Streamed tool-call JSON is assembled per block

- **WHEN** a stream delivers a tool call whose `arguments` JSON arrives as several fragments across events
- **THEN** the fragments are accumulated per canonical block index and the `block_stop` event carries the finalized block as `finalizedToolUse` (a failed parse yields the `inputParseError` variant)
- **AND** the serialized target-protocol stream re-emits the fragments in that protocol's shape

#### Scenario: Parser tolerates split SSE frames

- **WHEN** the upstream byte stream splits a single `data:` line across two chunks
- **THEN** the parser buffers the partial line and emits the event only once the full frame is received
- **AND** no malformed event is emitted

### Requirement: Provider quirks are absorbed per adapter, not in the core

The system SHALL let each adapter accept an optional `quirks` option object for genuine deviations from the nominal protocol (e.g. a provider that omits `usage` entirely, or returns tool arguments already parsed) so real provider deviations are handled at the adapter boundary. Nominal behavior (including OpenAI's usage-in-final-empty-chunk) SHALL be handled in the core stream logic, not treated as a quirk. The core transform logic SHALL stay free of provider-specific conditionals. The default quirk set SHALL be empty.

#### Scenario: A quirk changes adapter behavior without touching the core

- **WHEN** an adapter is constructed with a quirk indicating the provider omits `usage`
- **THEN** that adapter tolerates the absence (leaving IR `usage` undefined) per the quirk
- **AND** the shared IR types and core transform functions are unchanged by the presence of the quirk

### Requirement: Golden-file contract suite proves canonical round-trip and cross-translation

The system SHALL ship a golden-file contract test suite (spec §6.3 definition of done) with committed fixtures per protocol across the matrix: plain, multi-turn tool round-trip, streamed, multimodal, and error (in-band stream `error` events and malformed/edge wire payloads — not HTTP transport errors, which are #6/#10). The suite SHALL assert **canonical round-trip equivalence** — `canon(…Out(…In(x)))` deep-equals `canon(x)`, where `canon` coerces content/system to block-array form and normalizes equivalent parameter encodings, and each fixture records which fields are canonicalized vs. intentionally dropped — and **cross-translation** correctness (OpenAI client ⟷ Anthropic upstream and vice-versa) for requests, responses, and streams. The suite SHALL run as `npm test -w packages/data-plane` and require no network, database, or live provider keys; fixture provenance (documented wire-format source/version) SHALL be recorded.

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

### Requirement: The translation module is pure and states the mid-stream commit boundary

The translation module SHALL perform no network requests, database access, or configuration reads — only in-memory transforms. It SHALL provide the streaming parse/serialize primitives on which the proxy's mid-stream commit policy (spec §6.3, §7.4, invariant 3) is built, and document that boundary, but SHALL NOT itself implement commit-to-stream or fallback logic (those are #10/#12).

#### Scenario: Translation makes no I/O

- **WHEN** any translation function (request/response/stream, either direction) runs
- **THEN** it performs no network, filesystem (outside test fixtures), or database access
- **AND** its output depends only on its input

#### Scenario: First stream event is inspectable before commit

- **WHEN** the proxy (a downstream consumer) parses an upstream stream through this module
- **THEN** it can observe the first `NormalizedStreamEvent` (e.g. `message_start` or the first `text_delta`) before deciding to commit the client stream
- **AND** the module itself neither commits nor swaps models
