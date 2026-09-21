---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

`GET /v1/models` now describes what it advertises, and answers the Anthropic SDK in its own shape.

Every entry gains the `created` field the OpenAI schema requires. Real model ids additionally carry their context window, tool / vision / reasoning support, and effective price — resolved through the same shared resolver the dashboard and the cost path use, and marked when the figure is an estimate. `auto` and tier keys deliberately carry none of it: a virtual id names a set of models, and no single window or price describes one. Unknown values are absent rather than null.

`anthropic.models.list()` hits the same `GET /v1/models` URL as the OpenAI SDK, so the caller's envelope is now chosen by the `anthropic-version` header — never by the credential header, which either SDK may use. A caller sending no such header gets the OpenAI shape exactly as before.

Adds `GET /v1/models/{id}`, serving every id the listing advertises — including ids containing `:` and `/`, in either spelling. An id the listing hides is a 404 in the caller's own error envelope.
