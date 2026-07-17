## 1. A-32 — retry the idempotent weekly job

- [x] 1.1 Add `attempts: 4` + exponential backoff to the weekly-summary scheduler's job opts (safe: occurrence-keyed idempotent emit).

## 2. A-34 — clear the stale test status on a config change

- [x] 2.1 In `channels.service.ts` `update`, when `dto.config` is present, set `last_test_status`/`last_test_at` to null; a metadata-only update keeps the prior result.
- [x] 2.2 e2e: a config-changing update clears the test status; a name-only update keeps it.

## 3. Wrap-up

- [x] 3.1 build/lint/typecheck green; notifications e2e green.
- [x] 3.2 Update TODOS + mark A-32/A-34 ✅ in FABLE_AUDIT after archive.
