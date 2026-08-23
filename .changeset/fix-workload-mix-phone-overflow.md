---
"@polyrouter/frontend": patch
---

**Workload-mix rows stay inside the pane at phone width.** The Auto-performance "Workload mix" rows (Epic W) pushed their spend labels past the content pane at the 320px reflow width, failing the responsive browser gate on the v0.15.0 commit. The v0.15.0 image build itself succeeded, so both published image variants ship this frontend regression — it reaches users only through a later release. Each row now reflows below the narrow threshold through the existing `rs-wrap` rule, so every field — class, share, requests, routed count, spend, and the `unpriced` / `N unpriced` honesty qualifiers — stays visible and unclipped; desktop rendering is unchanged.
