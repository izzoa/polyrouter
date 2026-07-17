## Context

Two small observability fixes: a one-line-scope metrics correctness fix (histogram buckets) and a
test-only closure of an untested production code path (the tracing switch). No runtime behavior of the
tracing switch changes.

## Decisions

### D1 — Explicit LLM-scale buckets on both duration histograms (E15.1)

A shared `LLM_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600]` is passed to
both `requestDuration` and `upstreamDuration`. The ladder keeps sub-second resolution (where quick
buffered calls and cheap-tier hits sit) and extends through 10 minutes (long streamed completions).
prom-client's default ends at a 10s finite bucket, which is exactly where LLM traffic *starts*, so the
defaults collapse all real latency into `+Inf`. Twelve buckets is well within Prometheus's cardinality
comfort for two histograms with small label sets.

This deliberately follows the audit's suggested ladder, which starts at `0.1` and therefore **drops the
default sub-100ms boundaries** (`0.005`/`0.01`/`0.025`/`0.05`) — those are noise for LLM latency (network
RTT alone is tens of ms). This is a bucket-boundary change, not a purely additive one: an operator with a
recording/alert rule pinned to one of the dropped `le` values would stop getting samples for it. The
project has no published release yet (so there are no live dashboards to break), and historical series
are untouched — Prometheus simply records the new boundaries going forward.

### D2 — Exercise the real tracing switch against a dead collector (E15.2)

`initTracing`/`shutdownTracing` were dark to the test suite because every spec registers its own
in-memory `NodeTracerProvider`. The new `tracing.spec.ts` runs the *actual* functions:

- `loadConfig` re-reads `process.env` on each call (no memoization), so a test can flip `OTEL_ENABLED`
  between cases. `OTEL_ENABLED` unset → `initTracing` returns before registering (asserted: a span from
  `getTracer(TRACER_NAME)` is non-recording).
- `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` at a **closed** port (`127.0.0.1:1`) →
  `initTracing` registers a real SDK provider (asserted: a span *is* recording), span-wrapped work runs
  promptly (latency bound — the batched export can't stall the synchronous path), and `shutdownTracing`
  resolves (the flush to the dead collector is contained by the function's own catch). `initTracing` is
  also asserted idempotent.
- The disabled case runs **first in file** so no prior global tracer registration leaks in; jest
  isolates `globalThis` per test file, so the SDK registration doesn't bleed into other specs.
  `afterEach` always calls `shutdownTracing` (clearing the `BatchSpanProcessor` timer → clean jest
  exit) and restores the two env vars.

This is a unit spec (no DB) rather than an e2e: it needs only the OTel SDK and directly targets the
acceptance ("fails if `initTracing` throws, blocks, or fails to register/flush").

## Risks / Trade-offs

- **Bucket choice is a judgement call**, not tenant-tunable. The chosen ladder matches the audit's
  suggestion and covers the product's real latency range; a per-deploy override is deferred (the metric
  names/buckets are a stable operator contract).
- **The tracing spec registers a real global provider** in its worker; contained by per-file jest
  isolation + `afterEach` shutdown, verified by a clean suite exit.

## Migration Plan

None at the schema/API level. The histogram *bucket boundaries* change (see D1): Prometheus records the
new boundaries going forward and historical series are unaffected, but any external rule pinned to a
dropped sub-100ms `le` value would go empty. No release exists yet, so there is nothing to migrate; a
post-release bucket change would warrant a changelog note.

## Open Questions

- Should `upstream_duration` also carry an `outcome` label so client-abort durations don't pollute
  latency? That's backlog A-37, deliberately out of this scope.
