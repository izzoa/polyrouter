---
'@polyrouter/frontend': patch
---

Fixed: a dozen small symbols in the interface — the copy, close, chevron, drag-handle and
escalation marks, the chart legend keys and the status dot — were text characters the bundled
Geist fonts do not contain, so each was drawn with whatever symbol font the viewer's operating
system happened to supply. The same control looked different on macOS, Linux and Windows. They
are now inline vector icons from one registry, or styled elements where the mark is just a
coloured shape, so the dashboard renders the same everywhere and fetches nothing extra.

Also fixed, found while doing it: an escalated request was marked only by a small decorative
arrow, so screen readers never announced escalation at all, and a completed setup step was
indicated by a checkmark and a green ring with no text equivalent. Both states now carry
accessible text.
