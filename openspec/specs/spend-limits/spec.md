# spend-limits Specification

## Purpose
TBD - created by archiving change add-spend-limits. Update Purpose after archive.
## Requirements
### Requirement: Owner-scoped budget CRUD

The system SHALL provide owner-scoped CRUD for budgets (`/api/budgets`, session-guarded): a budget has a `name`, `scope` (`global` or `agent`, with an `agentId` required for `agent` scope), `window` (`day`/`week`/`month`), `action` (`alert` or `block`), an `amount` (USD threshold > 0), the notification channel ids that fire on alert, and `enabled`. Every access SHALL be ownership-scoped (invariant 5) — no budget is fetched or mutated by id without an owner guard. Org-scoped budgets are deferred.

#### Scenario: Budgets are tenant-isolated

- WHEN user B lists, reads, updates, or deletes user A's budget by id
- THEN the request is rejected/empty (404 on by-id) and A's budget is unchanged

#### Scenario: An agent-scoped budget requires an agent

- WHEN a budget is created with `scope='agent'` and no `agentId` (or `amount <= 0`, or an unknown enum)
- THEN the create is rejected (422) and no budget is stored

### Requirement: Block budgets reject over-budget requests, correct across instances

The system SHALL track spend per (owner, scope, window period) in an **atomic Redis counter** (invariant 10) that is **reconciled from the request log by a single writer** (the scheduler `SET`s it to the authoritative both-ledger period sum each interval — the request log is the source of truth), and SHALL evaluate `action='block'` budgets **in the proxy request path** before the upstream call: if the applicable counter is at or over the budget's `amount`, the request is rejected with a clear budget-exceeded error (naming the budget and its reset) and no upstream call is made. Because the counter is shared in Redis, the threshold SHALL be enforced on **combined** spend across all proxy instances (no per-instance drift). Counters reset at the window boundary (the period is part of the key).

#### Scenario: Combined spend across instances stops new requests

- WHEN two proxy instances share one Redis and the combined spend for a scope crosses a `block` budget's amount
- THEN subsequent requests for that scope (on either instance) are rejected with the budget-exceeded error until the window resets, and no upstream provider call is made for a rejected request

#### Scenario: A streaming request is blocked cleanly pre-commit

- WHEN a streaming request is over a `block` budget
- THEN it is rejected before the first byte (a clean protocol error), never a mid-stream failure

#### Scenario: An under-budget request proceeds and its spend is reconciled

- WHEN a request is under all applicable `block` budgets
- THEN it proceeds, and after its request-log rows are visible and the next reconciliation runs, its authoritative cost (served plus any cascade attempt) is reflected in the applicable counters, so subsequent requests see the updated spend

### Requirement: The budget check is bounded with a named fail mode, including stale reconciliation

Evaluating budgets MUST NOT add meaningful latency to, stall, or hang a proxy request beyond the enforcement decision itself (invariant 11): the block-check Redis read is bounded (a fail-fast dedicated connection + command timeout). On a Redis fault/timeout, a cold-cache DB failure, **or a stale/absent reconciliation heartbeat** (the scheduler stopped/disabled while Redis is healthy — so the counters are no longer trustworthy), the behavior is a **named, configurable contract** — **fail-open** (allow; the default, favoring availability) or **fail-closed** (reject block-budget requests with a `503 budget_enforcement_unavailable`) — never reject-all-silently or hang, and never silently ignore enforcement because the counter reads zero. Every such fault SHALL be **observable, not swallowed**: the engaged fail mode is metered (a `budget_enforcement_faults_total{mode}` counter, incremented on every fault) and logged (a warn naming the mode and error class — never the error message, which could carry data — rate-limited to avoid a log flood under a sustained outage), so an instance silently running degraded is visible to an operator. The reconcile scheduler's counter writes — the monotonic reconcile, the heartbeat stamp, AND the scheduler's own alert-dedup marker (which the occurrence awaits before stamping the heartbeat) — SHALL use a **separate connection with a generous command timeout**, distinct from the 50ms fail-fast hot-path connection, so a slow-but-healthy Redis (RTT near/above the hot-path bound) still completes the reconcile and stamps the heartbeat instead of leaving enforcement stale. The hot-path block-notification dedup marker (fire-and-forget from the block check) SHALL stay on the fail-fast connection. The scheduler's alert-dedup marker is **best-effort** and not required for counter correctness: a marker fault SHALL be contained (logged) and SHALL NOT abort the reconcile occurrence or skip the heartbeat stamp, so a failing alert never degrades block enforcement. Emitting budget events SHALL be fire-and-forget off the response path — a failing notification channel or a Redis fault never blocks a request or block-enforcement.

