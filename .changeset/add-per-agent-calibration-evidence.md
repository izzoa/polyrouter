---
'@polyrouter/control-plane': minor
'@polyrouter/shared': minor
'@polyrouter/frontend': minor
---

The Auto-performance view now shows, per agent, the edge-zone evidence the
threshold calibrator actually consumes — computed from the calibrator's own
predicates so the instrument cannot drift from what it measures. Each edge
reports both epoch views, its failure rate against the decision rate, and the
count of decided rows sitting between the zones, so a pair of zeros is
interpretable rather than alarming.
