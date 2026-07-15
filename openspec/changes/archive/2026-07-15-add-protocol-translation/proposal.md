# Proposal: add-protocol-translation

> Implements **TODOS.md #5 `add-protocol-translation`** — spec.md **§6.3** (protocol translation & streaming, "the hardest part — budget the most time here"), **§5** (Model usage fields), **§7.7** (cache tokens preserved for cost). CLAUDE.md invariant **2** (translation is its own module behind a `Normalized*` IR, backed by golden-file contract tests).

## Why

Every proxied request is normalized OpenAI ⟷ chosen-provider, and OpenAI Chat Completions vs Anthropic Messages differ in ways that break naive passthrough (system-prompt placement, tool-call shapes, streaming event sequences, stop reasons, multimodal encodings, usage fields). The spec names this the single hardest part of the app and where most bugs will live. Landing the translation module **now** — before the proxy (#10) and adapters (#6) exist — means everything downstream is built on a clean `Normalized*` IR with a golden-file contract suite proving it round-trips, instead of provider quirks leaking through the proxy core.

## What Changes

- **A `Normalized*` intermediate representation** (`data-plane/src/proxy/translate/`) — the single IR that #6's provider adapters and #10's proxy consume; **nothing else defines a normalized shape** (invariant 2). Content-blocks-everywhere: text/image (with `detail`)/tool_use/tool_result, system as a top-level field, tool arguments as **parsed objects** (with a raw/parse-error variant for invalid model JSON, never thrown), `tool_choice` + parallel-call control as first-class fields, usage as **uncached components** with cache-read/write tokens (Anthropic excludes cache tokens from input, OpenAI includes them — converted by formula for correct cost, §7.7, invariant 4), canonical stop reasons with raw + stop-sequence passthrough. Single-choice (`n=1`) contract.
- **One in/out adapter per protocol** (`openai.ts`, `anthropic.ts`), each pure: `requestIn`/`requestOut`, `responseIn`/`responseOut`, and streaming `parse`/`serialize`. The proxy core stays protocol-agnostic; provider deviations are per-adapter **quirks**, not special cases sprinkled through the proxy.
- **Streaming translation**: parse an upstream SSE stream (OpenAI `chat.completion.chunk` deltas **or** Anthropic `message_start`/`content_block_*`/`message_delta`/`message_stop`) into a `NormalizedStreamEvent` sequence, and serialize that sequence into the client's protocol — reassembling text, **multi-turn/parallel tool-call JSON**, stop reasons, and usage token by token.
- **A golden-file contract suite** (§6.3 DoD): committed fixtures per protocol across the matrix — plain, multi-turn tool-call round-trip (incl. parallel results + trailing text), streamed (incl. the usage lifecycle, split frames, malformed tool JSON), multimodal, error (in-band stream errors / malformed wire payloads) — asserting both **canonical round-trip equivalence** (protocol → IR → same protocol loses nothing that the IR models; a documented canonicalizer handles equivalent encodings, and per-fixture notes record intentionally-dropped provider-only fields) and **cross-translation** (OpenAI client ⟷ Anthropic upstream and vice-versa) for requests, responses, and streams, plus a numeric usage matrix (cache hit/write/mixed/none).

## Capabilities

### New Capabilities

- `protocol-translation`: the `Normalized*` IR, the OpenAI/Anthropic in/out adapters (request/response/stream), the quirk mechanism, and the golden-file contract suite.

## Impact

- **Code:** `packages/data-plane/src/proxy/translate/**` (IR types, `openai.ts`, `anthropic.ts`, a small facade, quirk hooks) + `test/golden/**` fixtures and the contract suite. No schema, no endpoints, no network (pure transforms). No new runtime dependencies (SSE parsing is hand-rolled over the standard shapes).
- **Downstream:** #6's adapters return/accept `Normalized*` (never a raw provider shape); #10's proxy translates client↔IR↔upstream through this module and stays protocol-agnostic; #11's RequestLog reads `NormalizedUsage` (incl. cache tokens) for cost.

## Non-goals

- **No proxy, no HTTP, no routing** — this is pure translation; the proxy endpoints, fallbacks, and the mid-stream commit policy are #10/#12. (This module provides the streaming parse/serialize primitives the commit policy is built on, and states the boundary, but does not enforce commit/fallback.)
- **No provider adapters / outbound calls** — #6 wires the adapter interface + circuit breaker + SSRF-guarded fetch around this translation core.
- **No live provider capture** — golden fixtures are authored to the real documented wire formats and committed; refreshing them against live captures (when keys exist) is a maintenance follow-up, noted in the suite.
- **No protocols beyond OpenAI Chat Completions and Anthropic Messages** — the two the proxy contract commits to (§6.1).
