## Why

Two notification backlog nits (FABLE_AUDIT A-32, A-34):

- **A-32** The weekly-summary scheduler upserts its BullMQ job with retention bounds but **no `attempts`**
  — a single transient fault (a DB/Redis blip during the run) silently drops the whole week's summary,
  even though the occurrence is idempotent (dedup'd per scope+period), so a retry is safe.
- **A-34** A channel `update` that changes the config does not clear `last_test_status`, so the UI keeps
  showing a stale "success" for a target/credentials that changed.

## What Changes

- **A-32** Add `attempts: 4` + exponential backoff to the weekly-summary job (mirroring the delivery jobs'
  `BASE_JOB_OPTS`); the occurrence-keyed idempotent emit makes retries safe (no double-send).
- **A-34** On a channel `update` that changes the config, reset `last_test_status`/`last_test_at` to null
  (a metadata-only update keeps the prior result).

## Capabilities

### Modified Capabilities

- `notification-producers`: the weekly-summary job retries a transient failure (safe under its idempotent
  occurrence keying) instead of dropping the summary.
- `notification-channels`: a channel config change clears the stale test result.

## Impact

- **Code:** `weekly-summary.scheduler.ts` (job `attempts`/`backoff`), `channels.service.ts` (clear
  `last_test_status`/`last_test_at` on a config change). No schema change.
- **Tests:** notifications e2e — a config-changing update clears the test status, a metadata-only update
  keeps it. No changeset (internal hardening).
