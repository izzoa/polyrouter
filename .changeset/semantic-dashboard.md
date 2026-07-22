---
'@polyrouter/frontend': minor
'@polyrouter/control-plane': minor
---

Layer-2 semantic dashboard + batteries-included image variant (add-semantic-dashboard).
The permanently-locked "L2 · Semantic" stub becomes a real driven toggle in the Routing
page's layer list — `semantic`/`semanticAvailable` from the auto-layers API, honored per
tenant live, with honest copy: available → "Embedding classifier over the ambiguous
slice"; unavailable → an "off instance-wide" affordance naming `SEMANTIC_MODEL_PATH`. No
inert control and no "cloud tier" contradiction remain. When the semantic layer is
effective a **learning card** (calibration-card pattern) renders: the opt-in learning
toggle, a status line (fresh per-label sample counts, last-applied time, active
`learned`/`bundled` source), the numeric audit history, and a confirmed one-click
**Revert to bundled** — honest under degradation, a stale/version-mismatched learned
centroid shows `source: bundled` WITH the reason, never a silent wrong "learned" badge.
Auto-performance gains the semantic slice from an extended analytics aggregation:
evaluated count, routed-per-band counts, their four-way outcome split (success / fallback
/ error / cancelled, disjoint + exhaustive over the routed total), and the bundled/learned
source split over evaluated rows — with a residual-cascade denominator footnote and every
cascade-derived figure (savings, pass rates) labeled residual-only so pre-/post-enable
comparisons stay honest. No figure claims learning EFFECTIVENESS (no counterfactual
exists). The request inspector carries a `semantic_source` provenance chip. Legacy rows
with no semantic telemetry render the section's existing empty affordance — never
fabricated zeros. Packaging: a multi-arch **`-semantic` image variant** built from the
same Dockerfile (`--target runtime-semantic`, glibc base, exact-pinned `onnxruntime-node`
with the CUDA postinstall disabled, the reference `all-MiniLM-L6-v2` model — Apache-2.0 —
downloaded checksum-pinned at BUILD time and baked in, `SEMANTIC_MODEL_PATH` preset), a
`docker-compose.semantic.yml` override with bring-your-own-model support, and a release
smoke test that loads the baked model + runs one warmup inference on BOTH arches before
publish. The baseline image stays ORT- and model-free (the CI neutrality assertion is the
permanent gate).
