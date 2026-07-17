# Proposal: fix-translation-stream-fidelity

Implements the **streaming-side** half of **FABLE_AUDIT.md Epic E2** (protocol translation fidelity — a
P0 audit epic). The request-side half shipped as `fix-translation-request-fidelity`; the epic was split
along this line on the audit's and the proposal review's recommendation.
**Spec refs:** spec.md §6.3, §7.7, §15; `openspec/specs/protocol-translation`; CLAUDE.md invariants 2, 3.

## Why

The streamed surface is where the translate module is weakest — most of it is untested, and several
defects corrupt real client streams or the cost record:

1. **The Anthropic client-facing stream serializer is protocol-non-conformant (E2.1).**
   `streamSerialize` emits a wire `message_delta` per IR `message_delta`: `stop_reason: null` when the
   IR event has no `stopReason` (the OpenAI terminal usage-only delta), which **clobbers an
   already-delivered stop reason**, and `usage` only when `outputTokens` is defined (so an
   OpenAI-upstream cross-stream carries no usage). Anthropic SDKs validate `message_delta` (Python
   raises; the TS accumulator reads `usage.output_tokens` unguarded), so streamed `/v1/messages`
   cross-protocol responses crash the client at end-of-turn.
2. **Streamed OpenAI usage is never requested (E2.2).** `requestOut` never sets
   `stream_options: { include_usage: true }`, so the terminal usage chunk never arrives and **every**
   streamed request against real OpenAI records `usage_estimated=true` (chars/4) when exact counts were
   available.
3. **A truncated upstream stream is laundered into success (E2.7).** `openai.streamParse` yields
   `message_stop` unconditionally after the chunk loop (whether `[DONE]`/a finish chunk was seen or the
   source merely exhausted), and `anthropic.streamParse` ends on exhaustion regardless of whether it
   saw `message_stop` — core then records a truncated answer as `status=success`.
4. **Unknown content blocks/parts throw or corrupt the stream (E2.8).** An Anthropic `thinking`
   streaming block is treated as text and its `thinking_delta` as a tool-JSON delta, yielding a
   `tool_use_delta` with `partialJson: undefined` that crashes core (`.length` on undefined); a
   non-streaming `thinking`/`server_tool_use` block becomes `undefined` in the IR and explodes later; an
   OpenAI `input_audio`/`file` request part throws in `partsToBlocks`. This contradicts the module's
   never-throw-on-model-output principle.
5. **The stream serializer and in-band error events are entirely untested (E2.6).** No golden/cross
   coverage of `ant.streamSerialize`, no in-band `error` stream fixture (despite the README claiming
   it), no streamed `/v1/messages` e2e — the blind spot that let E2.1 ship.

## What Changes

- **Conformant serializer (E2.1):** `anthropic.streamSerialize` accumulates partial usage (via
  `mergePartialUsage`) and buffers the stop info across `message_start` + all `message_delta` events,
  and emits exactly one `message_delta` immediately before `message_stop` — `usage.output_tokens` a
  number (best-known or wire-0), `stop_reason` the buffered non-null reason. If `message_stop` is
  reached with **no** stop reason ever seen (anomalous), it emits an `error` (incomplete) rather than
  fabricating `end_turn` (review finding 4). The IR/recording side keeps usage `undefined` when
  unknown (wire-0 is a wire-only concession).
- **Outbound usage (E2.2):** `openai.requestOut` sets `stream_options: { include_usage: true }` when
  `ir.stream === true`, unconditionally (OpenAI-compatible servers ignore unknown fields; `canon`
  already drops the key so golden round-trips stay green).
- **Truncation → error (E2.7):** `openai.streamParse` tracks `sawTerminator` (`[DONE]` or a non-null
  `finish_reason`) and, on exhaustion without it, yields a normalized `error` (`truncated`) instead of
  `message_stop`. `anthropic.streamParse` tracks `sawMessageStop` and does the same — **mandatory**,
  not conditional (review finding 2). Core's existing error-event handling emits the terminal error
  frame and records `status=error`.
- **Never throw / never corrupt on unknown output (E2.8):** `anthropic.streamParse` skips unknown
  `content_block_start` types and ignores deltas for skipped indices (so `thinking_delta` &co. can't
  reach core as malformed events); `antBlockToIr` gets a total, structurally-guarded form that skips
  unknown response blocks; `partsToBlocks` skips unknown request parts. `openai.streamParse` detects an
  in-band `{ error }` frame **before** reading `choices` and yields a normalized `error` event (review
  finding 5), instead of a `TypeError`.
- **Golden + e2e coverage (E2.6):** cross-stream `oai.streamParse → ant.streamSerialize` frame
  assertions; an in-band `error` fixture per protocol carried through parsing; an Anthropic malformed
  streamed `tool_use`; a streamed `/v1/messages` e2e (happy path asserting conformant frames, a 401 in
  the Anthropic envelope, and a mid-stream error in the Anthropic terminal shape). Correct the golden
  `README.md` error-coverage claim.

## Capabilities

### New Capabilities

*None.*

### Modified Capabilities

- `protocol-translation`: streaming translation requests and emits conformant usage, never fabricates a
  terminator on truncation, and degrades on unknown blocks/parts/deltas without throwing or corrupting
  the stream; the golden suite covers the Anthropic stream serializer and in-band error events.

## Impact

- **Modified (production):** `translate/openai.ts` (`streamParse` truncation + error-frame detection,
  `requestOut` `stream_options`, `partsToBlocks` unknown-part skip), `translate/anthropic.ts`
  (`streamSerialize` accumulate/emit-once, `streamParse` truncation + unknown-block skip, `antBlockToIr`
  total form).
- **Modified/new (tests):** `stream.spec.ts`, `cross-translation.spec.ts`, new golden fixtures (in-band
  error per protocol; Anthropic malformed streamed tool_use); a streamed `/v1/messages` e2e in
  `packages/control-plane/test/proxy/`; golden `README.md` correction.
- **Purity preserved (invariant 2):** no IO/`Date`/random; `purity.spec` stays green. **Commit boundary
  (invariant 3):** unchanged — the serializer buffers only the tail (`message_delta` already precedes
  `message_stop`); a post-commit truncation/error becomes a terminal error frame, never a model swap.
- **Schema/migration:** none. **Changeset:** required (user-facing: streamed `/v1/messages` conforms to
  Anthropic SDKs; streamed OpenAI cost becomes exact; truncation now errors; unknown blocks no longer
  crash).
- **Dependencies:** none.

## Non-goals

- **The stream_options legacy-server suppression quirk** — added unconditionally; OpenAI-compatible
  servers ignore unknown fields per the OpenAI contract. If a real incompatibility surfaces, a quirk is
  a follow-up (review finding 7).
- **A-6 (duplicate `tool_use_start` on repeated id/name), A-7 (uninvited trailing usage chunk to OpenAI
  clients), A-9 (`message_start` `input_tokens: 0` cross-protocol)** — backlog items.
- No change to the uncached-usage formulas, stop-reason mapping, tool grouping, the mid-stream commit
  boundary, or any request-side behavior (that was the companion change).
