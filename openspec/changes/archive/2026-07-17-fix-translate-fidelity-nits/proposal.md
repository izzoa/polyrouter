## Why

Four protocol-translation fidelity nits (FABLE_AUDIT A-6/A-7/A-8/A-9) — the IR core is sound, but each
diverges subtly from the wire protocols (invariant 2):

- **A-6** The OpenAI stream parser recomputes `isStart = id||name` on EVERY tool-call fragment, so a
  provider that repeats `id`/`name` on later argument fragments emits a **duplicate `tool_use_start`**
  for the same block.
- **A-7** The proxy always requests `stream_options.include_usage` upstream (for exact cost), so the
  OpenAI serializer always relays the terminal `choices:[]` usage chunk — even to a client that did NOT
  set `include_usage`. OpenAI itself only sends it on opt-in, so a strict client sees an uninvited chunk.
- **A-8** In the Anthropic `requestIn`, a user turn of `[text, tool_result]` is reordered so the
  `tool_result` leads. On review this is CORRECT: `[text, tool_result]` is non-conformant Anthropic
  input (tool_result must lead a user turn), and preserving the literal order would emit invalid
  consecutive user turns on the way back out. Documented as a deliberate normalization.
- **A-9** The Anthropic serializer emits `usage.input_tokens: 0` on a cross-protocol `message_start`
  (OpenAI reports usage only terminally) — a structural placeholder that should be documented.

## What Changes

- **A-6** Track a per-block `started` flag; emit `tool_use_start` exactly once (the first fragment
  carrying id/name); later id/name repeats update the block without re-opening.
- **A-7** Thread the client's `include_usage` opt-in through the IR (`NormalizedRequest.includeUsage`) →
  the proxy → the `SerializationContext`; the OpenAI serializer relays the terminal usage chunk only when
  the client opted in. Cost recording still reads the upstream usage (the proxy keeps requesting it).
- **A-8** Reviewed — no code change. Document (spec + golden README) that a non-conformant
  `[text, tool_result]` turn is deliberately normalized to the conformant `[tool_result, text]` shape.
- **A-9** Document the `message_start` `input_tokens:0` cross-protocol placeholder in the golden README.

## Capabilities

### Modified Capabilities

- `protocol-translation`: streamed `tool_use_start` is emitted once per block; the OpenAI terminal usage
  chunk is relayed only on client opt-in; a non-conformant `[text, tool_result]` user turn is normalized to `[tool_result, text]` (reviewed correct).

## Impact

- **Code:** `translate/openai.ts` (tool_use_start dedup + usage-chunk gate + capture `include_usage`),
  `translate/anthropic.ts` (A-8: reviewed, no code change), `translate/ir.ts` + `translate/adapter.ts`
  (`includeUsage` fields), `proxy/core.ts` + `control-plane/proxy.service.ts` (thread it), golden README.
- **Tests:** stream specs — a repeated-id/name fragment emits one `tool_use_start`; the usage chunk is
  omitted without opt-in and relayed with it; the existing anthropic/cross-translation per-result + round-trip specs stay green (A-8 unchanged). Changeset:
  user-facing (OpenAI stream shape now matches the client's include_usage).
