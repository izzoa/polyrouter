---
"@polyrouter/control-plane": minor
"@polyrouter/data-plane": minor
"@polyrouter/frontend": minor
"@polyrouter/shared": minor
---

feat(subscription): ChatGPT Plus/Pro preset + the `openai_responses` upstream protocol

The subscription-OAuth wizard gains a **ChatGPT Plus / Pro** preset (alongside Claude
Pro/Max): sign in at auth.openai.com, land on the dead `localhost:1455` tab, and paste the
redirect URL back — polyrouter exchanges the code (PKCE, form-encoded per this endpoint),
extracts the ChatGPT account id from the exchange's `id_token` (nested
`https://api.openai.com/auth` claim, strictly validated, sealed inside the encrypted
envelope, never logged or echoed), and creates a provider that speaks the ChatGPT backend's
**Responses API** — a new upstream-only `openai_responses` protocol translation
(`requestOut`/`responseIn`/stream parsing behind the same Normalized IR, golden-pinned:
`function_call`/`function_call_output` correlation by `call_id`, parallel-stream assembly
keyed by `item_id`, refusals surfaced as text, all four terminals, cached-input usage
subtraction).

Deliberate limits, stated up front: `store: false` on every call (nothing retained
server-side by request); reasoning items the backend emits are **dropped, never persisted
or replayed** (metadata-only trade — can reduce multi-turn tool-use quality); polyrouter
sends ONLY `Authorization: Bearer` + `chatgpt-account-id` + the Responses beta header —
**no client-fingerprint headers, no imitation instructions, ever**.

**Verified live (2026-07-18)** against real accounts — both presets ship **enabled**, and
the verification pinned real backend quirks into the code: the Codex backend is
**streaming-only** (buffered chat is stream-and-collect) and **rejects
`max_output_tokens`/`temperature`/`top_p`** (documented drops — token caps cannot be
enforced upstream there); the live model list is `gpt-5.4-mini`, `gpt-5.6-sol/terra/luna`,
`gpt-5.5`, `gpt-5.4`; auth.openai.com rejects a `state` token-body param (now
preset-declared — Anthropic's exchange wants it) and returns nested error objects (its
`token_expired` now correctly maps to "reauthorize" instead of looping "try again"); the
token client pins `Accept-Encoding: identity` (a compressed IdP response must never be
undecodable). Full flows proven: connect + account-id claim, buffered + streamed proxied
completions, live tool calling, and forced token refreshes on both presets (Claude's
proxied completion returned the account's own usage-window 429, surfaced as a typed
`rate_limit_error` — correct behavior; see `scripts/verify-*-oauth.md` for the records).

Supporting changes: the token client is preset-encoding-aware (`json`/`form`), surfaces
`id_token` from the exchange only, and a refresh response that omits `refresh_token` now
**retains the stored one** (non-rotating endpoints — applies to Claude too); the
`openai_responses` protocol is connect-only (the public create/update API rejects it) and
`listModels` on a models-endpoint-less provider is a typed error while `test-connection`
runs a designated 1-token probe; editing any OAuth-connected provider now submits a
**name-only** patch with endpoint/kind/protocol shown read-only (previously the edit form
echoed them, which would 400 on a Responses row).
