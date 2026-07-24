---
'@polyrouter/frontend': minor
'@polyrouter/control-plane': minor
---

The dashboard now receives live updates over a **push stream** instead of only asking.
One multiplexed, session-guarded, owner-scoped SSE endpoint (`GET /api/events`) carries
in-flight presence as data and analytics staleness as a thin nudge, so an in-flight
request appears the moment it starts and its handoff to the completed row happens on an
explicit `settled` event rather than being inferred from a row's absence in a later poll.

Polling remains the reliable core: if the stream can't be established, is refused, drops,
is buffered by a proxy, or the browser has no `EventSource`, the dashboard falls back to
its normal refresh and keeps working — and says **Polling** rather than **Live**, so a
buffered deployment is visible instead of silently frozen.

Push can never cost more than the polling it supplements: nudges are coalesced server-side
and share one refresh budget with the analytics poll (a nudge consumes the next scheduled
poll rather than adding to it), so a burst of thousands of settled requests cannot turn
into a query storm, while an idle instance adds no queries at all.

Operationally: dashboard streams are closed immediately at shutdown and never wait on the
inference drain (restarts stay fast), new streams are refused while draining, per-connection
queues are bounded and collapse to a resync rather than buffering for a slow client,
concurrent streams are capped per owner, and authorization is revalidated for the life of
each stream so disabling a user cuts this plane too. New env: `EVENTS_ENABLED`,
`EVENTS_HEARTBEAT_MS` (plus reconciliation/cap/queue/coalesce knobs, all defaulted).
Reverse proxies must not buffer `/api/events` — see the README operations note.
