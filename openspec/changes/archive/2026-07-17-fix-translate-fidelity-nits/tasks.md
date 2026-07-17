## 1. A-6 — tool_use_start once per block

- [x] 1.1 Add `OpenBlock.started`; emit `tool_use_start` only when `!started && (id||name)`, then set `started`.
- [x] 1.2 (covered by stream specs) a repeated id/name fragment does not re-open the block.

## 2. A-7 — relay the terminal usage chunk only on client opt-in

- [x] 2.1 Capture `stream_options.include_usage` in openai `requestIn` → `NormalizedRequest.includeUsage`; add `SerializationContext.includeUsage`; gate the serializer's terminal usage chunk on it; keep requesting usage UPSTREAM (cost unaffected).
- [x] 2.2 Thread `includeUsage` through `ProxyStreamOptions` + `replayBufferedStream` ctx (core.ts) and set it from `p.routed.includeUsage` at the proxy.service serialize sites.
- [x] 2.3 Stream specs: usage chunk relayed WITH `includeUsage:true`, omitted without it.

## 3. A-8 — reviewed: normalize non-conformant `[text, tool_result]` to tool_result-first (no code change)

- [x] 3.1 Reviewed A-8: the anthropic `requestIn` reorder-to-conformant is CORRECT (a non-conformant `[text, tool_result]` normalizes to `[tool_result, text]`); document it (spec + README), no code change. Existing per-result/round-trip specs stay green.

## 4. A-9 — document the message_start placeholder

- [x] 4.1 Add a golden-README note on the cross-protocol `message_start` `input_tokens:0` placeholder.

## 5. Wrap-up

- [x] 5.1 build/lint/typecheck green; data-plane translate + proxy e2e green.
- [x] 5.2 Changeset; update TODOS + mark A-6/A-7/A-8/A-9 ✅ in FABLE_AUDIT after archive.
