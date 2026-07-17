## ADDED Requirements

### Requirement: A client abort is recorded as cancelled, never a provider failure

When a proxied request fails **because the caller's own request was aborted** (the client
disconnected or cancelled), the proxy SHALL record it with a distinct terminal status
`cancelled` — never `error` — and SHALL NOT fire the failure-spike notification for it. The
decision is made from the **pure client abort signal** at record time (the same signal the
breaker uses to treat a caller-gone teardown as neutral), not from the upstream error, so a
client hang-up cannot inflate the error-rate metric or the `request_failures_spike` producer
with a provider failure the provider never had. This applies to the buffered chain, the
streaming chain (both before and after the mid-stream commit boundary), and the cascade
paths. A genuine upstream failure (the client is still connected) SHALL continue to record
`error` and fire the failure-spike notify as before.

#### Scenario: A client-aborted request records cancelled and does not alert

- WHEN a buffered or streaming request fails and the caller's request signal is aborted at
  the time the outcome is recorded
- THEN the RequestLog is written with `status = cancelled` (not `error`)
- AND the failure-spike producer is not notified for that request
- AND the error-count analytics (which count `status = error`) do not include it

#### Scenario: A genuine provider failure still records error and alerts

- WHEN a request fails on an upstream/provider error while the caller is still connected (its
  signal is not aborted)
- THEN the RequestLog is written with `status = error` and the failure-spike producer is
  notified, exactly as before this change
