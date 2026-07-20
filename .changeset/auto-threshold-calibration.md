---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
---

Per-tenant structural-threshold self-calibration (add-auto-threshold-calibration):
an opt-in, scheduled BullMQ sweep nudges each tenant's `auto` high/low
thresholds from their OWN quality-decided cascade outcomes inside hard rails —
minimum fresh edge-zone samples (epoch-stamped at decision time), bounded step,
hysteresis, an anchored max-drift cap (changed instance defaults instantly
inert and then rebase stale pairs), a minimum band gap enforced on every final
candidate, and per-edge cooldown. Escalations now record WHY they escalated
(`escalation_source`: `quality_gate` vs `cheap_error`) so provider faults can
never read as routing mistakes. Calibrated pairs ride the existing hot-path
settings read (zero new per-request queries) and degrade to instance defaults
on any fault. Every move/revert/rebase appends a numbers-only audit event; the
Routing page gains the Self-calibration section — toggle, effective thresholds,
one-click revert, and the visible threshold-change history — and the
auto-layers API reports the instance/calibrated/effective trio. Six new
`CALIBRATION_*` env keys with fail-fast validation.
