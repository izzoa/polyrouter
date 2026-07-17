---
'@polyrouter/control-plane': patch
---

Observability polish (FABLE_AUDIT A-35/A-36/A-37): register `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` so a malformed per-signal traces endpoint fails boot like the generic one (and it flows through the compose pass-through); add an `outcome` label to `polyrouter_upstream_duration_seconds` so a client-abort (`canceled`) duration forms a distinct series and no longer pollutes success-latency quantiles. (The `provider` label remains the display name by design — legibility over rename-stability.)
