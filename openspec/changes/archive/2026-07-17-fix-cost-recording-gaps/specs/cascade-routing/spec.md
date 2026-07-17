## MODIFIED Requirements

### Requirement: Cascade records the served request and every billable call

A cascade request SHALL record one `RequestLog` row for the member that actually **served** — `decision_layer='cascade'`, `escalated` (boolean), `quality_signal` (the numeric score, or `null` on a fail-open quality error), the served `tier_assigned`, a structured `routing_reason`, and the served provider/model/price snapshot (invariant 4), including `tier_assigned=default` with the default model's price when a default member serves after the strong tier is exhausted. Because cascade can make more than one billable upstream call, **every additional billable call SHALL be recorded at its own immutable snapshot price** in a `request_attempt` ledger row linked to the request (invariant 4). Total request spend is `RequestLog.cost` plus the sum of its `request_attempt` costs. `request_attempt` rows SHALL be owner-scoped (invariant 5). When the **client disconnects during the cheap leg** (the pure client signal aborted, distinct from a cheap-deadline timeout, which still escalates), the cascade SHALL record exactly one `RequestLog` row (`status='error'`, cheap tier meta at index 0, `escalated=false`, `output_chars=0`) before propagating the error and SHALL NOT emit a provider-failure notification (a client disconnect is not a provider fault) — a cancelled cascade request is never invisible to the spend record.

#### Scenario: An escalation records the served row and a cheap-attempt ledger row

- WHEN a request's cheap answer succeeds but is escalated cheap→strong
- THEN the `RequestLog` row names the strong (served) model with its price snapshot, `decision_layer='cascade'`, `escalated=true`, a `quality_signal` score
- AND a `request_attempt` row records the superseded cheap call with its own model, immutable price snapshot, usage, and cost — so the request's true spend is `RequestLog.cost + request_attempt.cost`

#### Scenario: A passing cheap answer writes no attempt row

- WHEN the cheap answer passes
- THEN one `RequestLog` row is recorded (`escalated=false`, the cheap model, `quality_signal` = the score) and no `request_attempt` row

#### Scenario: A rescued default member is recorded as the default tier

- WHEN the strong tier is exhausted and a default member serves
- THEN the `RequestLog` `tier_assigned` is `default` with the default model and its price snapshot (not the strong tier's), `escalated=true`

#### Scenario: A client disconnect during the cheap leg records exactly one error row

- WHEN the client disconnects while the cascade's buffered cheap attempt is in flight (the pure client signal aborts, not the cheap deadline)
- THEN exactly one `RequestLog` row exists for the request (`status='error'`, `decision_layer='cascade'`, `escalated=false`), no `request_attempt` rows are written, and no strong-tier call is made
- AND no provider-failure notification is emitted (the disconnect is breaker-neutral, not a provider fault)
