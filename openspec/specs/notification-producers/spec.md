# notification-producers Specification

## Purpose
TBD - created by archiving change add-notification-producers. Update Purpose after archive.
## Requirements
### Requirement: Circuit-breaker open emits provider_down

The system SHALL emit a `provider_down` notification event when a provider's **shared** circuit breaker transitions **into the open state** (a healthy provider crossing the failure threshold, or a failed half-open probe), scoped to the provider's owner and carrying the provider name for rendering. Because the transition is applied atomically by one completion on the shared store, the system SHALL produce **one best-effort event emission per open transition**, deduped per `(owner, provider)` within the event's window (so a re-open within the window does not re-alert); channel *delivery* remains the delivery layer's at-least-once retry (may duplicate after an ambiguous external failure), not exactly-once. A transition on the per-instance in-memory **fallback** store (used only when Redis is unavailable) SHALL NOT alert, so a Redis outage does not fan out duplicate alerts. Emitting the event MUST NOT block, delay, or fail the request whose completion tripped the breaker (invariant 11) — it is fire-and-forget over the non-blocking `emit`, and a notification fault never affects routing or fallback (invariant 1).

#### Scenario: Tripping a provider's breaker delivers one provider_down

- WHEN repeated failing calls to a provider cross the shared breaker's failure threshold (closed→open), for an owner with a channel subscribed to `provider_down`
- THEN one `provider_down` event is delivered, naming the provider, and the failing request completes (fallback or terminal error) without waiting on the notification

#### Scenario: A subsequent trip within the window does not re-alert

- WHEN the breaker for the same provider is already open, or re-opens on a failed probe, within the dedup window
- THEN no additional `provider_down` is delivered until the window elapses

### Requirement: A burst of request failures emits request_failures_spike

The system SHALL detect a spike of failed requests per owner — counting recorded request errors for the owner within a configurable recent window via an **atomic Redis counter** (correct across instances, invariant 10) — and emit `request_failures_spike` (carrying the count) when the count reaches a configurable threshold. The detection SHALL run **off the request path** (triggered fire-and-forget when a failure is recorded) and be **owner-scoped** (an owner's counter reflects only that owner's errors). Repeated failures within one window SHALL collapse to at most one delivered event (dedup).

#### Scenario: Failures reaching the threshold deliver one spike alert per window

- WHEN an owner's recorded failures reach the configured threshold within the (epoch-aligned) window
- THEN one `request_failures_spike` event is delivered for that window (further failures in the same window do not re-alert), and the request path is never blocked by the check

#### Scenario: Below-threshold failures deliver nothing

- WHEN an owner's recent failures stay under the threshold
- THEN no `request_failures_spike` is delivered

### Requirement: A scheduled weekly job emits per-owner spend summaries

The system SHALL provide a scheduled (opt-in) job that, once per configured period regardless of the number of running instances, aggregates each owner's total spend over the past week from **both cost ledgers** (the request log and cascade request-attempts) and emits one `weekly_spend_summary` per owner (carrying that owner's total). The aggregate is a system-level rollup exposed through a **narrow, scheduler-only** reader (not the general persistence seam); its output SHALL be partitioned per owner so that no owner's summary contains another owner's spend (invariant 5). The scheduler's produced job records SHALL be **retention-bounded** (completed/failed jobs removed by age) so they do not accumulate unbounded in Redis.

#### Scenario: The weekly job emits each owner only their own total

- WHEN the weekly summary job runs with two owners A and B who each had spend in the period
- THEN A receives a `weekly_spend_summary` whose total reflects only A's requests, B receives one reflecting only B's, and neither total includes the other's spend

#### Scenario: An occurrence yields one summary per owner regardless of instances or re-runs

- WHEN multiple app instances share one Redis and the scheduled occurrence fires (and even if a stalled job re-runs)
- THEN each owner receives one `weekly_spend_summary` for that occurrence (not one per instance or per re-run), because emits are keyed by the occurrence and deduplicated

#### Scenario: Scheduler registration never blocks boot

- WHEN Redis is unavailable at startup (with the weekly summary enabled or disabled)
- THEN the application still boots (scheduler reconciliation is fail-open and retried in the background); Layer 0 is not gated on it

#### Scenario: The weekly scheduler's job records stay bounded

- WHEN the weekly summary scheduler produces jobs over many occurrences
- THEN its completed/failed BullMQ job records are retention-bounded (removed by age), not accumulated forever in Redis

### Requirement: Password-reset delivers via server-wide SMTP, SSRF-guarded, token never logged

The system SHALL deliver Better Auth's password-reset email through server-wide SMTP defaults (§12: `SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM`/`SECURE`), sending the reset link via the same **SSRF-validated, connect-time IP-pinned** SMTP path as user channels (invariant 6). The reset **token/url MUST never be logged** (invariant 8). Because the reset request awaits the send hook, the send SHALL be **detached** so the reset response never blocks on or fails from SMTP latency/errors (invariant 11): a send failure is logged and does not fail the request. If SMTP is not configured, the system SHALL log a config-state warning and skip the send **without failing the reset request** (the token flow still returns a valid link).

#### Scenario: A reset request with SMTP configured mails the link

- WHEN a user requests a password reset and server-wide SMTP is configured
- THEN the reset email is sent to the user via the SSRF-guarded SMTP path, and neither the token nor the URL appears in any log

#### Scenario: A reset request without SMTP configured does not fail

- WHEN SMTP is not configured and a user requests a password reset
- THEN the request succeeds (token issued), a config-state warning is logged, and no token/url is logged

#### Scenario: An SMTP host resolving to a blocked address is refused

- WHEN the server-wide SMTP host resolves to a metadata/blocked address (per the mode-gated policy)
- THEN the send is refused by the SSRF guard and the failure is logged without any host/recipient/token

#### Scenario: A slow SMTP server does not delay the reset response

- WHEN SMTP is configured but the server is slow/unresponsive and a user requests a password reset
- THEN the reset request returns promptly (the send is detached), and a later send failure is logged without affecting the completed request

### Requirement: Producers never block the request, budget, or reset path

Every event producer (breaker-open, failure-spike) and the reset mailer SHALL run off the caller's critical path — emitting via the non-blocking `emit` (which swallows Redis faults) or catching and logging delivery errors — so that a slow, failing, or unavailable notification channel, queue, or mailer never delays or fails a proxy request, a fallback, or a password-reset request (invariant 11).

#### Scenario: A down notification pipeline leaves the request path intact

- WHEN the notification queue/Redis is unavailable while a breaker trips or a failure spike is detected
- THEN the proxy request still completes normally and the producer failure is contained (logged, not thrown)

