---
'@polyrouter/frontend': patch
---

Fixed: every page's subtitle in the top bar ("last 24 hours", "every routed call, with its
why", …) sat a few pixels below the page title's baseline instead of sharing it. The subtitle
was baseline-aligned against the icon-and-title group, and a flex group exports its first
item's baseline — the icon's, which has no text baseline, so its bottom edge was used. The
title row is now a single flex line: title and subtitle share a real text baseline, and the
icon centers itself exactly where it was before.
