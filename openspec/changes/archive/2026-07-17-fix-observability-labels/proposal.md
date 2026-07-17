## Why

Three observability backlog nits (FABLE_AUDIT A-35, A-36, A-37):

- **A-35** The per-signal `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (which the OTLP exporter reads and which
  *overrides* the generic endpoint) is unregistered, so a malformed value doesn't fail boot the way the
  generic `OTEL_EXPORTER_OTLP_ENDPOINT` does, and it doesn't flow through the compose pass-through.
- **A-37** The `upstream_duration` histogram has no `outcome` label, so a client-abort (`canceled`) —
  whose duration settles whenever the consumer leaves, not on provider latency — is bucketed together
  with real successes, polluting latency quantiles.
- **A-36** The `provider` label on the breaker/upstream series is the display name, so renaming a
  provider leaves a stale series. This is an accepted trade-off (documented), not a code change:
  display names are chosen for dashboard legibility and renames are rare.

## What Changes

- **A-35** Register `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` in the observability config schema (optional URL
  → boot-validated) and add it to the compose app env pass-through.
- **A-37** Add `outcome` to the `polyrouter_upstream_duration_seconds` histogram labels and pass it in
  `recordUpstream`, so `canceled` durations form a distinct series from `success`.
- **A-36** Document the display-name label choice as an accepted trade-off in the spec (no code change).

## Capabilities

### Modified Capabilities

- `observability`: the per-signal OTLP traces endpoint is boot-validated + passed through compose; the
  upstream duration histogram is split by `outcome` so client aborts don't pollute success latency; the
  provider-name label choice is documented as an accepted trade-off.

## Impact

- **Code:** `observability/observability.config.ts` (register the traces endpoint var),
  `docker-compose.yml` (pass it through), `observability/proxy-metrics.ts` (`outcome` on the upstream
  histogram). No schema/DB change, no migration.
- **Tests:** `proxy-metrics.spec.ts` — the upstream bucket assertion carries `outcome="success"`, and a
  new case asserts `success`/`canceled` form distinct duration series. Changeset: user-facing (a metrics
  label change on operators' dashboards).
