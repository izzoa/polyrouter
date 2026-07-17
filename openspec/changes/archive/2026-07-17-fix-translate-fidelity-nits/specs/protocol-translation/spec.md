## MODIFIED Requirements

### Requirement: Streaming translation reassembles text, tool JSON, stop reason, and usage across the lifecycle

The system SHALL parse an upstream SSE byte stream in either protocol into an ordered `NormalizedStreamEvent` sequence (`message_start`, `text_delta`, `tool_use_start`, `tool_use_delta`, `block_stop`, `message_delta`, `message_stop`, `error`) and serialize that sequence into the client protocol's SSE frames. Text deltas SHALL be concatenated in order; tool-call argument JSON fragments SHALL be accumulated per canonical block index and finalized only at `block_stop`, which SHALL carry the finalized block as `finalizedToolUse` (the parsed-or-`inputParseError` `tool_use` variant) for a tool block. `tool_use_start` SHALL be emitted **at most once per canonical block** — the first fragment carrying an id/name opens it; a provider that repeats the `id`/`name` on later argument fragments updates the block's id/name without re-opening it (no duplicate `tool_use_start`). Because OpenAI and Anthropic disagree on when usage arrives, both `message_start` and `message_delta` SHALL carry a *partial* `NormalizedUsage`, merged **per component** (`inputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`outputTokens`) — Anthropic supplies input/cache up front and output at the delta, while OpenAI supplies the complete usage in its terminal chunk. When mapping OpenAI's separate text (`delta.content`) and `delta.tool_calls[].index` namespaces into the IR's single content-block index space, the parser SHALL allocate canonical indices in emission order (leading text is block 0, then tool_call index *i* → block `textBlockCount + i`). The parser SHALL tolerate SSE frames split across chunk boundaries and SHALL handle OpenAI's nominal final usage chunk whose `choices` array is empty (with `stream_options.include_usage`). On the **serialize** side, the OpenAI adapter SHALL relay the terminal `choices:[]` usage chunk to the client ONLY when the client opted in via `stream_options.include_usage` — matching OpenAI, which omits it otherwise; the proxy still requests usage from the upstream for cost recording regardless (the two are independent).

#### Scenario: Anthropic event stream serializes to OpenAI chunks with merged usage

- **WHEN** an Anthropic stream (`message_start` with input/cache usage → `content_block_delta` text → `message_delta` with output usage + `stop_reason` → `message_stop`) is parsed and serialized with the OpenAI adapter, with the client having opted into `include_usage`
- **THEN** the output is `chat.completion.chunk` frames whose concatenated `choices[].delta.content` equals the original text
- **AND** the finish-reason chunk carries the mapped `finish_reason`, followed by a final empty-`choices` chunk whose `usage` reflects the merged input/cache/output tokens

#### Scenario: OpenAI empty-choices usage chunk is parsed into usage

- **WHEN** an OpenAI stream ends with a finish-reason chunk and then a separate chunk with `choices: []` and a `usage` object
- **THEN** the parser emits a `message_delta`/`message_stop` carrying that usage (not a spurious empty text delta)
- **AND** an interrupted stream with no such chunk leaves usage partial/undefined rather than zero

#### Scenario: A repeated tool-call id/name fragment does not re-open the block

- **WHEN** a stream delivers a tool call whose first fragment carries `id`+`name` and a later argument fragment repeats the `id`/`name`
- **THEN** exactly one `tool_use_start` is emitted for that block, and the later fragment contributes only its argument JSON

#### Scenario: The terminal usage chunk is relayed only on client opt-in

- **WHEN** an OpenAI stream is serialized for a client that did NOT set `stream_options.include_usage`
- **THEN** no trailing `choices:[]` usage chunk is emitted (only the content + finish-reason chunks and `[DONE]`), matching OpenAI; and a client that DID opt in receives the terminal usage chunk

#### Scenario: Streamed tool-call JSON is assembled per block

- **WHEN** a stream delivers a tool call whose `arguments` JSON arrives as several fragments across events
- **THEN** the fragments are accumulated per canonical block index and the `block_stop` event carries the finalized block as `finalizedToolUse` (a failed parse yields the `inputParseError` variant)
- **AND** the serialized target-protocol stream re-emits the fragments in that protocol's shape

#### Scenario: Parser tolerates split SSE frames

- **WHEN** the upstream byte stream splits a single `data:` line across two chunks
- **THEN** the parser buffers the partial line and emits the event only once the full frame is received
- **AND** no malformed event is emitted

### Requirement: Tool-call round-trips survive multi-turn, parallel calls, and trailing text

The system SHALL correctly translate a full tool-use conversation in both directions. An assistant turn with one or more `tool_use` blocks (parallel calls) SHALL preserve every call with its `id`, `name`, and parsed `input`, in order. Each tool result SHALL be carried as its own `role:"tool"` message holding exactly one `tool_result` block keyed by `toolUseId`. The OpenAI adapter SHALL map one `role:"tool"` message ⟷ one OpenAI tool message per `tool_call_id`. The Anthropic adapter SHALL group a run of consecutive `role:"tool"` messages into a single `user` message with the `tool_result` blocks first, appending any immediately-following `role:"user"` message's blocks as trailing content of that same user message; on the way in it SHALL split an Anthropic `user` message of `[tool_result…][text/image…]` back into the ordered `role:"tool"` messages plus a following `role:"user"` message for the trailing blocks. Because the Anthropic wire requires `tool_result` blocks to LEAD a user turn, a **non-conformant** input turn that places user content before a `tool_result` SHALL be normalized to the conformant shape — the `tool_result` messages come first and the user text trails — rather than preserved literally (which would emit invalid consecutive user turns / a `user`-before-`tool` OpenAI sequence). This is a deliberate, valid normalization (A-8 reviewed).

#### Scenario: Parallel tool calls in one assistant turn are preserved

- **WHEN** an assistant response with two `tool_use` blocks (e.g. `get_weather` and `get_time`) is normalized and re-serialized in the same protocol
- **THEN** both tool calls are present with their original `id`, `name`, and parsed `input`
- **AND** their order is preserved

#### Scenario: Anthropic groups tool results and trailing text into one user message

- **WHEN** an IR conversation with two consecutive `role:"tool"` messages (results for two parallel calls, one an error result) followed by a `role:"user"` text message is serialized with the Anthropic adapter
- **THEN** both `tool_result` blocks (one with `is_error: true`) appear first inside a single `user` message, followed by the text block
- **AND** serializing the same IR with the OpenAI adapter yields two separate `role:"tool"` messages (one per `tool_call_id`) plus a separate `role:"user"` text message

#### Scenario: A non-conformant user turn is normalized to the conformant tool_result-first shape

- **WHEN** an Anthropic `user` message places text before a `tool_result` (`[text, tool_result]`, which is non-conformant since Anthropic requires tool_result first)
- **THEN** it is normalized so the `role:"tool"` result message precedes the trailing `role:"user"` text (valid output on serialize-back), with each `tool_result` still its own `role:"tool"` message (1:1 with OpenAI)

#### Scenario: Full multi-turn tool round-trip cross-translates without loss

- **WHEN** an OpenAI multi-turn tool conversation (assistant tool_calls → tool results → assistant final answer) is normalized and serialized with the Anthropic adapter, then normalized again and serialized back with the OpenAI adapter
- **THEN** the final OpenAI conversation is canonically equivalent to the original (same tool call ids linked to the same results, same message order, same parsed inputs)
