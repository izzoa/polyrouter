# cascade-routing Specification

## Purpose
TBD - created by archiving change add-cascade-routing. Update Purpose after archive.
## Requirements
### Requirement: An ambiguous `auto` request tries the cheap tier first and escalates on a bad answer

When Layer 1 classifies an `auto` request as **ambiguous**, cascade is enabled (`cascade` ∈ `ROUTING_AUTO_LAYERS`), and both `auto_low` (cheap) and `auto_high` (strong) targets are configured, the system SHALL run the **cheap** tier first, evaluate the answer with a cheap quality check, and **escalate** to the **strong** tier only when the cheap answer is bad or the cheap chain fails outright (spec §7.2 Layer 3, FrugalGPT-style). The client SHALL receive exactly one coherent response — the cheap answer when it passes, otherwise the strong answer.

#### Scenario: A good cheap answer is returned without escalation

- WHEN an ambiguous `auto` request's cheap-tier answer passes the quality check
- THEN the cheap answer is returned, no strong-tier call is made, and the request records `escalated=false`

#### Scenario: A bad cheap answer escalates and the client still gets one coherent response

- WHEN an ambiguous `auto` request's cheap-tier answer fails the quality check
- THEN the strong tier is called and its answer is returned as the single response, recorded `escalated=true`

#### Scenario: A cheap-chain failure escalates

- WHEN the cheap tier's whole fallback chain fails
- THEN the strong tier serves the request (a failed cheap answer is treated as the worst quality)

#### Scenario: A hung cheap upstream escalates; a client disconnect stops

- WHEN the cheap upstream sends headers then stalls past the cheap-response deadline
- THEN the cheap attempt is aborted and the request escalates to the strong tier
- WHEN instead the client disconnects during the buffered cheap attempt
- THEN the request stops without calling or recording the strong tier

#### Scenario: Escalation rescues to the default tier when the strong tier also fails

- WHEN the cheap answer is bad AND the strong tier's whole chain fails
- THEN the request still falls through to the Layer-0 `default` tier (the reliable core), and only a whole-cascade failure yields an error

### Requirement: The quality check is cheap, language-neutral, and tokenizer-free

The cascade quality check SHALL use only structural signals — empty output, malformed/invalid structured output (e.g. unparseable tool arguments), and error stop reasons — producing a numeric score in `[0,1]`, and SHALL NOT run a tokenizer, a generative/LLM call, or natural-language keyword matching on the hot path (invariant 9). Escalation SHALL occur when the score is below the configured threshold.

#### Scenario: An empty or malformed cheap answer scores low and escalates

- WHEN the cheap answer is empty, or contains malformed structured output, or ends with an error stop reason
- THEN its quality score is below the threshold and the request escalates to the strong tier

#### Scenario: Scoring is language-neutral

- WHEN two structurally-equivalent cheap answers differ only in human language
- THEN they receive the same quality score (no keyword dependence)

### Requirement: Streaming escalation preserves the mid-stream commit boundary

For a streaming client the cheap attempt SHALL be run **buffered** (nothing forwarded) so the quality check runs before anything is committed; the system SHALL then deliver **exactly one** tier's output — the synthesized cheap answer when it passes, or the live strong stream when it escalates — and SHALL **never** swap models mid-stream (invariant 3, spec §6.3). A failure after the committed stream has begun terminates it with the clear terminal error, never a spliced other model.

#### Scenario: A passing cheap answer is replayed as the client's stream

- WHEN a streaming client's cheap answer passes the quality check
- THEN the buffered cheap answer is delivered as one clean streamed response (no strong-tier output appears)

#### Scenario: An escalation streams only the strong tier, never a swap

- WHEN a streaming client's cheap answer fails and the strong tier is streamed
- THEN only the strong tier's output reaches the client, and once it has committed, a later failure is a terminal error — never spliced with another model

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

### Requirement: Cascade always degrades to Layer 0/1 and never fails or stalls

Any condition that prevents cascade — the layer disabled, Layer 1 not ambiguous, or a missing cheap or strong target — SHALL degrade to the existing Layer 0/1 decision without failing or stalling the request (invariant 1). A **quality-check error** is instead handled **fail-open**: the buffered cheap answer is delivered (recorded `quality_signal=null`), never failing the request. Disabling cascade SHALL change nothing for explicit, header, structural, or default traffic.

#### Scenario: Disabling cascade changes nothing for explicit traffic

- WHEN `cascade` is not in `ROUTING_AUTO_LAYERS`
- THEN explicit-model, header-tier, structural, and default routing behave exactly as before (an ambiguous `auto` request serves via the `default` tier)

#### Scenario: A missing band target degrades to default

- WHEN an ambiguous `auto` request would cascade but no `auto_low` or no `auto_high` target is configured
- THEN the request is served via the Layer-0 `default` tier, with no error

#### Scenario: A quality-check error does not fail the request

- WHEN the quality evaluation throws
- THEN the cheap answer is delivered (treated as a pass) rather than failing the request

