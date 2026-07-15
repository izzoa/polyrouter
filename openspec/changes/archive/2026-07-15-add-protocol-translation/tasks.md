# Tasks: add-protocol-translation

> Build order: IR types → per-protocol request/response adapters (with their golden tests) → streaming (with its golden tests) → quirks → facade + purity guard. Tests land in the same group as the code they cover (contract-suite rule).

## 1. Module scaffold & IR types

- [x] 1.1 Create `packages/data-plane/src/proxy/translate/` with an `index.ts` barrel; wire it under the existing (empty) data-plane module structure without adding HTTP/DI (pure module, no NestJS provider yet).
- [x] 1.2 Define the `Normalized*` IR in `translate/ir.ts` (strict TS, no `any`): `NormalizedRequest` (top-level `system?: Block[]`, `messages`, `tools?`, `toolChoice?: NormalizedToolChoice`, `allowParallelTools?: boolean`, params `maxOutputTokens?`/`temperature?`/`topP?`/`stopSequences?`); `NormalizedMessage` (`role: 'user'|'assistant'|'tool'`, `content: Block[]`); the `Block` union — `text`; `image` as `{ data, mediaType, detail? } | { url, detail? }` (`detail?: 'auto'|'low'|'high'`); `tool_use` as `{ id, name, input: object } | { id, name, inputRaw: string, inputParseError: true }`; `tool_result` as `{ toolUseId, content: Block[], isError? }` (exactly one per `role:'tool'` message); `NormalizedResponse` (`id`, `model`, `created?` /* optional — OpenAI-only */, `content`, `stopReason`, `rawStopReason?`, `stopSequence?`, `usage?`); `NormalizedStopReason = 'stop'|'length'|'tool_use'|'content_filter'|'pause'|'error'|'other'`; `NormalizedToolChoice = 'auto'|'none'|'required'|{ toolName: string }`; `NormalizedUsage { inputTokens /* uncached */, outputTokens, cacheReadTokens?, cacheWriteTokens? }`; and the `NormalizedStreamEvent` union (`message_start` incl. optional partial usage, `text_delta`, `tool_use_start`, `tool_use_delta`, `block_stop` incl. `finalizedToolUse?`, `message_delta` incl. **partial/cumulative** usage + stopReason, `message_stop`, `error`). Document the single-choice (`n=1`) contract and the per-component usage merge.
- [x] 1.3 Define the adapter contract in `translate/adapter.ts`: an interface with `requestIn`/`requestOut`, `responseIn`/`responseOut`, `streamParse`/`streamSerialize`, plus a `quirks` option type. Document that adapters are pure and the core is protocol-agnostic.
- [x] 1.4 Add the protocol wire types at adapter boundaries in `translate/wire/{openai,anthropic}.ts` (request/response/chunk shapes, incl. `tool_choice`/`parallel_tool_calls`/`disable_parallel_tool_use`, `image_url.detail`, usage detail objects) so adapters aren't typed against `any`.
- [x] 1.5 Add `translate/canon.ts` — the canonicalizer used by the round-trip contract: coerce `content`/`system` to block-array form, normalize equivalent parameter encodings (`max_tokens`⟷`max_completion_tokens`), and expose the per-fixture canonicalized/dropped field convention.

## 2. Usage & stop-reason mapping (+ unit tests)

- [x] 2.1 Implement `translate/usage.ts`: uncached-component conversion both ways (Anthropic components ⟷ IR; OpenAI `prompt_tokens − cached_tokens` in / `inputTokens + cacheRead + cacheWrite` out), missing usage → `undefined`. Unit tests with numeric cases: cache-read only, cache-write only, mixed read+write+fresh, none.
- [x] 2.2 Implement `translate/stop-reason.ts`: canonical mapping both ways with `rawStopReason` passthrough, `stopSequence` preservation, `refusal`→`content_filter`, `pause_turn`→`pause`, unknown→`other`. Unit tests for each mapping and the unknown-degrades-not-throws case.

## 3. OpenAI adapter — request & response (+ golden tests)

- [x] 3.1 Implement `translate/openai.ts` `requestIn`/`requestOut`: system message ⟷ IR `system`; messages/content blocks; tool/function defs; `tool_choice` (`none`/`auto`/`required`/specific) + `parallel_tool_calls` ⟷ IR `toolChoice`/`allowParallelTools`; params. Tool `arguments` string ⟷ parsed IR `input`, with the `inputParseError` variant on invalid JSON (never throw).
- [x] 3.2 Implement OpenAI `responseIn`/`responseOut`: `id`/`model`/`created` envelope; assistant content + `tool_calls`; `finish_reason` via `stop-reason.ts`; usage via `usage.ts` (`cached_tokens` handling). `responseOut` accepts an optional pure serialization context `{ created?: number }`; absent both IR `created` and context → `created: 0` placeholder (never a clock read).
- [x] 3.3 Implement the `role:"tool"` mapping (one OpenAI tool message per `tool_call_id` ⟷ one IR `role:"tool"` message of a single `tool_result` block) and multimodal `image_url` (`data:`→`{ data, mediaType, detail? }`, remote→`{ url, detail? }`, no fetch).
- [x] 3.4 Author committed fixtures `test/golden/openai/{plain,tools-multiturn,multimodal,malformed-tool,error}.json` and a Jest suite asserting request/response **canonical round-trip** (`canon(…Out(…In(x)))` deep-equals `canon(x)`), incl. the malformed-tool-JSON case.

## 4. Anthropic adapter — request & response (+ golden tests)

