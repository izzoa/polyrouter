---
'@polyrouter/shared': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': patch
---

Record a provider-listed price fallback for models the catalog doesn't cover
(record-listed-price-fallback). The cost resolver `resolveModelPrice` gains a final
`listed` tier — below the bundled/LiteLLM catalog and the native-family estimate, above
`unpriced` — so a model whose catalog paths all miss but whose provider (e.g. OpenRouter)
reported a per-token price at `sync-models` time now records that captured listed price
with `source: 'listed'` instead of `unpriced`. LiteLLM always wins: listed is consulted
only when the catalog (exact + native-family) is unknown, and never overrides it. The
listed price is snapshotted onto the RequestLog at request time (immutable, like every
source) and marked as an estimate everywhere — `priceEstimated: true`, the inspector's
`provider-listed · estimate` label and `· est.` marker, the request-table `~`, budget-alert
provenance, and the weekly-summary estimate caveat — never presented as an authoritative
cost. A 0/0 listed price that is not asserted free (token rates zero but a per-request/image
charge) records `unpriced` rather than a misleading "free", since the non-token cost can't
be captured. The display and recorded-cost paths now share one resolver (the Models-page
effective price and the RequestLog resolve identically). This deliberately
relaxes invariant 4 (recorded cost may now come from a provider estimate) under three
guardrails: the catalog always wins, the estimate is clearly marked, and it is snapshotted
immutably. No schema/migration change — the value flows through the existing
`routing`/`listed_*` columns and `price_source`.
