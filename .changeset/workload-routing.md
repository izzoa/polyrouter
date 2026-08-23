---
"@polyrouter/shared": minor
"@polyrouter/data-plane": minor
"@polyrouter/control-plane": minor
"@polyrouter/frontend": minor
---

**Workload targets (Epic W, W-2).** An `auto_workload` routing rule binds ONE workload class (`code` / `vision` / `structured`; `research` / `writing` reserved for the semantic source) to a `tier:` or `model:` target. An `auto` request whose Layer-1 workload verdict carries that class is CLAIMED before band targets, Layer 2, and the cascade — served by the target's chain with `decision_layer = workload`, the band verdict still recorded but never acted on. Unset / unresolvable / empty targets and `none` leave routing byte-identical; explicit models and the tier header still win; any stage fault degrades to the unclaimed flow. New `routing_rule.workload_class` column + CHECKs (migration 0027); rule CRUD validates the class/type pairing; `GET /api/analytics/auto` adds `workloadMix.classes[].routed` and the listing filter accepts `layer=workload`; the Routing page gains a **Workload targets** card and the Auto-performance card shows routed counts with a band-figure disclosure; the inspector marks routed rows.
