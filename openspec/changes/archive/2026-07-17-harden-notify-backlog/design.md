## Decisions

- **A-32:** the weekly emit is keyed by the occurrence (`lifecycleId = period`) and deduplicated, so a
  BullMQ retry re-runs the aggregation but each owner's summary emits at most once per occurrence — no
  double-send. Adding `attempts: 4` + exponential backoff (matching the delivery `BASE_JOB_OPTS`) turns a
  transient run failure from a silently-dropped week into a retried one.
- **A-34:** a config change (new target/credentials) invalidates the prior `test-send` result, so
  `update` clears `last_test_status`/`last_test_at` whenever `dto.config` is present; a metadata-only
  update (name/enabled/events) leaves the result intact.

## Risks / Trade-offs

- A-32 relies on the occurrence idempotency (already spec'd + tested) — a retry cannot double-emit.

## Migration Plan

None — job-option + patch change; no schema.
