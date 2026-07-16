# Tasks: add-observability

> Build order: deps + config → metrics core (`/metrics`) → data-plane breaker seam → tracing bootstrap → span instrumentation → metric emission wiring → tests → DoD. Control-plane + ONE additive data-plane seam (breaker-state callback; no behavior change). No frontend. Every emission path exception-safe (observability never changes a request outcome); labels/attributes metadata-only and bounded (invariants 8, 9).

## 1. Dependencies + config

- [x] 1.1 Add to `packages/control-plane`: `prom-client`; `@opentelemetry/api` (^1.9), and ONE tested stable 2.x line of `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`; dev-only `@opentelemetry/sdk-trace-base` (tests import `InMemorySpanExporter` directly). NO auto-instrumentation packages.
- [x] 1.2 `observability/observability.config.ts`: `registerConfig('observability', …)` — `OTEL_ENABLED` (default false) and `METRICS_ENABLED` (default true) via the repo's boolean-env convention; `OTEL_SERVICE_NAME` (default `polyrouter`); `OTEL_EXPORTER_OTLP_ENDPOINT` as an **optional URL** — malformed value + `OTEL_ENABLED` fails boot fast (§12); absent → the exporter's standard default applies. Typed loader like the other fragments.

## 2. Metrics core

- [x] 2.1 `observability/proxy-metrics.ts`: `ProxyMetrics` injectable owning a **per-instance** `Registry` (never prom-client's global default — Jest builds many apps per process) + `collectDefaultMetrics({ register })`. Series (prefix `polyrouter_`, every emit method exception-safe): `requests_total{protocol,decision_layer,status}`; `request_duration_seconds{protocol,decision_layer,status}` histogram; `tokens_total{provider,model,direction}`; `cost_microusd_total{provider,model}`; `upstream_requests_total{provider,model,outcome}` (success|error|canceled); `upstream_duration_seconds{provider,model}` histogram; `upstream_setup_failures_total{provider}`; `breaker_state{provider}` gauge (0/1/2); `breaker_opens_total{provider}`; `log_rows_dropped_total`. Typed emit methods + `metricsText()` + `contentType`.
- [x] 2.2 `observability/metrics.controller.ts`: `GET /metrics` → `NotFoundException` when `METRICS_ENABLED=false`, else the registry text with prom-client's content type. Session-free by construction (non-`/api`; confirm no guard change needed).
- [x] 2.3 `observability/observability.module.ts`: providers `ProxyMetrics` + shutdown hook (task 4.2); controller `MetricsController`; exports `ProxyMetrics`. Import into `AppModule`, `RecordingModule`, `ProxyModule` (module imports nothing — no cycles).

## 3. Data-plane — additive breaker-state seam

- [x] 3.1 Chain-runner options (next to the existing `onOpen`): optional `onBreakerState?: (providerId: string, state: BreakerState) => void`, invoked with the state observed at each admission decision (allow, probe, and skip paths). Purely additive — no behavior change, existing callers compile untouched. Export the type; unit-cover the callback firing for closed/open/half_open admissions in the existing breaker/chain specs.

## 4. Tracing bootstrap

- [x] 4.1 `observability/tracing.ts`: `initTracing(): void` — no-op unless `OTEL_ENABLED`; validates the optional endpoint (fail-fast on malformed); registers `NodeTracerProvider` (resource `service.name` = `OTEL_SERVICE_NAME`) with `BatchSpanProcessor(new OTLPTraceExporter())`; `provider.register()` (ALS context manager). `shutdownTracing(): Promise<void>` flushes + shuts down (idempotent, bounded). An unreachable-but-valid collector is never fatal.
- [x] 4.2 `main.ts`: call `initTracing()` immediately after `loadConfig`, before `NestFactory.create`. `ObservabilityModule`'s `OnApplicationShutdown` provider awaits `shutdownTracing()`.
- [x] 4.3 `observability/root-span.middleware.ts` + `app.setup.ts`: Express middleware mounted `app.use('/v1', …)` in `configureApp` (all e2e harnesses inherit it). Starts `proxy.request` (attrs from `req.method` + **`req.originalUrl`** — mounted middleware sees a stripped path — + client protocol from the path); wraps `next()` in `context.with(trace.setSpan(context.active(), span), next)`; ends on **`res.once('close')`** with `http.response.status_code`, double-end guarded. Pure `@opentelemetry/api` — inert when tracing is disabled.

## 5. Span instrumentation

- [x] 5.1 `auth/agent-key.guard.ts`: child span `auth` around verification (outcome attr ok|unauthorized; NEVER key/prefix/hash material; span ends in `finally`, exceptions propagate unchanged).
- [x] 5.2 `proxy/proxy.service.ts`: `routing` span around `prepare()`; on success set `decision_layer`, `tier` (nullable), `model` (routed external id when resolvable), `cascade` (bool); route errors mark error + rethrow.
- [x] 5.3 `observability/observe-adapter.ts`: `observeAdapter(adapter, { provider }): ProviderAdapter` wrapping `chat` (span+timer around the promise; throw ⇒ error + rethrow) and `chatStream` (the wrapper IS an async generator delegating to the inner one: span starts on first iteration — a never-iterated call creates no span — and ends exactly once in `finally`; outcome rules mirror the breaker: yielded `error` event or no terminal event ⇒ error; consumer abort via `return()` before completion ⇒ **canceled** (span OK + attr, never inflates provider error rates); clean terminal ⇒ success). Labels/attrs: provider name + `request.model` at call time; emits `recordUpstream(...)` on the same boundary. `listModels`/`testConnection` pass through.
- [x] 5.4 `proxy/proxy.service.ts` `buildAdapter`: return the factory product wrapped by `observeAdapter` (construction stays lazy inside breaker admission); on the setup-failure path (missing credential / decrypt error — thrown before any upstream call) emit `upstream_setup_failures_total{provider}` and rethrow unchanged (disjoint from decorator coverage — no double count).
- [x] 5.5 `recording/request-recorder.ts`: `recording.enqueue` span around `record()` (attrs: status, decision_layer). When tracing is active, capture the active `SpanContext` onto the draft (optional non-persisted field).
- [x] 5.6 `recording/log-writer.ts`: run each batch insert (`writeGroup`/`writeAttemptGroup`) under a `recording.write` span with **span links** to the batch's draft contexts (attrs: row count; error status + dropped count on the give-up path). This is the spec's traced "DB write"; batching is unchanged.

## 6. Metric emission wiring

- [x] 6.1 Pass-through fields: `RecordingContext` gains `protocol: ClientProtocol` and `providerName: string`; `RequestLogDraft`/`RequestAttemptDraft` gain `providerName` + optional `spanContext`. `proxy.service.ts` `metaContext` supplies name (from `AttemptMeta.providerName`) and protocol. DB row shape unchanged. Update existing recorder/log-writer spec fixtures.
- [x] 6.2 `RequestRecorder.record()`: emit `recordRequest(protocol, decision_layer, status, durationSeconds)` (exactly once per finalized inference request) + `recordTokens(provider, model, input|output)`. `recordAttempt()`: emit tokens for the superseded cascade cheap call (NO `requests_total` increment).
- [x] 6.3 `LogWriter`: emit `recordCost(providerName, externalModelId, round(costUsd × 1e6))` **exactly once per row, only after its batch insert succeeds** (retries rebuild rows but must not re-emit; `null` cost rows emit nothing; dropped rows emit no cost); emit `logRowsDropped(n)` on every abandon path. `ProxyMetrics` injected via `RecordingModule`.
- [x] 6.4 `proxy/proxy.service.ts`: extend the per-request chain options — `onOpen` additionally emits `breakerOpened(providerName)`; the new `onBreakerState` sets the `breaker_state` gauge (providerId → name via the request's `AttemptMeta`).

## 7. Tests

- [x] 7.1 Unit `observability/proxy-metrics.spec.ts`: series/labels via the registry; emit methods never throw on bad input; two instances don't collide (per-instance registry).
- [x] 7.2 Unit (writer): cost emitted exactly once when the first insert attempt fails and the retry succeeds; nothing emitted for `null`-cost rows; drops increment `log_rows_dropped_total` (extend the existing log-writer spec with a fake `ProxyMetrics`).
- [x] 7.3 e2e `test/observability/metrics.e2e-spec.ts` (slim proxy harness + stub upstream): drive a success, a fallback (primary fails → secondary serves), and a streamed request; `await writer.flush()`; scrape `/metrics`; assert `requests_total{protocol,decision_layer,status}`, `upstream_requests_total{outcome="error"}` for the failed provider and `"success"` for the serving one, token + cost counters labeled provider/model, both duration histograms, and breaker series after tripping the breaker (repeat failures) — `breaker_opens_total` + `breaker_state`. Separate app with `METRICS_ENABLED=false` → `/metrics` 404.
- [x] 7.4 e2e `test/observability/tracing.e2e-spec.ts`: register a provider with `SimpleSpanProcessor(InMemorySpanExporter)` in `beforeAll` (shutdown in `afterAll` — the ONLY registrar; the disabled default is exercised by every other suite, never by a same-process second app). Drive: a buffered request (assert root `proxy.request` + children `auth`/`routing`/`upstream`/`recording.enqueue` sharing the trace id with correct parents), a fallback (failed member's `upstream` = error status + provider name), a streamed completion (upstream span ends success after the stream), a mid-stream client abort (upstream span canceled, not error; root closed), and after `writer.flush()` a `recording.write` span linked to the request's span context. Assert no attribute contains prompt text or key material.
- [x] 7.5 Regression: full control-plane + data-plane unit and e2e suites green (default posture: tracing off, metrics on; fixture-only updates from 6.1).

## 8. Definition of done

- [x] 8.1 `npm run build` (turbo) passes; lint + prettier clean on changed files; strict TS, no `any`; `npm test -w packages/control-plane` + `npm test -w packages/data-plane` + `npm run test:e2e -w packages/control-plane` green.
- [x] 8.2 DoD (§14.10/TODOS #21): the tracing e2e proves the full span chain (auth → routing → upstream → recording, plus the linked durable-write span); `/metrics` scrapes cleanly after traffic; per-provider error attribution visible in `upstream_requests_total`, `upstream_setup_failures_total`, and the failed `upstream` span; breaker STATE gauge + open transitions present.
- [x] 8.3 Changeset (`@polyrouter/control-plane` minor + `@polyrouter/data-plane` minor for the additive seam). Confirm invariants: observability cannot fail/slow/stall a request; labels/attributes metadata-only; hot path cheap. Update TODOS.md #21; archive the change.
