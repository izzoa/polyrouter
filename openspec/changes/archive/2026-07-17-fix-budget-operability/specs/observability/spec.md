## MODIFIED Requirements

### Requirement: A Prometheus metrics endpoint exposes proxy health per provider, model, and routing layer

The instance SHALL expose `GET /metrics` (Prometheus text format, session-free like `/health`, gated by `METRICS_ENABLED` default on → 404 when off) with instance-level, bounded-cardinality series prefixed `polyrouter_`:

- `requests_total` and a duration histogram labeled `{protocol, decision_layer, status}` — counting **recorder-finalized inference requests exactly once each** (pre-routing rejections such as auth failures and budget blocks are excluded by definition; cascade attempt-ledger rows never increment it), emitted at enqueue time so traffic stays visible during a database outage.
- `tokens_total{provider, model, direction}` — including tokens consumed by superseded cascade cheap attempts.
- `cost_microusd_total{provider, model}` — incremented from the authoritative snapshot cost the log writer computed, **exactly once per row and only after its batch insert succeeds** (writer retries never re-emit; dropped rows emit no cost; unpriced rows emit nothing), in micro-USD (`round(cost × 1e6)`); never recomputed from current prices.
- `upstream_requests_total{provider, model, outcome}` (success | error | canceled) and an upstream duration histogram — where a streamed upstream that yields an error event or ends without a terminal event counts as error, and a consumer abort counts as canceled; plus `upstream_setup_failures_total{provider}` for chain members that failed before any upstream call (per-provider error attribution covers both phases).
- `breaker_state{provider}` gauge (closed 0 / half_open 1 / open 2, last-observed at admission time) and `breaker_opens_total{provider}` transition counts.
- `budget_enforcement_faults_total{mode}` — incremented every time the budget check faults and engages its named fail mode (`mode="open"|"closed"`), so an instance silently running degraded enforcement is visible.
- `log_rows_dropped_total` for every row the writer abandons, and Node process metrics.

Labels SHALL never include tenant/agent/request identifiers or message content.

#### Scenario: metrics scrape cleanly after traffic
- **WHEN** an agent completes requests through the proxy, the log writer flushes, and Prometheus scrapes `/metrics`
- **THEN** the scrape returns 200 Prometheus text containing `polyrouter_requests_total` with the request's protocol, decision layer, and status, token and cost counters labeled with the served provider's name and external model id, and request- and upstream-duration histograms

#### Scenario: per-provider error attribution
- **WHEN** a provider fails and a fallback provider serves the request
- **THEN** `polyrouter_upstream_requests_total` shows `outcome="error"` for the failed provider and `outcome="success"` for the serving provider, each under its own provider label

#### Scenario: breaker metrics reflect an opened breaker
- **WHEN** repeated failures trip a provider's circuit breaker and a later request is admitted against it
- **THEN** `polyrouter_breaker_opens_total` counts the transition for that provider and `polyrouter_breaker_state` reports its last-observed state

#### Scenario: cost is emitted exactly once under writer retries
- **WHEN** the writer's first insert attempt for a batch fails transiently and a retry succeeds
- **THEN** `polyrouter_cost_microusd_total` reflects each row's snapshot cost exactly once

#### Scenario: the endpoint honors its kill-switch
- **WHEN** `METRICS_ENABLED=false` and `/metrics` is requested
- **THEN** the response is 404 and no registry is exposed

#### Scenario: request metrics survive a database outage
- **WHEN** the request-log database is unavailable while an agent completes requests
- **THEN** `polyrouter_requests_total` still reflects the traffic (recorded at enqueue time), no cost is emitted for the lost rows, and `polyrouter_log_rows_dropped_total` counts the rows the writer gave up on

#### Scenario: budget enforcement faults are exposed as a counter
- **WHEN** the budget check faults (e.g. its Redis connection is down) and the request is admitted under fail-open
- **THEN** a subsequent `/metrics` scrape contains `polyrouter_budget_enforcement_faults_total` with a `mode` label reflecting the engaged fail mode
