---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Subscription presets may declare a client identity, sent only when you turn on a per-provider "identity imitation" switch

A subscription preset can now declare the client identity its provider expects (extra request headers on
model calls and, where it needs them, on the OAuth token endpoint). Nothing is sent by default: each
provider has an **identity imitation** switch that is **off** until you turn it on, from the provider's
edit dialog or at the identity step of the connect wizard. Turning it on shows a warning and asks you to
confirm, because presenting your traffic as another client likely violates the provider's terms. The
switch is available in any deployment mode, a calling agent's own headers are never forwarded, and
polyrouter's honest `User-Agent: polyrouter/<version>` stays unless the declared identity replaces it.

**Claude and ChatGPT are unchanged.** Their presets declare no identity, so the switch is not offered and
their traffic is exactly what it was.

Adds a database migration (one column on the provider row, default off).
