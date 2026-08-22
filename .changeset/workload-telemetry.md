---
"@polyrouter/shared": minor
"@polyrouter/data-plane": minor
"@polyrouter/control-plane": minor
"@polyrouter/frontend": minor
---

`auto` requests now record a **workload** class (code / vision / structured / none — telemetry only): a pure structural classifier over the existing Layer-1 feature vector rides every L1 evaluation and lands four columns on parent request-log rows (`workload_class/score/source/revision`, migration 0026). Nothing routes on it yet. The inspector shows a workload chip, `GET /api/analytics/auto` gains `workloadMix` (per-class requests + reported-basis spend on both ledgers, with unpriced/coverage/revision disclosures), and the Auto-performance card gains a "Workload mix" block. New optional `ROUTING_WORKLOAD_THRESHOLDS` (`codeShare`, `codeMinChars`).
