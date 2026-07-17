# Protocol-translation golden fixtures

These fixtures back the contract suite for the `Normalized*` IR (spec §6.3,
CLAUDE.md invariant 2). They are the committed source of truth for how the
OpenAI Chat Completions and Anthropic Messages wire formats translate through
the IR.

## Provenance

The fixtures are **hand-authored to the documented wire formats** of each
provider (OpenAI Chat Completions; Anthropic Messages `2023-06-01`) as of
2026-07. No live provider keys are used, so no real tokens or account data are
embedded. The base64 image bytes are a 1×1 transparent PNG.

Refreshing these from **sanitized live captures** (when keys exist) is a
maintenance follow-up — the round-trip and cross-translation contracts hold
regardless of the fixture's source, because they compare a payload against its
own normalized form, not against a provider's live output.

## What each fixture exercises

- `plain` — a system prompt + a plain turn; response usage incl. cache tokens.
- `tools-multiturn` — a multi-turn tool exchange with **parallel** tool calls;
  the Anthropic case includes two `tool_result` blocks (one `is_error`) plus
  **trailing user text** in the same turn — the grouping/splitting crux.
- `multimodal` — a base64 image (+ an OpenAI remote-URL variant, preserved not
  fetched; `detail` on the OpenAI side).
- `malformed-tool` — an assistant tool call whose `arguments` are invalid JSON;
  represented as an `inputParseError` block, never thrown.
- `streamed` — a text stream and a tool-call stream, exercising the usage
  lifecycle (Anthropic start/delta; OpenAI empty-`choices` terminal chunk),
  per-block tool-JSON assembly, and split-frame tolerance.

## Request-control passthrough & intentional cross-protocol drops

Request-side controls are carried **verbatim on the same protocol the client
used** and **dropped — deliberately, never mapped to a wrong value — crossing to
a protocol that lacks them** (see `request-fidelity.spec.ts`):

- `cache_control` (Anthropic prompt caching) — carried on Anthropic text /
  tool_use / tool_result blocks, tools, and system blocks; **dropped** crossing
  to OpenAI (no wire equivalent). Not modeled on image blocks or nested
  tool-result content.
- `response_format` (OpenAI structured output) — carried OpenAI→OpenAI;
  **dropped** crossing to Anthropic.
- reasoning controls — OpenAI `reasoning_effort` and Anthropic `thinking` are
  tagged with their source protocol in the IR and emitted **only** back to that
  protocol; each is **dropped** crossing to the other (no semantic map).
- `temperature` — **clamped to `[0, 1]`** when serializing to Anthropic (OpenAI
  ranges 0–2), a documented lossy mapping so a legal OpenAI request doesn't 400.

Multi-block content and system prompts are serialized as block/parts **arrays**,
never fused into one string (which would alter prompt text and destroy the
caching layout); a single unmarked text block still serializes to a plain string
(canonically equivalent).

### Non-conformant user turns are normalized to tool_result-first (A-8)

The Anthropic wire requires `tool_result` blocks to **lead** a user turn. A
non-conformant input turn that places user content before a `tool_result` (e.g.
`[text, tool_result]`) is deliberately **normalized** to the conformant shape on the
way into the IR — the `tool_result` becomes its own leading `role:"tool"` message and
the text trails as a `role:"user"` message. Preserving the literal source order would
emit invalid consecutive user turns (and an `assistant → user → tool` OpenAI
sequence) when serialized back out, so this reorder-to-conformant is intentional, not
an "order inversion" bug. Each `tool_result` is one `role:"tool"` message (1:1 with
an OpenAI tool message).

### Streamed usage on a cross-protocol `message_start` (A-9)

The Anthropic wire requires a `usage` object on the opening `message_start`
event. When serializing an **OpenAI-origin** stream to the Anthropic wire, the
upstream has not yet reported usage (OpenAI emits usage only in the terminal
chunk), so the serializer emits `usage.input_tokens: 0` on `message_start` as a
**structural placeholder** — the authoritative token counts arrive in the single
`message_delta` before `message_stop` (E2.1), and cost/recording (#11) always
read from that terminal usage, never from the `message_start` zero. This is a
deliberate, documented cross-protocol placeholder, not a real token count.

## Error matrix

The `error` cases covered are **in-band** stream `error` events and malformed/edge
wire payloads. Specifically (`stream-fidelity.spec.ts`):

- an in-band OpenAI `{ error }` stream frame → a normalized `error` event (no
  `TypeError` on `choices`);
- a **truncated** stream — OpenAI exhausting without `[DONE]`/a finish chunk, or
  Anthropic without `message_stop` → a normalized `error` (type `truncated`),
  never a fabricated clean terminator;
- a **malformed streamed** Anthropic `tool_use` (argument fragments that never
  form valid JSON) → finalized as the `inputParseError` variant, never thrown;
- an **unknown streamed block** (e.g. Anthropic `thinking` / `thinking_delta`) →
  skipped, so it never reaches the proxy as a malformed `tool_use_delta`;
- the non-streaming `malformed-tool` fixture (invalid tool JSON) and split SSE
  frames.

HTTP transport errors (non-2xx, connection failures) are **out of scope here** —
they belong to the provider layer (#6) and the proxy (#10). The streamed
`/v1/messages` client wire (the Anthropic serializer, incl. the single
usage-bearing `message_delta` before `message_stop`) is asserted end-to-end in
`packages/control-plane/test/proxy/inference-proxy.e2e-spec.ts`.
