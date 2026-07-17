# Design: fix-translation-request-fidelity

## Context

Request-side defects in `packages/data-plane/src/proxy/translate/` (line numbers current):

- **IR (`ir.ts`)** has no `cacheControl`/`responseFormat`/`reasoning`; system is `readonly ContentBlock[]`.
- **`anthropic.ts:268-271`** builds `system` via `(ir.system as TextBlock[]).map(b=>b.text).join('')`
  (unsafe cast → string; no cache_control survives). **`:286`** copies `temperature` verbatim.
  `toolResultContentToAnt` fuses all-text nested content.
- **`openai.ts:112-114/123-128/228-230`** fuse multi-text blocks/system with `join('')`; **`:207-223`
  requestIn** never reads `response_format`/`n`/reasoning; **`:273-286` requestOut** never emits them.
- **Wire:** `OaiRequest` (`wire/openai.ts:43-57`) has `n`/`stream_options` (unused) but no
  `response_format`/`reasoning_effort`; `AntRequest`/`AntTextBlock`/`AntTool` have no `cache_control`
  or `thinking`.
- **`n`** is read nowhere; the inbound `requestIn` call is `proxy.service.ts:645` in `resolvePlan`,
  wrapped in `try/catch → badRequest('invalid request body')`.
- **canon (`canon.ts`)** filters only top-level keys; `n`/`stream_options` are already dropped;
  `response_format`/`reasoning_effort` are not (so, added to a fixture, they round-trip unchanged —
  which is what we want). `canonOpenaiContent`/`canonAntTextish` normalize string⟷parts/array, so
  de-fusion (string → parts) stays round-trip-equivalent (confirmed in review).

Constraint (invariant 2, `purity.spec`): no IO, no `Date`, no `Math.random`.

## Goals / Non-Goals

**Goals:** cache_control / response_format / reasoning preserved same-protocol and documented-dropped
cross-protocol; no silent multi-block fusion; temperature clamped cross-protocol; `n > 1` rejected.

**Non-Goals:** all streaming-side E2 work (companion change); a semantic cross-protocol reasoning map;
cache_control on images / nested tool-result content; fanning out `n > 1`.

## Decisions

1. **IR extension is opaque, and `reasoning` carries source-protocol provenance (review finding 1).**
   The IR is created from the *client* protocol (`requestIn`) but serialized to the *provider* protocol
   (`requestOut`), which may differ — so a plain `reasoning` payload could not tell "same-protocol
   emit" from "cross-protocol drop." Model it as a tagged union:
   ```ts
   type ReasoningControl =
     | { readonly protocol: 'openai'; readonly effort: unknown }      // reasoning_effort
     | { readonly protocol: 'anthropic'; readonly thinking: unknown }; // thinking
   ```
   `requestOut` emits `reasoning_effort` only when `ir.reasoning?.protocol === 'openai'` (OpenAI
   adapter) and `thinking` only when `=== 'anthropic'` (Anthropic adapter); otherwise it drops it.
   `cacheControl` (Anthropic-only) and `responseFormat` (OpenAI-only) need no tag — each is emitted by
   its owning adapter's `requestOut` and never by the other. `cacheControl` is
   `{ type: 'ephemeral' } | Readonly<Record<string, unknown>>` (opaque); `responseFormat` is `unknown`.
   Add optional fields to IR `TextBlock`/`ToolUseOk`/`ToolUseRaw`/`ToolResultBlock`/`NormalizedTool`
   (`cacheControl`) and `NormalizedRequest` (`responseFormat`, `reasoning`). Wire: add `cache_control?`
   to `AntTextBlock`/`AntToolUseBlock`/`AntToolResultBlock`/`AntTool`, `thinking?` to `AntRequest`;
   `response_format?`/`reasoning_effort?` to `OaiRequest`.
   - *Why opaque:* the router must not validate every provider's evolving structured-output/reasoning
     schema; faithful same-protocol passthrough is the requirement.

2. **De-fuse first, then attach cache_control (E2.3 before E2.4).**
   - Anthropic `requestOut` system: emit `AntTextBlock[]` (each carrying `cache_control` from the IR
     block's `cacheControl`) when the system has >1 block **or** any block has `cacheControl`; else a
     plain string. Non-text system blocks degrade to their text (or are skipped), never `undefined`.
   - OpenAI `blocksToContent` / system content: when there is >1 text block, emit an `OaiContentPart[]`
     text-parts array instead of `join('')`; a single text block stays a string. `toolResultText` and
     `blocksToText` (single-string sinks: tool-result *rendered* text, assistant response text) keep
     joining — OpenAI has no parts representation there and no cache_control lives on those sinks.
   - Review-confirmed: `canonOpenaiContent`/`canonAntTextish` make string⟷parts/array equivalent, so
     `canon(Out(In(x)))` deep-equals `canon(x)` for both single- and multi-block forms; both `requestIn`
     parsers already preserve N blocks. No canon change needed for the round-trip.
   - *Scope (review finding 6):* `cacheControl` lives on the IR text/tool_use/tool_result *block*,
     tools, and system text blocks — NOT on image blocks and NOT on nested tool-result content, so
     `toolResultContentToAnt`'s all-text fusion is fine (the marker is on the tool_result block itself).

3. **Clamp temperature cross-protocol (E2.9).** Anthropic `requestOut`:
   `temperature: Math.min(ir.params.temperature, 1)` (top_p already 0–1 both). Documented in the golden
   README; same-protocol Anthropic input is already in range.

4. **`n > 1` rejected before normalization (E2.10, review finding 8).** In `resolvePlan`, **before** the
   `requestIn` try/catch, when `protocol === 'openai'` and the raw body's `n` is a number `> 1`, throw
   `badRequest('n>1 is not supported; the router returns a single choice')`. Placing it before the
   catch keeps the explanatory error from being overwritten by the generic `'invalid request body'`.
   Anthropic has no `n`, so the check is OpenAI-scoped. Guard the read (raw body may be any shape):
   `typeof body === 'object' && body !== null && typeof (body as {n?:unknown}).n === 'number' && n > 1`.

5. **Canon documents the cross-protocol drops.** `cache_control`/`response_format`/`reasoning` are
   preserved same-protocol (round-trip). For the cross-protocol golden fixtures, the dropped-field list
   in the fixture + a canon/README note records the intentional omission (no DROP_KEYS entry is needed
   for the same-protocol round-trip; a cross fixture asserts the drop directly).

## Risks / Trade-offs

- [De-fusion changes multi-block wire output (string → parts/array)] → canon normalization keeps the
  round-trip equal; single-block content is unchanged; new multi-block fixtures pin the new behavior;
  existing fixtures (single-block/parts) are unaffected.
- [Opaque payloads could carry a malformed value upstream] → emitted only on the same protocol the
  client used, so the upstream is exactly as tolerant as without the router; cross-protocol they drop.
- [Tagged `reasoning` adds a small branch to both `requestIn` and `requestOut`] → necessary to honor
  same-protocol-only emission; all four source/target combinations get a test.

## Migration Plan

No schema/data. Behavior changes are widening/correctness (preserved controls, clamped temperature,
`n>1` 400) — documented in a changeset. Rollback = revert; IR additions are optional fields.

## Open Questions

None blocking. (A semantic OpenAI-effort → Anthropic-thinking map is deferred to its own change.)
