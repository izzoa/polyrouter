---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Auto-routing decisions become queryable. Every `auto` request the structural
layer evaluates now records its verdict as request_log columns —
`structural_band` (high/low/ambiguous), `structural_score`, and
`structural_band_source` (threshold vs a declared-maximal rule) — on every
row the request produces, including cascade rows (the L1 verdict beside the
L3 outcome) and the previously-invisible fall-throughs: an ambiguous
classification that stayed on the default tier, and a confident band whose
auto_high/auto_low target wasn't configured. Fall-through rows' routing
reason now carries the classifier verdict as a visible suffix, so the
inspector shows WHY auto stayed on default. Requests the layer didn't
evaluate record nulls; history is never backfilled; no routing behavior
changes.
