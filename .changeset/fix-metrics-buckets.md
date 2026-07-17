---
'@polyrouter/control-plane': patch
---

Fix the proxy latency histograms and cover the production tracing switch (FABLE_AUDIT epic E15):

- **The duration histograms now use LLM-scale buckets.** `polyrouter_request_duration_seconds` and `polyrouter_upstream_duration_seconds` were built with prom-client's defaults, whose largest finite bucket is 10s — but streamed LLM completions routinely run 10s to minutes, so every such observation landed only in `+Inf`, making `histogram_quantile` report ~10s for all real traffic and per-provider latency comparison above 10s impossible. Both histograms now use explicit buckets `[0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600]` (sub-second to 10 minutes), so a 90s request lands in a finite bucket. This changes the histogram bucket boundaries (dropping the default sub-100ms boundaries, which are noise for LLM latency); Prometheus records the new boundaries going forward and historical series are unaffected.
- **The enabled-tracing switch is now regression-tested.** `initTracing`/`shutdownTracing` (the `OTEL_ENABLED` gate, OTLP exporter, and batch processor) were never executed by any test — every suite registered its own in-memory provider — so a regression in the real switch could ship undetected. A new `tracing.spec.ts` asserts it registers a recording provider under `OTEL_ENABLED=true` without throwing or blocking a request against an unreachable collector, drains cleanly on shutdown, and is a no-op when disabled. Test-only — no runtime change to tracing.
