---
"@polyrouter/data-plane": minor
"@polyrouter/shared": minor
---

feat(providers): identify polyrouter to OpenRouter for app attribution

Requests to an `openrouter.ai`-host provider now carry OpenRouter's app-attribution headers —
`HTTP-Referer: https://polyrouter.app` and `X-OpenRouter-Title: polyrouter` — so polyrouter
appears in OpenRouter's public rankings and per-model app analytics. The headers are computed
once at adapter creation and cover all outbound OpenRouter calls (chat, streaming, model sync,
test-connection).

The headers are **non-secret** (an app URL and name — no user data, prompts, or keys) and are
disclosed **only** to OpenRouter (an exact `openrouter.ai` host match; every other provider —
OpenAI, Anthropic, custom, local — receives neither header). They are additive and never affect
authentication. This is default-on with no opt-out.
