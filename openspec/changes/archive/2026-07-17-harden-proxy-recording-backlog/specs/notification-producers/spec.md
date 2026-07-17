## MODIFIED Requirements

### Requirement: A scheduled weekly job emits per-owner spend summaries

The system SHALL provide a scheduled (opt-in) job that, once per configured period regardless of the number of running instances, aggregates each owner's total spend over the past week from **both cost ledgers** (the request log and cascade request-attempts) and emits one `weekly_spend_summary` per owner (carrying that owner's total). The aggregate is a system-level rollup exposed through a **narrow, scheduler-only** reader (not the general persistence seam); its output SHALL be partitioned per owner so that no owner's summary contains another owner's spend (invariant 5). The per-owner total SHALL be aggregated in **integer micro-dollars — `Σ round(cost × 1e6)` per row, converted to dollars once** — the identical arithmetic the budget-enforcement and analytics readers use, so a week's summary reconciles exactly with the dashboard and budget figures rather than diverging at the sub-µ$ margin a raw float `sum(cost)` would introduce. The scheduler's produced job records SHALL be **retention-bounded** (completed/failed jobs removed by age) so they do not accumulate unbounded in Redis. The job SHALL **retry a transient failure** (bounded `attempts` with backoff): because each owner's summary emit is keyed by the occurrence and deduplicated, a retry cannot double-send, so a single DB/Redis blip during a run must not silently drop the whole period's summaries.

#### Scenario: The weekly job emits each owner only their own total

- WHEN the weekly summary job runs with two owners A and B who each had spend in the period
- THEN A receives a `weekly_spend_summary` whose total reflects only A's requests, B receives one reflecting only B's, and neither total includes the other's spend

#### Scenario: The weekly total reconciles with the budget/analytics readers

- WHEN an owner's spend over the week is aggregated for the summary
- THEN the total is computed as `Σ round(cost × 1e6)` over both ledgers converted to dollars once — the same micro-dollar aggregation the budget and analytics readers use — so the summarized figure equals those readers' figures for the same window (no sub-µ$ float drift)

#### Scenario: An occurrence yields one summary per owner regardless of instances or re-runs

- WHEN multiple app instances share one Redis and the scheduled occurrence fires (and even if a stalled job re-runs OR a transient failure triggers a bounded retry)
- THEN each owner receives one `weekly_spend_summary` for that occurrence (not one per instance, per re-run, or per retry attempt), because emits are keyed by the occurrence and deduplicated

#### Scenario: Scheduler registration never blocks boot

- WHEN Redis is unavailable at startup (with the weekly summary enabled or disabled)
- THEN the application still boots (scheduler reconciliation is fail-open and retried in the background); Layer 0 is not gated on it

#### Scenario: The weekly scheduler's job records stay bounded

- WHEN the weekly summary scheduler produces jobs over many occurrences
- THEN its completed/failed BullMQ job records are retention-bounded (removed by age), not accumulated forever in Redis
