## 1. E15.1 — Explicit LLM-scale histogram buckets

- [x] 1.1 In `observability/proxy-metrics.ts`, add a shared `LLM_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600]` and pass it as `buckets` to both `requestDuration` and `upstreamDuration`.
- [x] 1.2 `proxy-metrics.spec.ts`: observe a 90s request and upstream call; assert `le="60"} 0` and `le="120"} 1` (finite bucket, not only `+Inf`) on both histograms.

## 2. E15.2 — Cover the enabled tracing switch

- [x] 2.1 Add `observability/tracing.spec.ts`: `initTracing` with `OTEL_ENABLED` unset is a no-op (a span from `getTracer(TRACER_NAME)` is non-recording); with `OTEL_ENABLED=true` + an OTLP endpoint at an unreachable port it registers a recording provider without throwing, span-wrapped work completes promptly (never blocked on the collector), and `shutdownTracing` drains + resolves; `initTracing`/`shutdownTracing` are idempotent. `afterEach` shuts down + resets the OTel API globals (`trace`/`context`/`propagation.disable()`) + restores env, so the suite is order-independent (passes under `--randomize`) and exits cleanly. (The OTLP HTTP send isn't executed under the jest `node` env — verified against a standalone repro — so the flush is asserted via a clean resolving shutdown, not a captured export.)

## 3. Verification & wrap-up

- [x] 3.1 `npm run build && npm run lint && npm run typecheck` clean; the control-plane unit suite exits cleanly (no leaked BatchSpanProcessor timer).
- [x] 3.2 `npm test -w packages/control-plane` green (proxy-metrics bucket + tracing switch specs).
- [x] 3.3 Changeset (user-facing: latency histograms now usable above 10s).
- [x] 3.4 Update `TODOS.md` board + mark E15 ✅ in `FABLE_AUDIT.md` after archive.
