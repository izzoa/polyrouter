# Proposal: add-observability

## Why

The proxy sells observability (per-request cost/latency/decision transparency) but is itself a black box to operators: no traces, no scrapeable metrics, no way to attribute latency or errors to a provider or routing layer without querying the request log. Spec §3.2.6 calls this a universal upgrade — "the gateway should be at least as observable as the observability it sells" — and §14.10 schedules it now (after the dashboard, before packaging). #22 packaging will wire compose; landing `/metrics` and OTel first lets the container ship observable by default.

## What Changes

1. **OpenTelemetry traces on the proxy path** (spec §3.2.6 span chain): a root span per `/v1` proxied request with child spans `auth` (agent-key verify) → `routing` (route resolution incl. structural/cascade evaluation) → `upstream` (one per provider attempt, with provider/model attributes and error status) → `recording` (log-draft enqueue). Off by default; enabled by env (`OTEL_ENABLED`) with the standard OTLP/HTTP exporter (`OTEL_EXPORTER_OTLP_ENDPOINT`, default collector URL). Manual spans only — no auto-instrumentation bundle. Export is batched and asynchronous; a missing/failing collector can never fail, slow, or stall a request (invariant-1 discipline applied to observability).
2. **Prometheus `/metrics` endpoint** (prom-client, default registry + process metrics), env-gated (`METRICS_ENABLED`, default on; 404 when off): request count + duration histogram per decision layer/status/protocol; upstream attempt count + duration per provider/model/outcome (per-provider error attribution); token counters per provider/model/direction; **cost counters incremented from the authoritative snapshot cost** the log writer computes (never a recomputation, invariant 4); circuit-breaker open events per provider; log-writer dropped-rows counter. Labels are instance-level and bounded (provider name, external model id, layer enum) — **no per-tenant, per-request, or unbounded labels; no prompt content or secrets anywhere** (invariant 8).
3. **Plumbing:** `RecordingContext` (and the log-writer drafts) gain the client protocol and provider display name so metrics can attribute without a lookup; the adapter built per attempt is wrapped with a tracing/metrics decorator; the log writer emits a per-batch persistence span (linked to the originating requests' spans) and the authoritative cost counters exactly once per durably-written row; tracer-provider boot happens in `main.ts` before Nest and flushes on graceful shutdown. One **minimal additive `@polyrouter/data-plane` seam**: the chain-runner options gain an optional breaker-state observation callback (alongside the existing `onOpen`) so the proxy can maintain a true breaker **state** gauge (TODOS #21) — no behavior change, existing callers unaffected.

Out of scope: frontend/dashboard for metrics (per-tenant dashboards are cloud-tier, §3.5), tracing the control-plane CRUD API, exemplars, and OTel metrics (Prometheus is the metrics contract per spec).

## Capabilities

### New Capabilities
- `observability`: OTel trace emission for proxied requests (span chain auth → routing → upstream → recording) and the Prometheus metrics endpoint (latency/error/token/cost per provider/model/layer, breaker + writer health), both env-gated and incapable of affecting request outcomes.

### Modified Capabilities

<!-- none — request-recording behavior is unchanged; the recorder/writer only gain a pass-through provider-name field and metric side effects -->

## Impact

- **Dependencies (new, control-plane):** `prom-client`; `@opentelemetry/api` (pinned to the 1.9.x line), `@opentelemetry/sdk-trace-node` + `@opentelemetry/exporter-trace-otlp-http` + `@opentelemetry/resources` + `@opentelemetry/semantic-conventions` (one tested stable 2.x SDK release); dev-only `@opentelemetry/sdk-trace-base` (in-memory exporter for tests). All are the canonical, spec-named choices (§3.2.6); no auto-instrumentation packages.
- **Code:** new `control-plane/src/observability/` (config, tracing bootstrap, metrics service, `/metrics` controller, adapter-decorator); touches `main.ts` (tracer boot/shutdown), `app.setup.ts` (root-span middleware), the agent-key guard (auth span), `proxy.service.ts` (routing span, adapter wrap in `buildAdapter`, breaker hooks), `request-recorder.ts`/`log-writer.ts` (metric emission, persistence spans, `protocol`/`providerName` pass-through); **data-plane:** the additive chain-option callback above (+ its unit coverage).
- **Config:** registers `OTEL_ENABLED` (default false), `METRICS_ENABLED` (default true), `OTEL_SERVICE_NAME` (default `polyrouter`), and `OTEL_EXPORTER_OTLP_ENDPOINT` (optional URL — validated fail-fast at boot when tracing is enabled; absent falls back to the exporter's standard default).
- **Endpoints:** adds unauthenticated instance-level `GET /metrics` (metadata-only aggregates; the docs note operators should network-guard it like `/health`; `BIND_ADDRESS` defaults to loopback).
- **Tests:** e2e metrics scrape + disabled-404; in-memory-exporter span-chain assertions (incl. error attribution on a failing provider, streaming completion/abort); unit coverage for label mapping, cost exactly-once-under-retry, and the drop hook; existing suites stay green with fixture-only updates where recording drafts gained pass-through fields (default posture = tracing off, metrics on).
