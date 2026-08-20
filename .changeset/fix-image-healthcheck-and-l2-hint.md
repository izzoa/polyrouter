---
'@polyrouter/control-plane': patch
'@polyrouter/frontend': patch
---

One healthcheck contract across both image variants, and an honest L2 hint.

Both Docker image variants (baseline and `-semantic`) now declare the identical
exec-form Node health probe: it targets `/api/health` on the configured `PORT`
(default 3001) and needs no `wget`/`curl`, so changing `PORT` no longer requires
a healthcheck override, and the documented Node probe form runs unchanged on
both variants — overrides that shell out to base-image utilities remain outside
the contract (the baseline's former BusyBox-`wget` probe had no binary to run
on the `-semantic` image's Debian-slim base).

`GET /api/routing/auto-layers` additionally reports the semantic capability's
two halves — `semanticFlagEnabled` (`semantic ∈ ROUTING_AUTO_LAYERS`) and
`semanticClassifierReady` (embedder + centroids) — with `semanticAvailable`
preserved as their conjunction. The Routing page's unavailable-L2 hint now names
exactly the missing half(s) instead of unconditionally saying "set
`SEMANTIC_MODEL_PATH`" (which was wrong on a `-semantic` image that only lacked
the `ROUTING_AUTO_LAYERS` entry).