#### Scenario: A Redis fault resolves per the configured fail mode, never hanging

- WHEN Redis is unavailable/slow during the budget check
- THEN the bounded check returns within its deadline and the request is either allowed (fail-open, default) or rejected with `503 budget_enforcement_unavailable` (fail-closed) per configuration — it never hangs

#### Scenario: An enforcement fault is logged and metered, not silently swallowed

- WHEN the budget check faults (Redis fault/timeout, cold-cache DB failure, or a stale heartbeat) under the default fail-open and the request is admitted
- THEN a `budget_enforcement_faults_total{mode="open"}` metric is incremented and a rate-limited warn (naming the mode and error class) is logged, so the degraded enforcement is visible even though the request was allowed

#### Scenario: A stopped scheduler does not silently disable block enforcement

- WHEN the reconciliation scheduler is stopped/disabled/failing while Redis stays healthy (so counters are stale/absent, reading zero)
- THEN block budgets are treated as enforcement-unavailable and routed through the named fail mode (fail-closed rejects with `503`), not silently allowed as under-budget

#### Scenario: A slow-but-healthy Redis still stamps the reconcile heartbeat

- WHEN Redis command RTT is above the 50ms hot-path bound but well within seconds (e.g. a managed Redis or an AOF fsync stall)
- THEN the reconcile occurrence still completes and stamps the heartbeat on its generous-timeout connection (enforcement stays available), while the hot-path block-check read still rejects within its 50ms bound

#### Scenario: A failing alert-dedup marker does not abort reconciliation

- WHEN the scheduler's alert-dedup marker faults during an occurrence (e.g. that key errors)
- THEN the occurrence still reconciles the counters and stamps the heartbeat (block enforcement stays available); only the alert emission is skipped, and the marker fault is logged

#### Scenario: The reconcile scheduler's job records stay bounded

- WHEN the per-minute reconcile scheduler runs many occurrences
- THEN its completed/failed BullMQ job records are retention-bounded (removed by age), not accumulated forever in the enforcement Redis

#### Scenario: A failing channel never blocks enforcement

- WHEN a budget is over a `block` threshold but its notification channel is broken/slow
- THEN the request is still rejected promptly (the block decision doesn't wait on the notification), and the `budget_block` emit is fire-and-forget

### Requirement: Enforcement is a postpaid soft cap over resetting calendar windows

The system SHALL meter spend from the request log (a postpaid soft cap): a `block` budget stops *new* requests once the reconciled shared counter crosses the threshold, and requests admitted before the crossing is reconciled MAY overshoot (a pre-authorized hard cap is out of scope). Windows are **UTC calendar periods** (`day`/`week`/`month`) whose counter **resets at the boundary** (a new period starts at zero). The counter reflects the request's **authoritative immutable cost** (the value recorded on the request log — invariant 4), not a proxy-side re-estimate.

#### Scenario: Admitted requests may overshoot, but subsequent requests are stopped

- WHEN a budget is near its threshold and requests are admitted before the crossing is reconciled
- THEN those requests complete (overshooting), their cost is reconciled onto the counter at the next reconciliation, and subsequent requests for that scope are then rejected (metering is asynchronous, so enforcement of the crossing is eventually-consistent within the reconcile interval)

#### Scenario: The counter resets at the window boundary

- WHEN a `day` budget's window rolls over to the next UTC day
- THEN the new period's counter starts at zero and previously-blocked requests are admitted again

### Requirement: Alerts fire on a schedule, at most once per budget per period

The system SHALL evaluate `action='alert'` budgets on a schedule (once per occurrence across instances) against the live counter (reconciled from the request log) and emit `budget_alert` when an alert budget is at/over its amount — **at most one `budget_alert` emitted per budget per window period** (deduped by an atomic Redis marker keyed to the period; delivery itself is the notification pipeline's async best-effort). A `budget_block` SHALL be emitted the first time a block engages in a period (likewise deduped). Both carry the budget name and spend/threshold for rendering, are owner-scoped, and are targeted to the budget's configured notification channels.

#### Scenario: A budget hovering at threshold alerts once per period

- WHEN an alert budget stays at/over its amount across several scheduler runs within one window period
- THEN at most one `budget_alert` is emitted for that budget for that period (a new period can alert again)

#### Scenario: Spend is reconciled against the request log

- WHEN the Redis counter is lost (flush/restart) while request-log rows for the period exist
- THEN the scheduled reconciliation recomputes the counter from the request log (both the served and cascade-attempt cost ledgers) so enforcement and alerts self-heal to the authoritative spend

