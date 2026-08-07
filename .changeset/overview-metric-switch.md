---
'@polyrouter/frontend': patch
---

Fixed: the Overview's "Spend by model" panel had no metric switch, so the spend/tokens toggle
added in 0.12.0 only worked on the Costs page — even though the panel is the same panel and the
preference is shared. It now offers the switch too, and its heading, empty state and units
follow the selection. Flipping it on either page changes both, which is what a shared
preference should mean.

Also fixed a smaller problem the same panel had: navigating to the Overview after switching to
tokens on Costs briefly rendered the token-ranked models under a "Spend by model" heading —
the right values for the wrong models, with the bars not in descending order — until the
refetch landed.
