---
"@polyrouter/shared": minor
"@polyrouter/data-plane": minor
"@polyrouter/control-plane": minor
"@polyrouter/frontend": minor
---

**Semantic workloads (Epic W, W-3).** The flag-gated semantic module gains a second workload source: for a structural-`none` `auto` request it embeds ONCE (bounded by the existing semantic rails) and compares the vector to bundled, versioned per-class anchors; `research` / `writing` are recorded with `workload_source = 'semantic'` and a `semantic/<taxonomy>/<classifier>/<digest>` revision, and route through the existing `auto_workload` rules — only when the winning class leads every other by `SEMANTIC_WORKLOAD_MARGIN` (0.05) and clears `SEMANTIC_WORKLOAD_MIN_SIM` (0.20). Precedence: a structural class always wins; the semantic source never emits `code` / `vision` / `structured`; Layer 2 reuses the same vector (a request is never embedded twice; a failed stage embed skips Layer 2 for that request); every fault degrades to the unclaimed flow; the quad follows W-2's atomic commit. New auto-layers fields `semanticWorkloadAvailable` / `semanticWorkload` (rides the semantic preference); the Workload-targets card's `research` / `writing` rows go live exactly when that is effective and name the missing half otherwise; the mix footnote and README follow. No migration.
