---
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

Each request records how every leg of its route ended, and the Route Trace draws it

A routed request now records, per leg it walked (`primary`, or `cheap` then `escalation`), why the leg ended (`served`, `gate_failed`, `replay_failed`, `exhausted`, `stopped`, `deadline` or `cancelled`), when (milliseconds from the request's start), the member that stopped it (including the member a client's cancel caught in flight), and the capability and output-cap deferrals and clamps that until now lived only in the routing reason. The Route Trace draws it: a spine row per deferred member (`deferred · <model> · lacks vision`, `· output cap 4,096 < 100,000 asked`), the cap on a clamped call (`output capped at 4,096`), the member that stopped a walk (a non-retryable stop in the failure red, a cancel's in-flight member as a neutral `in flight` branch), and the escalation's recorded cause and time (`escalation · cheap deadline · at 30.02s`). A cancelled request now keeps the attempt trail it walked. A member the cheap deadline or a client's cancel cut off now ends its walk at once, before or after its response headers; routing, status, cost and billing are unchanged. API: the request listing adds `routeLegs`, and `attemptFailures` can now be non-null on a `cancelled` row. Three narrow routing-reason changes: a clamp on a member that stopped the walk now appears in the capacity note; a cancelled row no longer lists the member the cancel cut off as `unavailable@<model>`; a leg that dispatched no member no longer carries a deferral note. Migration 0048 adds the nullable `request_log.route_legs` column; rows recorded earlier are not backfilled and read as before.
