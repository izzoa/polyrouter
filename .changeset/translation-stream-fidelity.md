---
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': patch
---

Fix streamed protocol translation (FABLE_AUDIT epic E2, stream half).

- **Streamed `/v1/messages` now conforms to Anthropic SDKs.** The serializer emitted a `message_delta` per upstream event with `stop_reason: null` (clobbering a delivered stop reason) and usage only sometimes — crashing Anthropic SDK clients at end-of-turn when streaming from an OpenAI upstream. It now buffers the tail and emits exactly one conformant `message_delta` (a numeric `usage.output_tokens`, a non-null `stop_reason`) immediately before `message_stop`.
- **Streamed OpenAI usage is now exact.** Streamed requests set `stream_options: { include_usage: true }`, so the router records the provider's real token counts instead of a chars/4 estimate.
- **A truncated upstream stream is now an error, not a fake success.** Both parsers emit a normalized `error` event when a stream ends without its terminator (`[DONE]`/a finish chunk for OpenAI; `message_stop` for Anthropic), so a cut-off answer records `status=error` instead of `status=success`.
- **Unknown streamed content no longer crashes the proxy.** An Anthropic `thinking` block and its `thinking_delta` are skipped (previously they produced a `tool_use_delta` with undefined JSON that crashed the proxy); unknown non-streamed response blocks and unknown OpenAI request parts are skipped; an in-band OpenAI `{ error }` stream frame becomes a normalized error event instead of a `TypeError`.

The golden suite now covers the Anthropic stream serializer, in-band error events, truncation, and a malformed streamed tool call end to end. This completes epic E2 (the request half shipped as `fix-translation-request-fidelity`).
