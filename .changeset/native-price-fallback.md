---
"@polyrouter/control-plane": minor
"@polyrouter/frontend": minor
"@polyrouter/shared": minor
---

feat(pricing): native-family price fallback for aggregator models (flagged estimates)

Aggregator-routed models (OpenRouter) whose exact channel key is missing from the price
catalog no longer record `unpriced` when the SAME model's price exists under its native
family (e.g. `openrouter:minimax/minimax-m3` missing → `minimax:minimax-m3` used): the
request snapshots the native-family catalog row, **flagged `native_family` end-to-end** —
a new `price_source` column on both cost ledgers, a `price source` row plus `· est.`
affordances in the request inspector (the combined total is marked whenever a superseded
cascade attempt was estimate-priced, via the rolled-up `priceEstimated` flag), an
estimate-priced spend split (`nativeFamilySpend`) in the analytics summary and Costs page,
and estimate marking in budget alert/block notices and the weekly spend summary. Budgets
meter estimate-priced spend identically — recorded cost is recorded cost.

The derivation is allowlist-only (aggregator families + a verified vendor→family map;
unmapped vendors stay unknown; `:free` SKUs never borrow the paid rate), the exact channel
key always wins once it exists (new requests only — recorded rows are immutable), and
provider-listed `/models` prices still never enter billing: the models UI now shows the
listed channel figure **alongside** a native-family estimate (new `listedPrice` on the
models API) instead of hiding it. Migration `0011` adds the nullable `price_source`
columns; existing rows render exactly as before.
