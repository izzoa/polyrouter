---
'@polyrouter/frontend': patch
---

Fixed: one account's spend figures could remain visible after switching to another.

The same defect as the request-view fix, on a different surface. The Observe pages' summary,
timeseries and cost breakdowns were guarded only against stale *range* replies — the guard
orders responses within one account and cannot see an account change. So signing out and in
as a different user in the same browser session left the previous account's spend totals,
request counts, timeseries and by-model/provider/agent breakdowns on screen, and a response
already in flight could still commit afterwards.

The account boundary now invalidates and clears those figures, and resets their loading and
error state so a mid-load switch cannot latch a spinner. The guard is applied in the shared
slice runner, so every one of those loaders is covered at once rather than each having to
remember.

As with the request-view fix, no server-side isolation failure was involved: every response
was correctly scoped to whoever asked for it. This was about what the client kept and what it
allowed to commit after the principal changed.
