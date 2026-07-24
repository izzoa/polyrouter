---
'@polyrouter/frontend': patch
---

Each primary nav page now has an identifying line-icon in the left-rail nav, carried
into the page header when selected. A single `Record<Page, …>` registry
(`components/PageIcon.tsx`) is the sole source of the glyph, consumed by both the Sidebar
and the Topbar so the two can never drift. Icons are decorative inline SVG (lucide
geometry, `currentColor`) — no icon-library dependency and nothing fetched at runtime; in
the rail they ride the nav button's `text2 → accent-deep` color (no new hue, single-accent
lock preserved) and in the header they sit at a quiet `--text3`. `setup` keeps its rail
progress ring (which encodes progress, not identity) and shows its icon in the header only.
