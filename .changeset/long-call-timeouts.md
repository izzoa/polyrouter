---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Long-running research-class models now work end-to-end
(fix-long-call-timeouts). **Per-provider patience overrides** — set
first-response and between-chunks timeouts (1s–1h) on a single provider from
the provider form's Advanced section (blank = inherit the instance defaults,
shown honestly from the server) — resolved per chain attempt, so a raised
research provider never slackens hang detection elsewhere. **The hidden 300s
undici ceiling is gone**: the SSRF-guarded dispatcher's header/body timeouts
are now derived above polyrouter's own typed bounds, so raising a knob actually
holds and timeouts stay typed and correctly breaker-classified. **Keepalives
count as liveness**: upstream bytes (OpenRouter's `: OPENROUTER PROCESSING`
comments included) re-arm the streaming stall watchdog and renew the breaker's
half-open probe lease, so a streamed deep-research call with long silent
thinking gaps is no longer aborted as stalled — true silence still trips at
exactly the configured bound. Operator guidance: raise the slow provider's
patience, prefer streaming, and size your client SDK's own timeout — the one
bound the router cannot lift.
