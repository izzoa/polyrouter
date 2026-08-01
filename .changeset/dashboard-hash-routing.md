---
'@polyrouter/frontend': minor
---

Dashboard pages are now addressable by URL. Each page has a `#/<page>`
fragment, so pages can be bookmarked, the browser's Back/Forward buttons move
along the page axis, and a link from outside the product can open a specific
page. An unrecognized fragment falls back to the default page as before.

Authorization is unchanged and now enforced on the route itself: the
admin-only Users area cannot be reached by URL as a non-admin — the requested
page is held until the session resolves, then admitted only if permitted. The
accept-invite link flow is untouched; its token fragment is never parsed as a
page nor written to history.
