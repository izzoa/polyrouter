---
'@polyrouter/shared': patch
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
'@polyrouter/frontend': patch
---

polyrouter now identifies itself as `User-Agent: polyrouter/<version>` on every upstream call, instead of the HTTP library's default

Every request polyrouter makes itself carries exactly one `User-Agent`, `polyrouter/<release version>`:
chat (buffered and streaming), model listing, test-connection, model sync and batch calls to your
providers, the OAuth token-endpoint calls (exchange, refresh and the scheduled sweep), the pricing
catalog refresh and Apprise delivery. A calling agent's own `User-Agent` is never forwarded, and the
value is not configurable.

**Upgrade note for existing Claude and ChatGPT OAuth connections.** From this release their traffic
announces `polyrouter/<version>` instead of the HTTP library's name. An upstream could single that
out; if one rejects it, the rejection shows as the provider error on the connection's card.

No API, routing behavior or stored data changed.
