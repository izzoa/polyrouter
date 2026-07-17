# Proposal: fix-translation-request-fidelity

Implements the **request-side** half of **FABLE_AUDIT.md Epic E2** (protocol translation fidelity — a
P0 audit epic). The streaming-side half (E2.1, E2.2, E2.6, E2.7, E2.8) ships as the companion change
`fix-translation-stream-fidelity`; the audit and the proposal review both recommended splitting the
epic along this line so each change is a reviewable unit.
**Spec refs:** spec.md §6.3, §7.2, §7.4, §15; `openspec/specs/protocol-translation`; CLAUDE.md invariant 2.

## Why

The `translate/` request path silently strips high-value client controls and rewrites prompts, on the
reliable-core same-protocol passthrough as much as cross-protocol:

1. **`cache_control` is stripped** from system/content/tool blocks (the IR and wire types don't model
   it), disabling Anthropic prompt caching through the router — a caching-reliant agent is billed at
   full input rate (~10× cache-read) with zero indication (E2.4).
2. **`response_format` and reasoning controls are silently dropped** by the allowlist rebuild — a
   client asking for guaranteed JSON gets prose, and reasoning modes can't be enabled through the
   router at all; spec §7.2 even names structured-output demand as a routing signal (E2.5).
3. **Adjacent text blocks are fused with `''`**, silently rewriting multi-block prompts (the standard
   prompt-caching layout) even on Anthropic→Anthropic passthrough, and it is the structural blocker to
   attaching per-block `cache_control` (E2.3).
4. **`temperature` is copied verbatim** to Anthropic (0–1) from OpenAI (0–2), so a legal
   `temperature: 1.5` fails as `bad_request` — which refuses fallback — defeating §7.4's chain
   promise (E2.9).
5. **`n > 1` is silently dropped**: best-of-n clients get one choice with no indication (E2.10).

## What Changes

- **IR + wire extension:** add optional `cacheControl` to IR text/tool_use/tool_result blocks, system
  blocks, and tools (Anthropic-only wire field); add `responseFormat` (OpenAI-only) and a
  **source-protocol-tagged** `reasoning` control to the IR request, with matching wire fields
  (`response_format` on OpenAI, `thinking` on Anthropic).
- **Same-protocol passthrough, cross-protocol documented drop:** `requestIn` reads these from the wire;
  `requestOut` re-emits them **only when serializing back to the protocol that owns the field** (so an
  OpenAI `reasoning_effort` routed to Anthropic is a documented drop, not a fabricated `thinking`
  map). `cache_control` (Anthropic-only) and `response_format` (OpenAI-only) are inherently
  single-protocol; `reasoning` exists in both, so it carries a `{ protocol }` tag to decide.
- **No fusion (E2.3):** Anthropic `requestOut` emits `system` as a text-block array (carrying
  `cache_control`) when it has >1 block or any block has a marker; OpenAI out emits a content-parts
  array for multi-text content instead of `join('')`. Single-block content still serializes to a
  string (canonically equivalent).
- **Clamp (E2.9):** Anthropic `requestOut` clamps `temperature` to `[0, 1]` (documented lossy map).
- **`n > 1` policy (E2.10):** the proxy rejects an OpenAI `n > 1` request with a protocol-shaped 400
  **before** the `requestIn` normalization (so the explanatory error is not overwritten by the generic
  invalid-body catch).

## Capabilities

### New Capabilities

*None.*

### Modified Capabilities

- `protocol-translation`: the IR gains opaque `cacheControl` (blocks/system/tools), `responseFormat`,
  and a source-protocol-tagged `reasoning`; request translation carries them without loss
  same-protocol and drops-with-documentation cross-protocol, preserves multi-block structure (no
  fusion), and clamps `temperature` cross-protocol.
- `inference-proxy`: an `n > 1` request is rejected with a protocol-shaped 400.

## Impact

- **Modified (production):** `translate/ir.ts` (IR fields), `translate/wire/{openai,anthropic}.ts` (wire
  fields), `translate/openai.ts` (requestIn/out, blocksToContent, system serialization),
  `translate/anthropic.ts` (requestIn/out, system serialization, tool/block cache_control, temperature
  clamp), `translate/canon.ts` (document the cross-protocol drops); `packages/control-plane/src/proxy/proxy.service.ts`
  (`n > 1` 400 before `requestIn`).
- **Modified/new (tests):** new golden fixtures (multi-block system + multi-text user; `cache_control`
  on a system block + tool; `response_format` + `reasoning_effort`; a temperature-clamp case);
  `cross-translation.spec.ts`, `openai.spec.ts`, `anthropic.spec.ts`; an `n:2` e2e case; golden
  `README.md` documents the temperature clamp and the cross-protocol drops.
- **Purity preserved (invariant 2):** opaque passthrough, no IO/`Date`; `purity.spec` stays green.
- **Schema/migration:** none. **Changeset:** required (user-facing: cache_control/response_format/
  reasoning now pass through same-protocol; temperature is clamped; `n > 1` now 400s).
- **Dependencies:** none.

## Non-goals

- **The streaming-side E2 fixes** (E2.1 conformant `message_delta` usage, E2.2 `stream_options.include_usage`,
  E2.6 golden stream/error coverage, E2.7 truncation-as-error, E2.8 unknown block/part degradation) —
  the companion `fix-translation-stream-fidelity` change.
- **A semantic cross-protocol reasoning map** (OpenAI `reasoning_effort` → Anthropic
  `thinking.budget_tokens`) — a documented drop here; a richer map can be its own change.
- **`cache_control` on image blocks or on nested tool-result content** — out of scope (the marker is
  modeled on the text/tool_use/tool_result *block* and on tools/system, matching the audit); images and
  nested tool-result text are not marker carriers.
- **Fanning out `n > 1`** into multiple choices — the IR stays n=1 and the proxy rejects.
- No change to the uncached-usage formulas, tool grouping, or the mid-stream commit boundary.
