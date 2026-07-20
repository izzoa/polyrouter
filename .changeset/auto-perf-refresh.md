---
'@polyrouter/frontend': patch
---

The Auto performance card refreshes on every Routing-page visit instead of
freezing at its first fetch (already-loaded numbers stay visible while the
refetch replaces them), and switching its range now triggers the reload from
the range action itself.
