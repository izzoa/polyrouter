---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
---

Add the "Auto performance" view (add-auto-performance-view): a new owner-scoped
`GET /api/analytics/auto` aggregation (band mix with declared/unroutable splits,
the disjoint four-way cascade outcome split, fall-through count, per-bucket band
series, range-independent telemetry-since, and a signed estimated-savings figure
priced at the current `auto_high` basis with per-row exclusion disclosure), plus
a Routing-page section rendering it: outcome rates, an unroutable diagnostic
callout, net savings with basis label + coverage ("based on N of M
quality-passed requests"), a dash-differentiated band-mix chart, a local range
control, and honest zero states. Stored request costs are never recomputed —
savings are a live, labeled counterfactual.
