---
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
---

Protocol-translation fidelity fixes (FABLE_AUDIT A-6/A-7/A-9; A-8 reviewed): the OpenAI stream parser now emits `tool_use_start` exactly once per tool block — a provider that repeats the tool-call `id`/`name` on later argument fragments no longer produces a duplicate start (A-6); and the OpenAI serializer relays the terminal `choices:[]` usage chunk only when the client set `stream_options.include_usage` (matching OpenAI, which omits it otherwise) — the proxy still requests usage upstream for cost accuracy, so recording is unaffected (A-7). Documented the cross-protocol `message_start` `input_tokens:0` placeholder and the deliberate `[text, tool_result]` → `[tool_result, text]` normalization in the golden README (A-9, A-8).
