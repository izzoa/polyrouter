---
'@polyrouter/frontend': patch
---

Fixed: token counts wrapped to two lines in the requests table once real traffic arrived. At
production magnitudes "87.2k in / 1.5k out" is wider than the column, so most rows rendered as
two lines. Tokens now read `87.2k↑ 1.5k↓` — the same information in two thirds of the width,
with the in/out wording kept for screen readers. The Tokens figure on the Overview does the
same; it was wrapping at phone widths for the same reason.
