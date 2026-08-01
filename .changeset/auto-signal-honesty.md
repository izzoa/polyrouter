---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
---

Auto-performance now surfaces per-agent L1 signal quality. When a stable
agent's structural score collapses to a near-constant (its modal two-decimal
score bucket covers ≥ 50% of ≥ 50 ambiguous-band requests in range), the
Auto-performance card names the agent, the score, and the share — with
availability-aware guidance (pin a tier, or enable/configure L2 · Semantic,
which evaluates exactly that ambiguous slice). Below the evidence floor no
verdict is rendered, and a neutral coverage line discloses unassessed agents
so insufficient evidence never reads as healthy. `GET /api/analytics/auto`
gains the per-agent `signalQuality` block. Read-time aggregation only — no
routing behavior, hot-path, or schema change.
