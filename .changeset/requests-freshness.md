---
'@polyrouter/frontend': minor
---

The Requests page no longer silently goes stale, and a finished request stops saying it is
still running.

The page froze its time window the moment it loaded and nothing ever triggered another
fetch, so a request completing while you watched could never appear — however long you
waited, with nothing on screen saying so. The in-flight band added in the previous release
arguably made that worse: live rows above a frozen list read as "this page is current".

It now refreshes on the same cadence as the Overview page, routed through the shared refresh
budget so a burst of traffic cannot turn into a burst of queries. That only applies while
you have not paged: once you have clicked "Load more", refreshing would throw away the pages
you asked for, so instead the page tells you how many newer requests exist and offers to load
them. Taking the offer returns you to a fresh first page. If that check fails, it says so
rather than quietly implying the list is up to date.

Separately, a request that has just finished no longer displays as "Running" while its
record is being written. It now reads "Finishing" and stops pulsing. That was wrong on the
Overview card too — it was simply harder to notice there, because the handoff usually
completes in well under a second.
