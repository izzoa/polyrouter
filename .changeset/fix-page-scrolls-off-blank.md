---
'@polyrouter/frontend': patch
---

The dashboard no longer scrolls off a blank page

Scrolling over the top bar on Overview or Requests could lift the whole dashboard and leave the bottom of the window blank. Text that only screen readers hear, in the request tables' token cells, made the page taller than the window. That text now stays inside the scrolling content, so the page itself never scrolls.
