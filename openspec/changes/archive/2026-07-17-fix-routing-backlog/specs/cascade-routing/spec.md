## MODIFIED Requirements

### Requirement: An ambiguous `auto` request tries the cheap tier first and escalates on a bad answer

When Layer 1 classifies an `auto` request as **ambiguous**, cascade is enabled (`cascade` ∈ `ROUTING_AUTO_LAYERS`), and both `auto_low` (cheap) and `auto_high` (strong) targets are configured, the system SHALL run the **cheap** tier first, evaluate the answer with a cheap quality check, and **escalate** to the **strong** tier only when the cheap answer is bad or the cheap chain fails with a **retryable** error (spec §7.2 Layer 3, FrugalGPT-style). A cheap-chain failure that is **non-retryable** — a `bad_request` (the client's request is malformed, which the strong tier would reject identically) — SHALL NOT escalate: it records one `status=error` row and surfaces the client-facing error, so a malformed request never wastes an expensive escalation. The client SHALL receive exactly one coherent response — the cheap answer when it passes, otherwise the strong answer (or the surfaced error on a non-retryable cheap failure).

#### Scenario: A good cheap answer is returned without escalation

- WHEN an ambiguous `auto` request's cheap-tier answer passes the quality check
- THEN the cheap answer is returned, no strong-tier call is made, and the request records `escalated=false`

#### Scenario: A bad cheap answer escalates and the client still gets one coherent response

- WHEN an ambiguous `auto` request's cheap-tier answer fails the quality check
- THEN the strong tier is called and its answer is returned as the single response, recorded `escalated=true`

#### Scenario: A cheap-chain failure escalates

- WHEN the cheap tier's whole fallback chain fails with a retryable error (unavailable/rate-limit/auth)
- THEN the strong tier serves the request (a failed cheap answer is treated as the worst quality)

#### Scenario: A non-retryable cheap failure is surfaced, not escalated

- WHEN the cheap tier fails with a `bad_request` (the client's request is malformed)
- THEN the request does NOT escalate to the strong tier, records one `status=error` row with `escalated=false`, and surfaces the client-facing 4xx (the strong tier would reject the same request)

#### Scenario: A hung cheap upstream escalates; a client disconnect stops

- WHEN the cheap upstream sends headers then stalls past the cheap-response deadline
- THEN the cheap attempt is aborted and the request escalates to the strong tier
- WHEN instead the client disconnects during the buffered cheap attempt
- THEN the request stops without calling or recording the strong tier

#### Scenario: Escalation rescues to the default tier when the strong tier also fails

- WHEN the cheap answer is bad AND the strong tier's whole chain fails
- THEN the request still falls through to the Layer-0 `default` tier (the reliable core), and only a whole-cascade failure yields an error
