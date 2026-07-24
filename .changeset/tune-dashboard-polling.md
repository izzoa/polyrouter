---
'@polyrouter/frontend': patch
---

The dashboard no longer polls while its tab is hidden, and refreshes immediately when
you come back. Every recurring poller (Overview analytics + live in-flight rows, Costs
analytics) is now gated on document visibility as well as page scope, so a backgrounded
tab costs nothing instead of ~40 requests/min forever; on return each poller performs
exactly one catch-up fetch, so the view is never stale. The live in-flight poll also
relaxes from 2.5 s to 5 s while there is provably nothing in flight and snaps straight
back on the first live row, leaving the settle handoff at full speed. Measured on an
idle, visible Overview: 28 requests/min, down from 40; hidden: zero.

Two correctness fixes fall out of the same rewiring. Pollers are now **single-flight** —
a pending fetch is never overlapped (a resume or elapsed interval defers to exactly one
trailing catch-up), because the in-flight loader applies every response unconditionally
and out-of-order snapshots could otherwise falsely settle a live row. And live-view state
is now **identity-scoped**: the in-flight loader discards a response captured under a
previous account, and an account change — including a mid-session session expiry —
clears cached live rows and invalidates the in-flight durable refresh, so one account's
rows can never appear under another's.
