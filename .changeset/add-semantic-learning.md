---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

Layer-2 learning loop (add-semantic-learning): per-tenant learned centroids that
track each tenant's own outcome-labeled traffic, opt-in and default OFF. When a
cascade outcome settles for a request Layer 2 found ambiguous AND whose tenant had
learning ON at decision time, the request's in-memory embedding is labeled from the
cascade result (quality-passed → `low`, quality-gate escalation → `high`, everything
else → nothing) and accumulated in bounded volatile memory, flushing to Redis only a
≥ `SEMANTIC_LEARNING_MIN_COHORT` sum — no persisted value is ever a single raw
embedding. A daily BullMQ sweep folds fixed-window pending evidence into learned
centroids under rails (min fresh samples, capped EMA, SPHERICAL drift clamp toward the
bundled anchors, cooldown, exact evidence-revision match), crash-atomically across
Redis + Postgres via separate revocation-epoch and active-generation counters (rotate
→ stage → Postgres `FOR UPDATE` CAS + idempotent scalars-only audit → promote).
Classification supersedes bundled with learned centroids only when every read-time gate
passes (learning on, `(epoch, generation)` match, TTL, evidence-revision, both labels
validate); any gate failure or Redis fault falls back to bundled — never the layer's
skip. A one-action revert bumps the revocation epoch (Postgres-first, race-proof) then
clears Redis. Privacy is absolute: raw embeddings live only in request-scoped or
bounded volatile memory; the only persisted artifacts are aggregates, Redis-only, under
domain-separated HMAC tenant digests, never in Postgres, a log, a metric, or an API
response. Gated entirely on the optional semantic stack — the baseline image is
unaffected. New env: `SEMANTIC_LEARNING_{MIN_COHORT,MIN_SAMPLES,ALPHA,MAX_DRIFT,COOLDOWN_H,STATE_TTL_D,MAX_COHORTS,SCHED_ENABLED,SCHED_CRON}`.
