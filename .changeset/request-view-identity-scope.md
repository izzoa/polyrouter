---
'@polyrouter/frontend': patch
---

Fixed: one account's request data could remain visible after switching to another.

Signing out and signing in as a different user in the same browser session left parts of the
previous account's Requests page behind. The request list, its cursor and its frozen range
window were never cleared, and a page load or "Load more" already in flight could still
commit afterwards — so the incoming user could be looking at the previous user's requests.

More seriously, the request inspector's selection and its **cached payloads** were not
cleared either. Where prompt/response capture is enabled, that state holds the request and
response text itself — the one category of data polyrouter otherwise refuses to persist. It
is now cleared at the account boundary, along with the list.

The identity boundary also now resets the page's loading and error state, so an account
change landing mid-load leaves the page ready to reload rather than showing a spinner that
never resolves.

Nothing about this was a server-side isolation failure: every response was correctly scoped
to whoever asked for it. The defect was entirely in the client, in what it kept and what it
allowed to commit after the principal changed. The filter selection is deliberately kept —
it is a display preference, not another account's data.
