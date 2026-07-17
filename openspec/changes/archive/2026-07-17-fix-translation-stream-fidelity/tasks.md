# Tasks: fix-translation-stream-fidelity

Base dir `T/` = `packages/data-plane/src/proxy/translate/`. Keep every change side-effect-free
(invariant 2 — `purity.spec` must stay green) and do NOT move the mid-stream commit boundary
(invariant 3, in `core.ts`).

## 1. Outbound streamed usage opt-in (E2.2)

- [x] 1.1 `T/openai.ts` `requestOut`: add `...(ir.stream === true ? { stream_options: { include_usage: true } } : {})` (unconditional; `canon` already drops `stream_options`)
- [x] 1.2 Unit test: `requestOut({...ir, stream:true})` has `stream_options.include_usage === true`, non-stream does not; existing golden round-trips stay green

## 2. Conformant Anthropic stream serializer (E2.1, review finding 4)

- [x] 2.1 `T/anthropic.ts` `streamSerialize` (~488-587): keep emitting `message_start`/content frames inline; across `message_start` + every `message_delta`, accumulate `PartialUsage` via `mergePartialUsage` and capture the last-seen `stopReason`/`rawStopReason`/`stopSequence`; STOP emitting a wire `message_delta` per IR event
- [x] 2.2 On `message_stop`: if a stop reason was seen, emit exactly one `event: message_delta` (`delta.stop_reason` = mapped non-null reason, `delta.stop_sequence` = buffered ?? null, `usage: { output_tokens: accumulated ?? 0 }`), then `event: message_stop`; if NO stop reason was ever seen, emit `event: error` (`{ type: 'incomplete', message: … }`) instead of fabricating `end_turn`
- [x] 2.3 Unit/cross-stream test in `stream.spec.ts`: `collect(ant.streamSerialize(fromArray(oai.streamParse(<openai text stream>))))` — assert exactly one `message_delta` before `message_stop`, `usage.output_tokens` is a number, `stop_reason` non-null; a tool stream likewise

## 3. Truncation → error on both parsers (E2.7, review finding 2)

- [x] 3.1 `T/openai.ts` `streamParse` (~379-474): track `sawTerminator` (set on `[DONE]` at ~396 and on any non-null `finish_reason` at ~452); after the loop, if `!sawTerminator` yield `{ type: 'error', error: { type: 'truncated', message: 'upstream stream ended without a terminator' } }` instead of `message_stop`
- [x] 3.2 `T/anthropic.ts` `streamParse` (~386-474): track `sawMessageStop` (set in the `message_stop` case); after the loop, if `!sawMessageStop` yield the same normalized `error` (mandatory)
- [x] 3.3 Unit tests: OpenAI chunks WITHOUT `[DONE]`/finish → `error` event, no `message_stop`; Anthropic events without `message_stop` → `error`; both normal-terminator streams still end with `message_stop`

## 4. Unknown blocks / parts / deltas degrade (E2.8, review finding 3)

- [x] 4.1 `T/anthropic.ts` `streamParse`: in `content_block_start`, recognize `text` and `tool_use`; any other type → record the index in a `skipped: Set<number>` and open no block. In `content_block_delta`/`content_block_stop`: if the index is skipped, or a delta type is neither `text_delta` nor `input_json_delta`, ignore it (never yield a `tool_use_delta` with undefined JSON)
- [x] 4.2 `T/anthropic.ts` `antBlockToIr`: accept a broader input, use structural guards, add `default → null`; update `antContentToBlocks`, `responseIn` content map, and the requestIn tool_result split to filter `null` (unknown response blocks skipped)
- [x] 4.3 `T/openai.ts` `partsToBlocks` (~56-77): handle `text` and `image_url`; skip any other part type (no `part.image_url` destructure)
- [x] 4.4 `T/openai.ts` `streamParse`: after JSON-parsing a frame, if it is an object with a non-null `error` and no usable `choices`, yield `{ type: 'error', error: { type, message } }` BEFORE reading `chunk.choices` (review finding 5)
- [x] 4.5 Unit tests: an Anthropic stream with a `thinking` block (start/`thinking_delta`/stop) + a text block → text streams, thinking skipped, no throw; `anthropicAdapter.responseIn` with a `thinking` block then `responseOut` completes without throwing; `openaiAdapter.requestIn` with an `input_audio` part does not throw; an OpenAI `{error}` frame → normalized `error` event (no TypeError)

## 5. Golden fixtures, README, and /v1/messages e2e (E2.6)

- [x] 5.1 Add an in-band `error` streamed fixture per protocol (a stream event whose type is `error`) and a test parsing it through `streamParse` → assert a normalized `error` event; drive one through core's terminal-frame handling in the existing e2e (`*miderror*` stub already exercises the mid-stream error)
- [x] 5.2 Add an Anthropic malformed streamed `tool_use` case (argument fragments that don't form valid JSON) → assert `block_stop.finalizedToolUse` is the `inputParseError` variant, no throw
- [x] 5.3 Add a streamed `/v1/messages` e2e in `packages/control-plane/test/proxy/inference-proxy.e2e-spec.ts`: happy-path stream (assert `message_start` → content deltas → exactly one `message_delta` with `usage.output_tokens` → `message_stop`), a 401 in the Anthropic error envelope, and a `*miderror*` mid-stream case asserting the Anthropic terminal error shape (`event: error`, no raw detail)
- [x] 5.4 Correct `T/golden/README.md` so its error-coverage description matches the shipped fixtures (in-band error events + malformed streamed tool call now covered)

## 6. Definition of done

- [x] 6.1 `npm run build`, `npm run lint`, `npm run typecheck` green; `npm test -w packages/data-plane` (with `REDIS_URL`) + `-w packages/control-plane` green; `npm run test:e2e -w packages/control-plane` green (reap stray jest workers + `redis-cli FLUSHALL` before a clean e2e run)
- [x] 6.2 `purity.spec` still passes; all existing golden round-trips + stream tests stay green; the new serializer-conformance, truncation, unknown-block, and error-frame tests pass
- [x] 6.3 Mid-stream commit boundary (invariant 3), uncached-usage formulas, stop-reason mapping, and tool grouping unchanged; a changeset added (`npx changeset`, minor); `openspec validate fix-translation-stream-fidelity --type change --strict --no-interactive` passes
