---
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
---

Bound untrusted provider responses and accept the canonical local-model URL (FABLE_AUDIT epic E11 + backlog A-42). A provider `base_url` only has to pass the SSRF **address** check — a hostile-but-public endpoint is allowed by design (no allow-list) — so the server must bound whatever that endpoint sends back:

- **Buffered response drains are byte-capped.** `drainText` (data-plane) now bounds every non-streaming read — `chat` (non-stream), `listModels`, `test-connection`, and error bodies — at 10 MiB (matching the `/v1` ingress bound), cancelling the reader (closing the guarded dispatcher — no leaked connection) and rejecting with a typed `ProviderError('bad_request')` before accumulating past the cap. `bad_request` neither trips the breaker (a one-off flood shouldn't disable a healthy provider) nor falls back (which would just re-drain a second giant body). Streaming SSE stays incremental and uncapped. So an endpoint returning a multi-GB or endless body can no longer exhaust the single-container instance's memory.
- **Model ingestion is count- and field-bounded.** `parseModelList` skips a non-string, over-long (>512-char), or duplicate id **before** it counts toward a 5,000-entry parse cap, so a flood of junk or repeated ids can't consume the budget and starve out the legitimate ids that follow. `sync-models` then upserts at most 2,000 models, skips an over-long external id (a truncated id is a *wrong* id that could collide on the `(provider_id, external_model_id)` key), and truncates an over-long display name — so a pathological response can't flood the `models` table with a partial write.
- **The canonical Ollama URL is addable.** The provider `base_url` validator no longer requires a TLD, so `http://localhost:11434` passes URL-shape validation. Address safety is unchanged: the SSRF gate still resolves and blocks private/loopback/metadata ranges, admitting loopback only for a `local` provider under `MODE=selfhosted`.

No schema change.
