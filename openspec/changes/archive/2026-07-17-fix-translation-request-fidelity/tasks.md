# Tasks: fix-translation-request-fidelity

Base dir `T/` = `packages/data-plane/src/proxy/translate/`. Keep every change side-effect-free
(invariant 2 — `purity.spec` must stay green): no IO, no `Date`, no `Math.random`.

## 1. IR + wire type extensions

- [x] 1.1 `T/ir.ts`: add `export type CacheControl = { readonly type: 'ephemeral' } | Readonly<Record<string, unknown>>`; add optional `readonly cacheControl?: CacheControl` to `TextBlock`, `ToolUseOkBlock`, `ToolUseRawBlock`, `ToolResultBlock`, and `NormalizedTool` (NOT image blocks, NOT nested tool-result content)
- [x] 1.2 `T/ir.ts`: add `export type ReasoningControl = { readonly protocol: 'openai'; readonly effort: unknown } | { readonly protocol: 'anthropic'; readonly thinking: unknown }`; add optional `readonly responseFormat?: unknown` and `readonly reasoning?: ReasoningControl` to `NormalizedRequest` (request-level; NOT in `NormalizedParams`)
- [x] 1.3 `T/wire/anthropic.ts`: add optional `cache_control?: unknown` to `AntTextBlock`, `AntToolUseBlock`, `AntToolResultBlock`, `AntTool`; add optional `thinking?: unknown` to `AntRequest`
- [x] 1.4 `T/wire/openai.ts`: add optional `response_format?: unknown` and `reasoning_effort?: unknown` to `OaiRequest`

## 2. Stop fusing multi-block content/system (E2.3 — before cache_control can attach per-block)

- [x] 2.1 `T/anthropic.ts` `requestOut` (~268-271): replace the `(ir.system as TextBlock[]).map(b=>b.text).join('')` cast with a helper that emits an `AntTextBlock[]` (each carrying `cache_control` from the IR block's `cacheControl`) when `ir.system.length > 1` OR any block has `cacheControl`; else a plain string; non-text system blocks degrade to their text or are skipped (never `undefined`)
- [x] 2.2 `T/openai.ts` `blocksToContent` (~112-114): when the text-only case has >1 block, return an `OaiContentPart[]` of `{type:'text', text}` parts instead of `join('')`; a single text block still returns a string. `requestOut` system (~228-230): emit parts-array system content when >1 block instead of `toolResultText` fusion. Leave `toolResultText`/`blocksToText` (single-string sinks) joining
- [x] 2.3 Golden fixture with a 2-block system + a 2-text-block user message (both protocols) + a same-protocol round-trip test asserting canonical equivalence AND that the wire form is a block/parts array, not a fused string

## 3. cache_control passthrough (E2.4 — depends on §1, §2)

- [x] 3.1 `T/anthropic.ts`: `antBlockToIr` + `requestIn` read `cache_control` from wire text/tool_use/tool_result/system blocks and tools into IR `cacheControl`; `irBlockToAnt` + tool + system serialization in `requestOut` emit it back onto the wire blocks/tools (the tool_result marker on the block itself; nested tool-result content stays fused text)
- [x] 3.2 `T/openai.ts`: OpenAI has no `cache_control` wire field — the Anthropic→OpenAI drop is documented in `T/canon.ts` (comment) and the golden README; do not fabricate one
- [x] 3.3 Golden fixture `golden/anthropic/*` carrying `cache_control` on a system block and a tool; test asserts a same-protocol Anthropic round-trip preserves it (canon carries it, not drops)

## 4. response_format + reasoning passthrough (E2.5 — depends on §1)

- [x] 4.1 `T/openai.ts` `requestIn` (~207-223): read `wire.response_format` → `responseFormat`; `wire.reasoning_effort` → `reasoning = { protocol: 'openai', effort }`. `requestOut` (~273-286): emit `response_format` when present; emit `reasoning_effort` ONLY when `ir.reasoning?.protocol === 'openai'`
- [x] 4.2 `T/anthropic.ts` `requestIn`: read `wire.thinking` → `reasoning = { protocol: 'anthropic', thinking }`. `requestOut`: emit `thinking` ONLY when `ir.reasoning?.protocol === 'anthropic'`; NEVER emit `response_format` (OpenAI-only). Cross-protocol reasoning is a documented drop
- [x] 4.3 Golden fixture with `response_format` (json_schema) + `reasoning_effort` on an OpenAI request; round-trip test asserts they survive OpenAI→OpenAI; a cross test asserts OpenAI→Anthropic drops both (no `thinking` fabricated) and Anthropic `thinking`→OpenAI drops it. Test all four source/target reasoning combinations

## 5. Temperature clamp (E2.9)

- [x] 5.1 `T/anthropic.ts` `requestOut` (~286): `temperature: Math.min(ir.params.temperature, 1)`; unit test asserts `1.5 → 1` and `0.7 → 0.7`; document the lossy clamp in the golden README

## 6. n > 1 rejection (E2.10)

- [x] 6.1 `packages/control-plane/src/proxy/proxy.service.ts` `resolvePlan` (~645): **before** the `requestIn` try/catch, when `protocol === 'openai'` and the raw body is an object with a numeric `n > 1`, throw `badRequest('n>1 is not supported; the router returns a single choice')` (guard the read: `typeof body==='object' && body!==null && typeof body.n==='number'`)
- [x] 6.2 e2e in `packages/control-plane/test/proxy/inference-proxy.e2e-spec.ts`: `POST /v1/chat/completions` with `n:2` → 400 OpenAI-shaped naming the limit AND no upstream call (assert the stub saw no request); `n:1`/absent → served

## 7. Definition of done

- [x] 7.1 `npm run build`, `npm run lint`, `npm run typecheck` green; `npm test -w packages/data-plane` (with `REDIS_URL`) + `-w packages/control-plane` green; `npm run test:e2e -w packages/control-plane` green (reap stray jest workers + `redis-cli FLUSHALL` before a clean e2e run)
- [x] 7.2 `purity.spec` still passes; all existing golden round-trips stay green; the new cache_control / response_format / reasoning / de-fusion / temperature tests pass; the four reasoning source/target combinations are covered
- [x] 7.3 Uncached-usage formulas, tool grouping, and the mid-stream commit boundary unchanged; a changeset added (`npx changeset`, minor); `openspec validate fix-translation-request-fidelity --type change --strict --no-interactive` passes
