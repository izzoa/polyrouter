---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
---

The dashboard now shows requests that are **running right now**. Until now the
Overview's "Recent requests" card was completed-only — a request stayed invisible
for its entire life (often 7–12s on reasoning models) because the `request_log`
row is written once, at the terminal outcome. An ephemeral, owner-scoped, metadata-
only in-flight registry in Redis now records live presence: the proxy publishes an
entry once the route resolves (naming the model actually executing — the cheap tier
for a cascade) and clears it when the request settles. Live rows render above the
completed rows with a pulsing "Running" status and a latency that ticks client-side,
with `—` for tokens/cost (those values do not exist until settle).

The registry never touches the request path: every write is fire-and-forget, and a
Redis fault — down *or* hung — degrades to exactly the old behavior (no live view)
without inference ever awaiting it. The RequestLog contract is unchanged: nothing is
written to `request_log`, cost stays immutable, and `running` is not a stored status.
The served row's id is now allocated at admission so the live entry and the durable
row share one id, letting the dashboard hand off between them without ever showing a
request twice. `GET /api/analytics/inflight` returns the owner's live snapshot with
`available`/`truncated` completeness flags, so a degraded or capped poll is never
mistaken for "this request finished".
