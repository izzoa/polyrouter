---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': patch
---

Per-provider outbound max-tokens spelling (add-max-tokens-spelling). OpenAI-compatible
providers gain a `maxTokensSpelling` setting (`auto` | `max_completion_tokens` |
`max_tokens`, default `auto`) that controls which wire field the output-token cap is
sent under. `auto` is kind-derived: a `local` provider emits `max_tokens` (older
self-hosted runtimes accept only that and **silently ignore** `max_completion_tokens`,
which would drop the caller's cap), while every other kind emits `max_completion_tokens`
(required by OpenAI o-series and other reasoning models). The translation IR still
accepts both spellings inbound and always emits **exactly one** outbound — never both,
since reasoning models reject the mere presence of `max_tokens`. The choice is a
per-provider `AdapterQuirks` resolved once and applied at every adapter-construction site
(proxy hot path and test-connection alike). Fixes local/legacy OpenAI-compatible
endpoints silently dropping the token cap; existing `local` providers switch to
`max_tokens` on migration (their endpoints accept it) while all other providers are
byte-identical to before.
