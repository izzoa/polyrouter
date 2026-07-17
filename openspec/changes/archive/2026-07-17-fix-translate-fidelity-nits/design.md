## Context

Four contained protocol-fidelity fixes on the translate module (invariant 2). The golden/round-trip
suite is the safety net; all four are verified against it.

## Decisions

- **A-6:** an `OpenBlock.started` flag makes `tool_use_start` idempotent per canonical block — emitted on
  the first fragment with id/name, never re-emitted when a provider repeats id/name on later arg
  fragments (the block's id/name still update).
- **A-7:** the client's `stream_options.include_usage` is captured in `requestIn` into
  `NormalizedRequest.includeUsage`, threaded through `ProxyStreamOptions`/`replayBufferedStream`'s ctx
  into `SerializationContext.includeUsage`; the OpenAI serializer gates the terminal `choices:[]` usage
  chunk on it. The proxy STILL sets `stream_options.include_usage` on the UPSTREAM request (E2.2), so
  cost recording is unaffected — only the client-facing relay is gated. Anthropic ignores the flag (its
  wire always includes usage).
- **A-8 (reviewed — no code change):** the audit read `[text, tool_result]` → `[tool_result, text]` as
  an "order inversion" bug, but on review (codex round 1) the reorder is CORRECT. `[text, tool_result]`
  is **non-conformant** Anthropic input — the wire requires `tool_result` blocks to LEAD a user turn — so
  the adapter normalizes it to the conformant `[tool_result, text]`. Preserving the literal source order
  (an early revision of this change did) produces invalid output on the way back: `requestOut` only
  merges `tool* → following user`, so a `user`-before-`tool` IR emits two consecutive Anthropic `user`
  turns (and an invalid `assistant → user → tool` OpenAI sequence). The original reorder-to-conformant
  behavior stands; the deliberate normalization is now documented in the spec + golden README. Each
  `tool_result` remains its own `role:"tool"` message (1:1 with OpenAI).
- **A-9:** documentation only (golden README) — the `message_start` `input_tokens:0` is a required
  structural placeholder; authoritative usage arrives in the terminal `message_delta`.

## Risks / Trade-offs

- **A-7** is a wire-shape change for OpenAI streams: a client that never set `include_usage` no longer
  receives the usage chunk (matching OpenAI). Clients that relied on always getting it must set the flag —
  which is the OpenAI-documented contract.
- **A-7 IR round-trip is intentionally lossy** (codex round 1, Low): `requestOut` always forces
  `stream_options.include_usage` upstream for cost (E2.2), so `requestIn(requestOut(ir))` reports
  `includeUsage: true` even for a non-opted request. Runtime is unaffected — the proxy always serializes
  the client-facing stream from the ORIGINAL client request (`p.routed`), never a round-tripped IR — and
  the lossiness is documented at the capture site (like the documented `temperature` clamp).
- **A-6 does not close the pre-existing "arguments before identity" gap** (codex round 1, Low): a
  non-conformant stream that sends argument fragments before the id/name (OpenAI always sends id+name in
  the first tool fragment) still emits a `tool_use_delta` before `tool_use_start`. A-6's scope is the
  duplicate-start it was filed for; the args-first ordering is a separate, pre-existing edge left as-is.

## Migration Plan

None — no schema/persisted-state change. IR/context field additions are optional and backward-compatible.
