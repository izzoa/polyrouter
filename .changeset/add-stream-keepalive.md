---
'@polyrouter/control-plane': minor
'@polyrouter/data-plane': minor
'@polyrouter/frontend': minor
---

Streams survive CDNs and reverse proxies; the live row follows a cascade escalation

Behind Cloudflare (which drops a connection its origin leaves silent for ~100s),
long streaming requests were being cut off at about two minutes and recorded as
"Cancelled": polyrouter sent nothing until the served model's first token, and
nothing while a model was thinking. The dashboard also kept showing the cascade's
cheap model as "Running" after it had escalated, which looked like a model swap.

- **Keepalives on silent streams.** After ~15s with nothing sent
  (`PROXY_STREAM_HEARTBEAT_MS`), a streaming response gets a keepalive — an SSE
  comment for OpenAI clients, Anthropic's own `event: ping` for `/v1/messages`
  clients. Keepalives are never model output and never counted in tokens or cost,
  and they are skipped (never queued) when a client is slow to read.
- **Early response start before a slow first token.** If no first token has
  arrived after ~20s (`PROXY_STREAM_EARLY_COMMIT_MS`), polyrouter sends `200` and
  the SSE headers early and keeps the connection alive. Fallbacks and cascade
  escalation still run exactly as before until the first token — models are still
  never swapped mid-response. A request that then fails gets its error **inside the
  stream** (same error type and message) instead of as an HTTP status; set
  `PROXY_STREAM_EARLY_COMMIT_MS=0` to keep status codes for those late failures.
- Streams now send `X-Accel-Buffering: no`, so nginx-style proxy buffering can't
  hold events back.
- A client disconnect or shutdown while waiting for a first token now ends the
  response immediately instead of waiting on the upstream.
- **The Requests page follows escalation.** When a cascade escalates, the running
  row switches to the strong model and provider right away (a new
  `inflight.updated` dashboard event), instead of only when the request finishes.