- [x] 4.1 Implement `translate/anthropic.ts` `requestIn`/`requestOut`: top-level `system` ⟷ IR `system`; messages/content blocks; `tools` with `input_schema`; `tool_choice.type` (`auto`/`any`/`tool`/`none`) + `disable_parallel_tool_use` ⟷ IR `toolChoice`/`allowParallelTools`; params (`max_tokens`, temperature, top_p, stop_sequences). `requestOut` resolves required `max_tokens` from IR `maxOutputTokens` or a `defaultMaxOutputTokens` adapter option; with neither, return a structured serialization error (no invalid outbound request).
- [x] 4.2 Implement Anthropic `responseIn`/`responseOut`: `id`/`model` envelope; content blocks (text + `tool_use`, incl. `inputParseError` variant); `stop_reason`/`stop_sequence` via `stop-reason.ts`; usage components via `usage.ts`.
- [x] 4.3 Implement the tool-result **grouping/splitting with trailing text**: serialize a run of consecutive IR `role:"tool"` messages into one `user` message (`tool_result` blocks first), appending an immediately-following `role:"user"` message's blocks as trailing content (`requestOut`); split an Anthropic `user` message of `[tool_result…][text/image…]` back into ordered `role:"tool"` messages plus a following `role:"user"` message (`requestIn`). Preserve parallel `tool_use` order and `is_error`. Multimodal `source` (`base64`/`url`) ⟷ IR `image` (`detail` preserved through IR, omitted on Anthropic out).
- [x] 4.4 Author committed fixtures `test/golden/anthropic/{plain,tools-multiturn,multimodal,malformed-tool,error}.json` (tools case includes two parallel results, one an error result, and trailing user text) and extend the suite with Anthropic **canonical round-trip**.

## 5. Cross-translation contract tests

- [x] 5.1 Add request cross-translation cases: OpenAI → IR → Anthropic (system relocated, tools + `tool_choice`/parallel mapped, multi-turn tool round-trip + trailing text intact) and the reverse, each deep-equal against a committed golden expectation. Include the no-token-limit → `defaultMaxOutputTokens` case and the image `detail`-dropped-across-Anthropic-wire case (documented dropped field).
- [x] 5.2 Add response cross-translation cases (content, stop reason + `stopSequence`, usage incl. cache components) both directions, incl. the numeric usage matrix (hit/write/mixed/none) and an Anthropic→OpenAI case exercising the `{ created }` serialization context (and the `created: 0` placeholder when absent).
- [x] 5.3 Add the full multi-turn/parallel tool round-trip case (OpenAI → Anthropic → OpenAI **canonically equivalent**) as its own golden fixture.

## 6. Streaming translation (+ golden tests)

- [x] 6.1 Implement `translate/stream.ts` SSE line parsing: a chunk-boundary-tolerant line buffer feeding a protocol `streamParse` (async generator) yielding `NormalizedStreamEvent`s. Allocate canonical block indices for mixed text+tool streams (leading text = block 0, OpenAI tool_call index *i* → block `textBlockCount + i`); accumulate tool-call JSON per canonical index and emit `finalizedToolUse` on `block_stop` (`inputParseError` on failure); model the usage lifecycle with **per-component merge** of partial usage on `message_start` and `message_delta`; tolerate OpenAI's empty-`choices` final usage chunk (complete usage arrives there).
- [x] 6.2 Implement OpenAI `streamParse`/`streamSerialize` (`chat.completion.chunk` deltas ⟷ events; emit finish-reason chunk then empty-`choices` usage chunk on serialize).
- [x] 6.3 Implement Anthropic `streamParse`/`streamSerialize` (`message_start`/`content_block_*`/`message_delta`/`message_stop` ⟷ events; input/cache usage at start, output at delta).
- [x] 6.4 Author committed streamed fixtures `test/golden/{openai,anthropic}/streamed.json` (incl. split-frame, tool-JSON-in-fragments, malformed-tool-JSON, interrupted-no-terminal-usage, and cache-tokens-in-stream cases) and a suite asserting: parse→serialize round-trip per protocol, cross-translation streams (concatenated text, assembled tool JSON, mapped stop reason, merged usage), split-frame tolerance, and the empty-`choices` usage chunk.

## 7. Quirks, facade, purity

- [x] 7.1 Wire the per-adapter `quirks` option through both adapters for genuine deviations (e.g. usage-omitted, tool-arguments-already-object); default empty. Add a test proving a quirk changes adapter behavior with the core/IR unchanged. (OpenAI usage-in-final-empty-chunk is nominal core behavior, not a quirk.)
- [x] 7.2 Add a small facade (`translate/index.ts`) exposing `getAdapter(protocol)` / the two adapters and the IR types as the module's public surface; nothing else re-exports normalized shapes.
- [x] 7.3 Add a purity guard test (no network/db imports in `translate/`) and a `test/golden/README.md` noting fixtures are hand-authored to documented wire formats (with provenance/version) and refreshing from sanitized live captures is a follow-up.

## 8. Definition of done

- [x] 8.1 `npm test -w packages/data-plane` green (canonical round-trip + cross-translation + streaming lifecycle + usage matrix + malformed-JSON + quirk + purity); `npm run build` passes; lint clean; strict TS, no `any` escapes.
- [x] 8.2 Add a changeset (`@polyrouter/data-plane` minor) describing the translation module + golden contract suite.
- [x] 8.3 Confirm no proxy/HTTP/routing/network was added (non-goals hold; `n>1` documented as out of scope); update spec/deltas as needed and leave the change archive-ready.
