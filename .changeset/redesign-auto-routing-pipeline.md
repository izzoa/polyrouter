---
'@polyrouter/shared': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

The Routing page is organized around the order the proxy runs

The Routing page is now two tabs. **Tiers & headers**, where a visit lands, holds the
tier chains and the header rules. **Auto routing** is full width and replaces the
rail's Auto / Tuning / Rules sections with a numbered pipeline in proxy order:
Classify (L1), Workload claim, Confident band, Semantic (L2), Cascade (L3), and
Default. Each stage shows its layer switch where it has one, how many requests it
routed, and a one-line setup summary. Its details hold the content of the old Auto
performance, self-calibration, and semantic learning cards, with all of their
controls. A focal summary sets the cascade savings estimate, labelled as covering
the residual cascade only, beside a bar of per-stage exits.

A **Targets matrix** replaces the Band targets and Workload targets cards and the
per-workload class picker. It shows every band and workload target at once: one row
for any request and one per workload class, with Claim, Strong, Cheap, and Detected
columns. Inherited and claimed cells say so in text.

The measured figures now have designed loading, failure, and zero-traffic states,
and a failed load can be retried. Configuration controls never wait on the
aggregation, and the layer switches no longer read as off while the layer view is
still loading.

`GET /api/analytics/auto` gains `exits`: disjoint per-stage counts of evaluated
`auto` requests (`workload`, `structural`, `semantic`, `cascade`, `default`) that
sum to `evaluated`. Every existing figure is unchanged. Routing behavior is
unchanged, and there is no migration.
