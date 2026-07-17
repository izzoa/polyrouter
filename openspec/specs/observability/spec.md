# observability Specification

## Purpose
TBD - created by archiving change add-observability. Update Purpose after archive.
## Requirements
### Requirement: Proxied inference requests emit a full OTel span chain when tracing is enabled

When `OTEL_ENABLED` is on, every **authenticated inference request** (`/v1/chat/completions`, `/v1/messages`) SHALL produce one trace: a root `proxy.request` span (method, original path, client protocol, response status, ended when the response closes — streaming included) with child spans `auth` (agent-key verification), `routing` (route resolution, carrying `decision_layer`/tier/model attributes), one `upstream` span per attempted chain member (provider name + external model id attributes; error status on a failed attempt; a consumer-aborted stream marked canceled, not error), and `recording.enqueue` (the request-path log enqueue). Requests that exit before a phase (auth failure, budget block, route error, `/v1/models`) SHALL produce a partial chain ending at the failing phase. The durable insert SHALL be traced at the writer as a `recording.write` batch span **linked** to the originating requests' span contexts, with insert give-ups marked. Span attributes SHALL contain no prompt/response content and no credentials (metadata only). When tracing is disabled (the default), the API calls SHALL be no-ops and requests behave identically to before this capability.

#### Scenario: full span chain for a proxied request
- **WHEN** tracing is enabled with an in-memory exporter and an agent completes a request through `/v1/chat/completions`
- **THEN** the exporter holds one `proxy.request` root for the request whose children include `auth`, `routing`, at least one `upstream` (with the served provider's name and external model id), and `recording.enqueue`, all sharing the root's trace id

#### Scenario: the durable write is traced and linked
- **WHEN** tracing is enabled, a request completes, and the log writer flushes
- **THEN** the exporter holds a `recording.write` span carrying a span link to that request's span context

#### Scenario: a failed provider attempt is attributed in the trace
- **WHEN** tracing is enabled and the primary provider fails so a fallback serves the request
- **THEN** the trace contains an `upstream` span for the failed member marked with error status and its provider name, and a second `upstream` span for the member that served

#### Scenario: a streamed request's chain completes; an aborted stream is not an error
- **WHEN** tracing is enabled and an agent streams a completion to the end, and separately a client disconnects mid-stream
- **THEN** the completed stream's `upstream` span ends with success after the final event, and the aborted stream's `upstream` span ends marked canceled (not error) with the root span closed by the connection close

#### Scenario: tracing off is the default and inert
- **WHEN** `OTEL_ENABLED` is unset
- **THEN** no tracer provider is registered, no export ever occurs, and proxied requests behave identically to before this capability

### Requirement: Observability can never change a request outcome

Trace export SHALL be batched and asynchronous; metric emission SHALL be exception-safe in-process counter work only; no observability failure (unreachable collector, a throwing metrics call) SHALL fail, slow, or stall a proxied request or budget enforcement. A malformed registered observability variable — e.g. a non-URL `OTEL_EXPORTER_OTLP_ENDPOINT` or its per-signal override `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` while tracing is enabled — SHALL fail boot fast per the config discipline (both endpoints are registered so a bad value cannot degrade silently at request time), never degrade silently at request time. The production tracing switch — enabling under `OTEL_ENABLED`, registering the OTLP exporter + batch processor, and the graceful-drain flush — SHALL be covered by a regression test that exercises the enabled path against an unreachable collector and asserts requests are unaffected and shutdown flushes cleanly, so a regression in the real switch (throwing, blocking, or failing to register/flush) cannot ship undetected.

#### Scenario: an unreachable collector does not affect requests
- **WHEN** tracing is enabled with a well-formed OTLP endpoint that accepts no connections and an agent sends requests
- **THEN** every request completes exactly as with tracing disabled, with export failures contained to the exporter

#### Scenario: the enabled tracing switch registers, never blocks, and shuts down cleanly

- **WHEN** `initTracing` runs with `OTEL_ENABLED=true` and an OTLP endpoint pointed at a closed port, then work is done inside a span, then `shutdownTracing` is called
- **THEN** `initTracing` registers a recording provider without throwing or blocking, the span-wrapped work completes promptly (not stalled on the dead collector), and `shutdownTracing` resolves (the batch flush is contained); and `initTracing` with `OTEL_ENABLED` unset registers no provider (a no-op)

### Requirement: A Prometheus metrics endpoint exposes proxy health per provider, model, and routing layer

The instance SHALL expose `GET /metrics` (Prometheus text format, session-free like `/health`, gated by `METRICS_ENABLED` default on → 404 when off) with instance-level, bounded-cardinality series prefixed `polyrouter_`:

- `requests_total` and a duration histogram labeled `{protocol, decision_layer, status}` — counting **recorder-finalized inference requests exactly once each** (pre-routing rejections such as auth failures and budget blocks are excluded by definition; cascade attempt-ledger rows never increment it), emitted at enqueue time so traffic stays visible during a database outage.
- `tokens_total{provider, model, direction}` — including tokens consumed by superseded cascade cheap attempts.
- `cost_microusd_total{provider, model}` — incremented from the authoritative snapshot cost the log writer computed, **exactly once per row and only after its batch insert succeeds** (writer retries never re-emit; dropped rows emit no cost; unpriced rows emit nothing), in micro-USD (`round(cost × 1e6)`); never recomputed from current prices.
- `upstream_requests_total{provider, model, outcome}` (success | error | canceled) and an upstream duration histogram **labeled `{provider, model, outcome}`** — where a streamed upstream that yields an error event or ends without a terminal event counts as error, and a consumer abort counts as canceled; the duration histogram carries the same `outcome` so a client-abort (`canceled`) duration — which settles whenever the consumer leaves, not on provider latency — never pollutes the `success` latency quantiles. Plus `upstream_setup_failures_total{provider}` for chain members that failed before any upstream call (per-provider error attribution covers both phases).
- `breaker_state{provider}` gauge (closed 0 / half_open 1 / open 2, last-observed at admission time) and `breaker_opens_total{provider}` transition counts.
- `budget_enforcement_faults_total{mode}` — incremented every time the budget check faults and engages its named fail mode (`mode="open"|"closed"`), so an instance silently running degraded enforcement is visible.
- `log_rows_dropped_total` for every row the writer abandons, and Node process metrics.

Both duration histograms (the end-to-end request histogram and the upstream histogram) SHALL be configured with **explicit LLM-scale buckets spanning sub-second to ten minutes** (not prom-client's defaults, whose largest finite bucket is 10s), because streamed completions routinely run 10s–minutes; with the defaults every such observation would land only in `+Inf` and `histogram_quantile` would report ~10s for all real traffic, making per-provider latency comparison above 10s impossible.

The `provider` label carries the provider's **display name** (a bounded, human-readable value chosen for dashboard legibility); renaming a provider starts a new series and leaves the old name's series to age out — an accepted trade-off (renames are rare) over labeling by an opaque id. Labels SHALL never include tenant/agent/request identifiers or message content.

#### Scenario: metrics scrape cleanly after traffic
- **WHEN** an agent completes requests through the proxy, the log writer flushes, and Prometheus scrapes `/metrics`
- **THEN** the scrape returns 200 Prometheus text containing `polyrouter_requests_total` with the request's protocol, decision layer, and status, token and cost counters labeled with the served provider's name and external model id, and request- and upstream-duration histograms

#### Scenario: duration histograms bucket LLM-scale latencies

- **WHEN** a request or upstream call longer than 10 seconds (e.g. a 90s streamed completion) is observed
- **THEN** it increments a finite histogram bucket (e.g. `le="120"`), not only `+Inf`, so quantiles and comparisons above 10s are meaningful

#### Scenario: upstream duration is split by outcome

- **WHEN** an upstream call succeeds and, separately, a client aborts another upstream call
- **THEN** the `polyrouter_upstream_duration_seconds` series for `outcome="success"` and `outcome="canceled"` are distinct, so the abort duration is not counted in the success latency histogram

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

### Requirement: A degraded circuit-breaker store is observable, never silent

When the shared (Redis) circuit-breaker store faults and the breaker falls back to its
per-instance in-memory store — so the circuit is no longer coordinated across replicas — the
degradation SHALL be observable: the proxy SHALL increment a dedicated counter
(`polyrouter_breaker_store_faults_total`) and SHALL emit a WARN log. The log SHALL be
throttled (at most once per a fixed short window) so a sustained store outage cannot amplify
into a log storm, and it SHALL name only the error's code/name — never its message — so no
connection detail or secret is logged (invariant 8). The degradation SHALL never change a
request outcome: the breaker keeps deciding on its in-memory fallback and the observability
hook itself SHALL NOT throw into the request path.

#### Scenario: A breaker-store fault increments the counter and logs once, throttled

- WHEN the Redis breaker store faults repeatedly during a request burst
- THEN `polyrouter_breaker_store_faults_total` increments for the degradation
- AND a WARN is logged at most once per throttle window (not once per degraded call), naming
  only the error code/name and never the message
- AND requests continue to be served on the per-instance fallback (the hook does not throw)

