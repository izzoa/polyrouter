---
"@polyrouter/control-plane": minor
"@polyrouter/frontend": minor
"@polyrouter/shared": minor
"@polyrouter/data-plane": minor
---

feat(providers): show real prices for aggregators (display estimate) + edit providers

Aggregator providers (OpenRouter and other OpenAI-compatible model lists that carry
per-model pricing) no longer show a blank "catalog price". Their `/models` prices are now
captured at **sync** as a per-provider **display estimate** (new `listed_*` model columns)
and surfaced in the Providers and Routing UIs with clear provenance — "provider-listed ·
estimate", "catalog", "you set this", or an honest "unpriced — cost not tracked".

The estimate is **display only**: it never enters the `model_prices` catalog, `resolveModelPrice`,
or the request-time cost snapshot, so recorded cost stays honest (invariant 4 — cost comes
from the bundled catalog, not provider `/models`; an aggregator request still records
`unknown` cost rather than a possibly-wrong `/models`-derived one). Authoritative aggregator
cost (via upstream usage accounting) remains a future enhancement.

`GET /api/models` (and the model-pricing `PATCH` response) now return a resolved
`effectivePrice { input, output, isFree, source, estimated }`, resolved via a single bounded
catalog lookup; the `isFree` filter applies to the effective price.

Providers can now be **edited** from the dashboard — an Edit action opens a form for name,
kind, protocol, base_url, and credential (`PATCH /api/providers/:id`). The credential follows
the write-only contract: blank preserves the stored key, an explicit "remove stored credential"
control clears it, a typed value rotates it. Changing base_url/protocol clears stale listed
estimates; a kind change to api_key/subscription warns that user-set model prices are cleared.
