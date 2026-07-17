# Design: fix-translation-stream-fidelity

## Context

Streaming defects in `packages/data-plane/src/proxy/translate/` (line numbers current):

- **`anthropic.ts` `streamSerialize` (~561-576)** emits `delta.stop_reason: null` when the IR
  `message_delta` has no `stopReason`, and `usage` only when `outputTokens !== undefined` — one wire
  `message_delta` per IR event. An OpenAI upstream produces a `message_delta` with `stopReason` (finish
  chunk) then a separate usage-only `message_delta` (empty-choices terminal chunk), so the second
  clobbers `stop_reason` to null and the first carries no usage.
- **`openai.ts` `streamParse` (~379-474)** breaks on `[DONE]` (`:396`), reads `chunk.choices.length`
  (`:410`) on **every** parsed frame (an `{ error }` frame → `TypeError`), and yields `message_stop`
  unconditionally after the loop (`:473`) — neither `[DONE]` nor `finish_reason` (`:452`) is tracked.
- **`anthropic.ts` `streamParse` (~386-474)** ends when the source exhausts with no fabricated
  `message_stop`, but never checks whether `message_stop` was seen; a `content_block_start` of an
  unknown type falls to the text branch (`:422`), and a non-`text_delta` `content_block_delta` is
  treated as a tool-JSON delta (`:430`) — so a `thinking_delta` yields `tool_use_delta` with
  `partialJson: undefined`, which crashes core (`.length` on undefined).
- **`antBlockToIr` (~90-120)** switches over the 4-member `AntContentBlock` with no `default`.
- **`partsToBlocks` (openai.ts ~56-77)** else-branch destructures `part.image_url` for any non-text part.

Constraints: purity (invariant 2 — no IO/`Date`/random); the mid-stream commit boundary (invariant 3)
lives in `core.ts` and must not move. Verified in the round-1 review: an OpenAI upstream yields the
`stopReason`-then-usage IR sequence; a trailing normalized `error` after committed text already becomes
a sanitized terminal frame + `status=error` (core.ts) with no swap; buffering the tail does not alter
the commit boundary (`message_delta` already precedes `message_stop`; cascade replay already emits one
terminal delta + stop).

## Goals / Non-Goals

**Goals:** conformant Anthropic streamed output; exact streamed OpenAI usage; truncation surfaced as an
error on both parsers; unknown blocks/parts/deltas degrade without throwing or corrupting the stream;
in-band OpenAI error frames become normalized error events; golden coverage of the serializer + errors.

**Non-Goals:** the stream_options suppression quirk; A-6/A-7/A-9 backlog; any request-side or
usage-formula change.

## Decisions

1. **`streamSerialize` buffers the tail and emits one conformant `message_delta` (E2.1, review
   finding 4).** Keep emitting `message_start` / content frames immediately (commit boundary
   untouched). Across `message_start` + every `message_delta`, accumulate `PartialUsage` (via
   `mergePartialUsage`) and capture the last-seen `stopReason`/`rawStopReason`/`stopSequence`; do NOT
   emit a wire `message_delta` inline. On `message_stop`:
   - if a stop reason was seen → emit one `event: message_delta` with
     `delta.stop_reason = stopReasonToAnthropic(seen, raw)` (non-null) and
     `usage: { output_tokens: accumulated ?? 0 }`, then `event: message_stop`;
   - if **no** stop reason was ever seen (anomalous — a well-formed stream always carries one, and E2.7
     turns a truncated one into an `error` before `message_stop`) → emit an `event: error`
     (`type: 'incomplete'`) instead of a fabricated `end_turn`.
   The IR/recording usage stays `undefined` when unknown; the wire `0` is a wire-only concession that
   satisfies the Anthropic SDK's required field.

