---
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

Preserve request-side protocol controls and stop rewriting prompts (FABLE_AUDIT epic E2, request half).

- **`cache_control` now passes through** on Anthropic system/content/tool blocks, so Anthropic prompt caching works through the router instead of every request being billed at the full (uncached) input rate.
- **`response_format` and reasoning controls now pass through** on the same protocol the client used — an OpenAI client asking for `json_schema` structured output or `reasoning_effort` gets them at the upstream, instead of the fields being silently dropped. Reasoning controls carry their source protocol and are dropped (never mis-mapped) when crossing protocols.
- **Multi-block content and system prompts are no longer fused** into a single string. Adjacent text blocks kept their boundaries (the standard prompt-caching layout), so the router no longer silently alters prompt text on same-protocol passthrough.
- **`temperature` is clamped to `[0, 1]` when serializing to Anthropic** (OpenAI ranges 0–2), so a legal OpenAI request with `temperature > 1` routed to an Anthropic model no longer 400s and refuses fallback.
- **`n > 1` is now rejected** with a protocol-shaped 400 explaining the router returns a single choice, instead of silently dropping `n` and returning one choice as if it had been honored.

The streaming-side E2 fixes (conformant Anthropic `message_delta` usage, `stream_options.include_usage`, truncation-as-error, unknown-block degradation, golden stream/error coverage) ship separately as `fix-translation-stream-fidelity`.
