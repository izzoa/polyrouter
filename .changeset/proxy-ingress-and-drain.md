---
'@polyrouter/control-plane': minor
'@polyrouter/data-plane': minor
---

Fix four `/v1` request-path defects (FABLE_AUDIT epic E1).

- **Large request bodies now work, and body errors are protocol-shaped.** The `/v1` body limit was body-parser's 100kb default, which 413'd realistic agent conversations with a raw HTML error that bypassed the protocol-shaped exception filter. The `/v1` limit is now configurable via `PROXY_MAX_BODY_BYTES` (default 10 MiB) and confined to `/v1` (so the pre-auth `/api` body window is not enlarged); oversized bodies return a protocol-shaped **413** and malformed JSON a protocol-shaped **400**, in the caller's OpenAI/Anthropic envelope — never HTML.
- **Graceful shutdown no longer hangs on a write-blocked stream.** At the drain deadline the registry aborted only the upstream, so a stream whose client had stopped reading (socket still open) left the write loop parked forever and `app.close()` hung until SIGKILL — severing every other in-flight stream and skipping the log-writer flush. The drain now races the abort signal and releases the wedged socket, so shutdown always completes within the deadline. A normally-completed stream is unaffected (never truncated).
- **A hung-at-connect provider now trips the breaker on the streaming path.** A provider that accepted the connection but never sent headers made the core first-event timeout fire before the adapter's, surfacing as a caller-cancel and classified breaker-neutral — so it was never skipped and no `provider_down` alert fired (the buffered path tripped correctly; the two were inconsistent). Core's first/inter-event bound now sits a fixed margin above the adapter's first-byte bound so the adapter's typed `unavailable` timeout wins, and `withBreakerStream` treats a cancellation as neutral only when the supplied caller-abort predicate reports the client actually went away — a system-imposed timeout trips. Genuine client-disconnect neutrality is preserved.
- **Streaming timeouts are configurable.** `PROXY_FIRST_EVENT_TIMEOUT_MS` (default 30s) lets operators raise the time-to-first-token bound for slow local models with long CPU prefill instead of falsely tripping their breaker; an internal `PROXY_EVENT_TIMEOUT_MARGIN_MS` keeps core's bound above the adapter's.

With the variables unset, timeout behavior is unchanged; the only default behavior change is the larger `/v1` body limit and the protocol-shaped rendering of body-parse errors.
