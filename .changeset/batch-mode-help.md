---
'@polyrouter/shared': minor
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Tell the reader what reserving an entry for batch actually costs.

The batch reservation control said what it did and nothing about the consequences.
It now carries help text — announced with the switch, revealed on hover or keyboard
focus, and simply always visible on narrow screens — stating three things: the entry
is held for batch work, results can take up to 24 hours and arrive only when the whole
batch finishes with nothing streaming, and **that model's batch rate beside its
synchronous one**.

The rate is the model's own resolved batch price, never a claim about batch pricing in
general. A model whose batch rate cannot be resolved says so rather than implying the
synchronous price or a discount. Models gain a `batchEffectivePrice` for this, resolved
from the catalog rows the model list already loads, so it costs no extra query.

The 24-hour figure now has a single definition that the adapters and the interface both
read, so they cannot drift apart.
