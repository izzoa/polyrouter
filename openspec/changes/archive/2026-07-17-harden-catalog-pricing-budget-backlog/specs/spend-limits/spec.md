## MODIFIED Requirements

### Requirement: The budget check is bounded with a named fail mode, including stale reconciliation

Evaluating budgets MUST NOT add meaningful latency to, stall, or hang a proxy request beyond the enforcement decision itself (invariant 11): the block-check Redis read is bounded (a fail-fast dedicated connection + command timeout). On a Redis fault/timeout, a cold-cache DB failure, **or a stale/absent reconciliation heartbeat** (the scheduler stopped/disabled while Redis is healthy — so the counters are no longer trustworthy), the behavior is a **named, configurable contract** — **fail-open** (allow; the default, favoring availability) or **fail-closed** (reject block-budget requests with a `503 budget_enforcement_unavailable`) — never reject-all-silently or hang, and never silently ignore enforcement because the counter reads zero. Every such fault SHALL be **observable, not swallowed**: the engaged fail mode is metered (a `budget_enforcement_faults_total{mode}` counter, incremented on every fault) and logged (a warn naming the mode and error class — never the error message, which could carry data — rate-limited to avoid a log flood under a sustained outage), so an instance silently running degraded is visible to an operator. The reconcile scheduler's counter writes — the monotonic reconcile, the heartbeat stamp, AND the scheduler's own alert-dedup marker (which the occurrence awaits before stamping the heartbeat) — SHALL use a **separate connection with a generous command timeout**, distinct from the 50ms fail-fast hot-path connection, so a slow-but-healthy Redis (RTT near/above the hot-path bound) still completes the reconcile and stamps the heartbeat instead of leaving enforcement stale. The hot-path block-notification dedup marker (fire-and-forget from the block check) SHALL stay on the fail-fast connection. The scheduler's alert-dedup marker is **best-effort** and not required for counter correctness: a marker fault SHALL be contained (logged) and SHALL NOT abort the reconcile occurrence or skip the heartbeat stamp, so a failing alert never degrades block enforcement. Emitting budget events SHALL be fire-and-forget off the response path — a failing notification channel or a Redis fault never blocks a request or block-enforcement.

The staleness bound and the reconcile schedule SHALL be **consistent**: because a heartbeat older than the staleness bound routes enforcement through the fail mode, a staleness bound shorter than the schedule's fire gap would leave a **healthy** scheduler perpetually stale (every heartbeat expires before the next run), silently degrading enforcement to the fail mode full-time. The system SHALL therefore validate the two against each other **at configuration time**, when the reconcile scheduler is enabled: it SHALL walk the schedule's upcoming fire times (a bounded window of real occurrences, so every cron form is handled by its actual schedule) and **fail-fast at boot** (a clear configuration error, not a silent degradation) on the first inter-fire gap that exceeds the staleness bound less a safety margin (one reconcile period, so a single missed run cannot expire the heartbeat). This catches the common misconfiguration — a long uniform period (e.g. an hourly cron) paired with a too-short bound — exactly, and realistic overnight/weekend/month-boundary gaps within the window; it is best-effort for a pathological schedule that both fires sub-hourly and restricts its hours/days (not a sensible continuous-reconcile cron). A disabled scheduler is exempt (its stale-always state is the intended "no enforcement engine" configuration, resolved by the fail mode).

The per-owner budget cache that backs the hot-path check SHALL distinguish a **cold miss** from a **refresh of a still-cached owner**: a load error on a cold miss (no prior entry) SHALL propagate so the caller engages the named fail mode, whereas a load error while a (now-stale) entry is still present SHALL serve that stale entry rather than fail the request. The cache SHALL be short-TTL, capped with LRU eviction, single-flight per owner (concurrent misses share one load), and invalidated on every budget write.

#### Scenario: A Redis fault resolves per the configured fail mode, never hanging

- WHEN Redis is unavailable/slow during the budget check
- THEN the bounded check returns within its deadline and the request is either allowed (fail-open, default) or rejected with `503 budget_enforcement_unavailable` (fail-closed) per configuration — it never hangs

#### Scenario: An enforcement fault is logged and metered, not silently swallowed

- WHEN the budget check faults (Redis fault/timeout, cold-cache DB failure, or a stale heartbeat) under the default fail-open and the request is admitted
- THEN a `budget_enforcement_faults_total{mode="open"}` metric is incremented and a rate-limited warn (naming the mode and error class) is logged, so the degraded enforcement is visible even though the request was allowed

#### Scenario: A stopped scheduler does not silently disable block enforcement

- WHEN the reconciliation scheduler is stopped/disabled/failing while Redis stays healthy (so counters are stale/absent, reading zero)
- THEN block budgets are treated as enforcement-unavailable and routed through the named fail mode (fail-closed rejects with `503`), not silently allowed as under-budget

#### Scenario: A staleness bound shorter than the reconcile interval is rejected at boot

- WHEN the reconcile scheduler is enabled and the staleness bound is configured shorter than (a safety margin above) the cron's fire interval (e.g. an hourly cron with the few-minute default)
- THEN configuration fails-fast with a clear error at boot, rather than booting into a state where every heartbeat is stale and enforcement silently runs in the fail mode
- AND the shipped defaults (a per-minute cron with a multi-minute staleness bound) pass, and a disabled scheduler skips the check

#### Scenario: The budget cache serves stale on a refresh error but propagates a cold miss

- WHEN the budget cache's DB load fails while a prior (now-stale) entry for that owner is still cached
- THEN the stale entry is served (the request is not failed on a transient DB blip)
- WHEN the DB load fails on a cold miss (no prior entry for that owner)
- THEN the error propagates so the caller engages the named fail mode (never a silent empty budget list read as under-budget)

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
