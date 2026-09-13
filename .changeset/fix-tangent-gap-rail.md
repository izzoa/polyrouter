---
'@polyrouter/control-plane': patch
---

Fix a threshold-calibration rail that could permanently freeze a tenant's
calibrator. The minimum gap (0.1) equals twice the edge width (2 x 0.05), so a
calibrated pair landing on exactly the minimum gap passed the writer's gap check
and was then inerted by the halt rule — leaving the tenant with a pair no move
could widen and no hygiene pass would retire. Admission and the hot-path
re-validation now share one predicate requiring both bounds, so such a pair can
no longer be written, and any already stored is read as inert: routing falls back
to the instance defaults, calibration resumes, and the next run rebases the row.
No migration, and no change to any threshold constant.
