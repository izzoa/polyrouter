---
'@polyrouter/data-plane': patch
---

An explicit `x-polyrouter-tier` header now beats every other routing mechanism
except the `model` field (add-tier-header-precedence). The tier header is one
coherent resolution phase — its value remaps (dashboard Header rules) first,
then the direct tier lookup — evaluated before rules on any other header, so an
API-created rule on e.g. `x-env` can no longer shadow a per-request tier ask at
any priority. Same-header remap semantics, advisory fall-through, and requests
without the tier header behave exactly as before.
