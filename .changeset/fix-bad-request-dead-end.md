---
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/shared': minor
'@polyrouter/frontend': minor
---

A router-chosen HTTP 400 now falls back instead of abandoning the chain, and the
provider's own error classification is recorded so a withheld message is still
diagnosable. The transport byte bound gains its own error kind so its no-fallback
guarantee no longer depends on `bad_request`'s routing.
