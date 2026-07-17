# Tasks: fix-analytics-keyset-cursor

## 1. Full-precision cursor (E3.1)

- [x] 1.1 `packages/shared/src/server/persistence.ts`: change `AnalyticsRequestsCursor.createdAt` from `Date` to `string` (the full-precision `created_at::text` value)
- [x] 1.2 `packages/control-plane/src/database/analytics.queries.ts` `listRequests`: select `createdAtText: sql<string>\`${requestLogs.createdAt}::text\`` alongside the row columns (via `getTableColumns(requestLogs)`); strip `createdAtText` from `page` before passing to `enrich` so it never leaks into the safe view
- [x] 1.3 `analytics.queries.ts` `encodeCursor`: encode `row.createdAtText` (the full-precision string) instead of `row.createdAt.toISOString()`
- [x] 1.4 `analytics.queries.ts` cursor predicate (~356-366): bind the cursor's string `createdAt` as a `::timestamptz` in the `lt`/`eq` comparisons (raw SQL: `${requestLogs.createdAt} < ${cursor.createdAt}::timestamptz`, and `= …::timestamptz` for the tie), keeping `lt(requestLogs.id, cursor.id)` for the PK tie-break
- [x] 1.5 `packages/control-plane/src/analytics/analytics.service.ts` `parseCursor`: keep the timestamp segment as the decoded **string** (validate it parses as a date for a clean 422, but store the original string, not `new Date(...)`)

## 2. µs-realistic regression test (E3.2)

- [x] 2.1 `packages/control-plane/test/analytics/analytics.e2e-spec.ts`: add a case that inserts ≥3 rows via `port.requestLogs.insertMany` **without** `created_at` (DB-default shared-µs `now()`), and one seeding explicit-microsecond `created_at` (e.g. `...T11:30:00.123456Z`); walk `/api/analytics/requests` (or the accessor) with `limit=1`, collect ids across pages, assert every id appears **exactly once**
- [x] 2.2 Confirm the new test FAILS on the current cursor (rows skipped) and PASSES after §1 (temporarily stash the fix to see the failure, then restore)

## 3. Definition of done

- [x] 3.1 `npm run build`, `npm run lint`, `npm run typecheck` green; `npm test -w packages/control-plane` + the analytics e2e green (`npm run test:e2e -w packages/control-plane -- --testPathPattern analytics`); full e2e green (reap stray jest workers + `redis-cli FLUSHALL` before a clean run)
- [x] 3.2 No migration; the safe view still omits ownership columns and `createdAtText`; existing analytics tests (summary/timeseries/breakdown/range) stay green; a changeset added (`npx changeset`, patch/minor); `openspec validate fix-analytics-keyset-cursor --type change --strict --no-interactive` passes
