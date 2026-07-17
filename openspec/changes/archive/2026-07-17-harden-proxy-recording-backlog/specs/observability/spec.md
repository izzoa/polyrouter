## ADDED Requirements

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
