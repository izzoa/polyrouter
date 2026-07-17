## Why

Attribute hygiene and exactly-once cost metrics are correct, but two observability gaps remain
(FABLE_AUDIT E15):

- **The latency histograms are useless for the exact traffic the product routes.** Both duration
  histograms (`polyrouter_request_duration_seconds`, `polyrouter_upstream_duration_seconds`) are built
  with no `buckets`, so prom-client's defaults apply — the largest finite bucket is **10s**. Streamed
  LLM completions routinely run 10s–minutes, so every such observation lands only in `+Inf`:
  `histogram_quantile` reports ~10s for all real traffic and per-provider latency comparison above 10s
  is impossible.
- **The production tracing switch is never executed by a test.** The openspec scenario "an unreachable
  collector does not affect requests" has no test, and `initTracing`/`shutdownTracing` (the
  `OTEL_ENABLED` gate, the OTLP exporter, the `BatchSpanProcessor`) are never run by any suite — every
  test registers its own in-memory provider. A regression in the real switch ships undetected.

## What Changes

- **E15.1** Pass explicit LLM-scale buckets — `[0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600]`
  (sub-second to 10 minutes) — to both duration histograms.
- **E15.2** Add a `tracing.spec.ts` that runs the production switch: `initTracing` with `OTEL_ENABLED=true`
  and an OTLP endpoint at an unreachable port registers a recording provider without throwing/blocking,
  span-wrapped work completes promptly, and `shutdownTracing` drains and resolves cleanly; `initTracing`
  with `OTEL_ENABLED` unset registers no provider (a no-op); init/shutdown are idempotent, and the OTel
  API globals are reset between cases so the suite is order-independent. (Test-only. The OTLP HTTP send
  itself is not executed under the jest `node` environment — the drain is asserted via a clean resolving
  shutdown, and the register/no-block guards catch the realistic switch regressions.)

## Capabilities

### Modified Capabilities

- `observability`: both duration histograms use explicit LLM-scale buckets so a >10s observation lands
  in a finite bucket (quantiles above 10s are meaningful); the enabled-tracing switch (register + flush
  against an unreachable collector) is regression-tested so it can't silently break.

## Impact

- **Code:** `observability/proxy-metrics.ts` (explicit `buckets` on both histograms — a shared
  `LLM_DURATION_BUCKETS` const). No schema change, no migration. The tracing switch is unchanged
  (E15.2 is coverage only).
- **Tests:** `proxy-metrics.spec.ts` asserts a 90s observation increments `le="120"` (and `le="60"} 0`)
  on both histograms; `tracing.spec.ts` exercises the enabled path against a dead collector +
  disabled-is-no-op + idempotent shutdown. Changeset: user-facing (operators' latency dashboards).
- The shutdown-flush defect the observability auditor also reported shares E5.1's root cause and was
  already fixed there. Backlog A-35/A-36/A-37 (per-signal OTLP var, gauge label churn on rename,
  `upstream_duration` outcome label) are out of scope.
