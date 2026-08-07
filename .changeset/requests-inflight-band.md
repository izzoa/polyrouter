---
'@polyrouter/frontend': minor
---

The Requests page now shows requests as they run, the way the Overview card does.

Until now the page only ever showed finished requests — and, less obviously, only the ones
that had finished before you opened it. Its window is frozen at the moment of load, so a
request settling while you watched could never appear in the list, however long you waited.

Running requests are now rendered above the completed rows, from the same shared live set
the Overview card reads. They are deduped against the rows that page is actually showing,
which matters more than it sounds: a request that has just settled lingers briefly while its
durable row is written, and arriving at the page during that moment re-freezes the window to
include it — without the dedupe the same request would appear twice.

The band respects the page's filters where it honestly can. Explicit and Auto select on the
routing decision, which is known the moment a request is admitted, so those work. Fallbacks
and Escalated depend on how a request *ends*, which a running one has not done — so the band
empties rather than guessing at rows that might not match once they settle. Both use the
same filter mapping the completed list uses, so the two can never disagree about what "auto"
means.

Nothing about the paginated list changes: its window, its cursor and "Load more" behave
exactly as before, and the band never inserts into it.

Also fixes a latent ordering bug in the shared live-request state. A snapshot still in
flight could previously land after newer state and overwrite it — settling a request that
had only just started, or resurrecting one that had finished. It now loses to any newer
update, whether that came from another fetch or from the event stream.
