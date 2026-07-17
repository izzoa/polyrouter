## Context

Small observability polish: one config-registration fix, one metric-label fix (a contract change), and
one documented trade-off.

## Decisions

- **A-35:** register `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` alongside the generic endpoint (same
  `z.string().url().optional()` shape). The OTLP exporter still reads it from `process.env` directly, so
  registration adds only boot validation (fail-fast on a malformed value) and compose pass-through — it
  is not surfaced on the resolved `ObservabilityConfig` (neither is the generic endpoint).
- **A-37:** `recordUpstream` already receives `outcome`; the histogram just adds it to `labelNames` and
  the `observe` call. `canceled` durations now form their own series, so `histogram_quantile` over
  `{outcome="success"}` reflects real provider latency. This changes the histogram's label set (a metric
  contract change) — acceptable pre-release, and it strictly refines an existing signal.
- **A-36 (accepted, no code):** labeling the breaker/upstream series by the provider *display name* is a
  deliberate legibility choice. Labeling by an opaque provider id would be rename-stable but makes
  dashboards unreadable, and a name-plus-id scheme still churns the name label on rename while adding
  cardinality. Renames are rare and a stale series ages out, so the name label stands; the spec now says
  so explicitly.

## Risks / Trade-offs

- The upstream histogram label-set change means an existing recording rule on the old
  `{provider, model}` series would need `outcome` added; pre-release, so nothing to migrate.

## Migration Plan

None — config registration + a metric label. No schema/API change.
