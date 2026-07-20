---
'@polyrouter/frontend': patch
---

Fix the Band-targets picker showing "default" while nothing is chosen: the
placeholder option is now pinned as the select's resting state (at first
render and after every apply) — the row's target line, not the picker, is
what displays the current target.