2. **Truncation → error on BOTH parsers (E2.7, review finding 2).**
   - `openai.streamParse`: track `sawTerminator` — set on `[DONE]` (`:396`) and on any non-null
     `finish_reason` (`:452`). After the loop, if `!sawTerminator`, yield
     `{ type: 'error', error: { type: 'truncated', message: 'upstream stream ended without a
     terminator' } }` instead of `message_stop`.
   - `anthropic.streamParse`: track `sawMessageStop` (set in the `message_stop` case). After the loop,
     if `!sawMessageStop`, yield the same normalized `error` (mandatory — Anthropic exhaustion is
     otherwise a silent clean end).
   - Core turns a post-commit `error` into a terminal error frame + `status=error`; a pre-commit one is
     a clean protocol error. No commit-boundary change.

3. **In-band OpenAI error frame → normalized error (E2.6, review finding 5).** In `openai.streamParse`,
   after JSON-parsing a frame, detect an error shape (`typeof chunk === 'object' && chunk.error != null`)
   **before** touching `chunk.choices`, and yield `{ type: 'error', error: { type: <string>, message:
   <string> } }` (sanitized — a fixed shape, never the raw provider body downstream; core re-sanitizes
   the client-facing frame). This makes the in-band error fixture assertable end to end and removes the
   `TypeError`.

4. **Unknown blocks/parts/deltas skip, never throw or corrupt (E2.8, review finding 3).**
   - `anthropic.streamParse` `content_block_start`: recognize `text` and `tool_use`; for any other
     type, record the index as **skipped** (a small `Set<number>`) and open no block. `content_block_delta`
     and `content_block_stop`: if the index is skipped (or a delta type is neither `text_delta` nor
     `input_json_delta`), ignore it — never yield a `tool_use_delta` with `undefined` JSON.
   - `antBlockToIr`: accept `unknown`, use structural type guards (`block.type === 'text'` etc.),
     `default → null`; callers (`antContentToBlocks`, `responseIn` content map, the requestIn split)
     filter `null`. Unknown response blocks (`thinking`, `server_tool_use`, …) are skipped.
   - `partsToBlocks`: handle `part.type === 'text'` and `=== 'image_url'`; skip any other part type
     (no `part.image_url` destructure).
   - All paths stay total and non-throwing, matching the malformed-tool principle.

5. **Outbound usage opt-in, unconditional (E2.2, review finding 7).** `openai.requestOut`:
   `...(ir.stream === true ? { stream_options: { include_usage: true } } : {})`. `canon` already drops
   `stream_options`. No quirk (OpenAI-compatible servers ignore unknown request fields); a suppression
   quirk is a documented follow-up if a real incompatibility surfaces.

6. **Golden + e2e coverage (E2.6).** New tests: cross-stream `oai.streamParse → ant.streamSerialize`
   asserting exactly one `message_delta` before `message_stop` with numeric `usage.output_tokens` and a
   non-null `stop_reason`; an in-band `error` fixture per protocol through `streamParse`; an Anthropic
   malformed streamed `tool_use` (non-JSON args finalizing as `inputParseError`); a truncated stream
   (no `[DONE]`) asserting an `error` event, not `message_stop`; a streamed `/v1/messages` e2e (happy
   path, 401, mid-stream error in the Anthropic envelope). Correct the golden `README.md`.

## Risks / Trade-offs

- [Buffering the final `message_delta` until `message_stop`] → no client-visible latency change (that is
  the wire ordering); content frames still stream immediately; the commit boundary (first successful
  event) is untouched.
- [The `error`-on-truncation could fire for a legitimately-terminatorless provider] → OpenAI always
  sends `[DONE]` or a `finish_reason`; Anthropic always sends `message_stop`. A stream lacking both is
  genuinely truncated, which is exactly what should record as an error. The stub-upstream tests pin the
  normal-terminator path stays a clean stop.
- [Broadening `antBlockToIr` to `unknown` loses compile-time exhaustiveness] → the `default` case
  restores runtime totality (the goal); a newly-*modeled* block type still gets an explicit case.
- [Skipping an unknown streaming block silently] → correct per the never-throw principle; the block was
  unrepresentable in the IR anyway. If cross-protocol fidelity for `thinking` is ever wanted, that is a
  modeled-IR change (its own proposal), not a stream-corruption fix.

## Migration Plan

No schema/data. Behavior changes are correctness (conformant streams, exact usage, truncation errors,
no crashes) — documented in a changeset. Rollback = revert.

## Open Questions

None blocking.
