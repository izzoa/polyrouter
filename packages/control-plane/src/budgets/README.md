# Recorded budget progress

Limits shows recorded progress for each budget, independently of enforcement. The
graph covers its full UTC calendar period: midnight for days, Monday midnight for
ISO weeks, and the first of the month for months. Creating a budget mid-period
includes earlier recorded spend in that period. The accent line stops at the
snapshot; its neutral dashed ceiling extends to reset. An overage expands the
vertical scale and can exceed 100%.

`cash` includes cash and unknown provider-kind snapshots; `notional` also includes
subscription usage valued at API prices. Neither basis recomputes historical cost.
Estimated usage/pricing, unclassified spend, and unpriced metered activity remain
visible even when a monetary total is zero. Unavailable data has no fabricated zero
balance, and a failed same-period refresh retains its original timestamp. Data older
than 45 seconds is stale; expired-period balances disappear while awaiting refresh.
Create, edit and delete remain usable while progress is unavailable.

## API

`GET /api/budgets/progress?ids=budget-a,budget-b` requires a dashboard session and
returns `Cache-Control: no-store`. Agent API keys do not authorize it. The only query
field is `ids`: 1–20 distinct comma-separated identifiers, trimmed, with at most
128 characters per identifier. Missing/empty/duplicate/oversized inputs or additional
query fields return 400. The literal route precedes the existing `/:id` route.

The response is `{ asOf, results }`, in requested order. `asOf` comes from the database
transaction. An absent or foreign identifier returns exactly
`{ "id": "budget-b", "availability": "not_found" }`; there is no ownership disclosure.
Available results follow `AvailableBudgetProgress` in `@polyrouter/shared`:

```json
{
  "asOf": "2026-10-08T00:15:00.000Z",
  "results": [
    {
      "id": "budget-a",
      "availability": "available",
      "budget": {
        "id": "budget-a",
        "name": "Daily cap",
        "scope": "agent",
        "agentId": "agent-a",
        "window": "day",
        "action": "block",
        "meteringBasis": "cash",
        "amount": 25,
        "notifyChannelIds": [],
        "enabled": true,
        "createdAt": "2026-10-08T00:10:00.000Z"
      },
      "period": {
        "id": "2026-10-08",
        "start": "2026-10-08T00:00:00.000Z",
        "end": "2026-10-09T00:00:00.000Z"
      },
      "bucketSeconds": 900,
      "amountMicros": 25000000,
      "spentMicros": 12400000,
      "remainingMicros": 12600000,
      "overspendMicros": 0,
      "usedPercent": 49.6,
      "pendingMicros": 3000000,
      "availableMicros": 9600000,
      "provenance": {
        "meteredRows": 4,
        "unpricedRows": 0,
        "unknownSpendMicros": 0,
        "usageEstimated": false,
        "priceEstimated": false
      },
      "points": [
        { "at": "2026-10-08T00:00:00.000Z", "spentMicros": 0 },
        { "at": "2026-10-08T00:15:00.000Z", "spentMicros": 12400000 }
      ]
    }
  ]
}
```

Points start at zero at period
start, carry cumulative values through elapsed buckets, and end exactly at `asOf`
with `spentMicros`. There are no future spend points or duplicate times. Buckets are
900 seconds for days, 3600 for weeks and 86400 for months, with at most 170 points.

Money is integer micro-dollars. Both served requests and cascade attempts are summed
separately using the shared per-row `round(cost × 1e6)` expression and their own
owner/time predicates. Agent attempt attribution also scopes the parent request.
Null cost contributes zero money but increments `unpricedRows`; priced zero does not.
Provider-kind and price/usage provenance are immutable ledger fields; current models,
providers and catalog prices are never joined. Threshold rounding uses the existing
budget helper. A positive configuration below half a micro-dollar has an effective
zero threshold and `usedPercent: null`, without altering budget validation.

Remaining is `max(0, amountMicros - spentMicros)`; overage is the inverse positive
difference. Percentage is uncapped. Pending sums finite ceilings of non-terminal
owner/agent batches (including `submitting`) submitted in `[periodStart, asOf)`.
Previous-period and null ceilings contribute nothing. During partial settlement,
durable costs coexist with the full live ceiling; terminal jobs release that ceiling.
Both metering bases use that same reservation population. Enabled block budgets show
`max(0, amountMicros - spentMicros - pendingMicros)` available; alert/disabled budgets
return null availability. Pending is never plotted as recorded spend.

## Snapshot, failure and query work

The principal-scoped `PersistencePort.budgetProgress.read` owns one **read-only
repeatable-read** transaction. Safe configuration, both ledgers, provenance and pending
ceilings share that snapshot. Identical scope/agent/window/basis groups reuse their
aggregates; thresholds/actions remain independently calculated for each budget.
The surface exports no SQL handle, caller-selected owner or maintenance token.

Connection checkout, transaction work, statement/lock waits and release share a
three-second deadline. Each work stage sets remaining LOCAL statement/lock timeouts;
faults destroy the connection and its transaction. A late checkout is returned
immediately without starting work. Database faults or timeouts return sanitized
`503 { code: "budget_progress_unavailable", message: "Budget progress is temporarily unavailable" }`.
No successful figures accompany the error. The accessor invokes no Redis, provider,
notification or write operation, and inference never awaits it. Redis degradation
does not prevent a database snapshot; progress says nothing about Redis health or
the outcome of the next admission check. Postpaid costs, reconciliation and already
admitted work can exceed a cap.

The 20-id bound gives at most three aggregate queries per distinct group (two ledgers
and pending), returning grouped buckets rather than individual ledger rows. Existing
`request_log_owner_created_idx` and `request_attempt_owner_created_idx` support selective
owner/time windows; PostgreSQL may prefer owner-only or owner/agent bitmap access for
periods covering most owner rows, and parent lookups for agent attempts. No index,
migration or dependency was added. The real PostgreSQL e2e plan fixture uses 120,000
current-month rows in **each** ledger, 20,000 for the current owner, and verifies indexed
access, 40 ledger aggregates for 20 distinct groups versus two for 20 shared-group cards.
On the isolated local PostgreSQL 16 run, these full reads took approximately 422ms and
33ms respectively; these are fixture measurements, not a deployment SLA. Lock and
pool-exhaustion tests verify the failure deadline and later successful reads.

The SPA reads sequential chunks of 20 with one outstanding request, a shared
15-second poll/nudge floor, and one coalesced forced catch-up. Hidden/off-page views
start no scheduled work. Configuration fingerprints plus identity/navigation/mutation
generations discard obsolete replies. Missing or changed configuration triggers one
owner-scoped reconciliation per cycle; server-relative monotonic age handles clock
skew and UTC resets. Newer snapshots replace matching cards without changing counters.
