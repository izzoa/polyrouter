---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Detect aggregator model-id variants and stop routing to batch-priced ones.

OpenRouter lists 69 of its 431 models as `:batch` twins — identical to the model
they price except that they cost exactly half and can only be reached through the
provider's asynchronous batch API. polyrouter synced them as ordinary routable
models, so they appeared in the dashboard, in `GET /v1/models`, and as routing
targets — and, being the cheapest-looking row for every model that has one, they
attracted exactly the choices that would fail at request time.

Variants are now detected at sync (a bundled token allowlist, applied only to
aggregator providers, never by id shape) and batch-only models are excluded from
routing: they are shown as the batch rate of the model they price, dropped from
`GET /v1/models` and from routing target pickers, refused at config-write time,
and excluded from a tier chain before its primary is chosen — so a chain like
`[twin, base]`, which previously worked only by spending a failed upstream
attempt, now serves from `base` directly. Naming one explicitly returns a 400 that
names the base model to use instead, rather than a misleading "model not found".

Pricing is untouched: no effective price, catalog resolution, or recorded cost
changes.
