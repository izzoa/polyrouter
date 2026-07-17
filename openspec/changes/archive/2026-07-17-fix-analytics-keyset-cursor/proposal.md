# Proposal: fix-analytics-keyset-cursor

Implements **FABLE_AUDIT.md Epic E3** (a P1 audit epic, HIGH finding — found independently by two
auditors). **Spec refs:** `openspec/specs/analytics-api`, `openspec/specs/dashboard-analytics`; spec.md §9.

## Why

The analytics request listing silently **drops rows** across page boundaries. `request_log.created_at`
is `timestamptz` populated by `now()` (microsecond precision), and the LogWriter flushes each owner's
drafts in **one multi-row `INSERT`**, so every row in a batch shares one identical µs-precision
timestamp. The keyset cursor round-trips `created_at` through a millisecond-precision JS `Date`
(`toISOString()`), so the next-page predicate `created_at < cursor OR (created_at = cursor AND id <
cursorId)` compares a truncated `.123` against a stored `.123456` — matching neither branch, so any
page boundary landing inside a same-timestamp batch **silently skips the remainder of that tie group**.

The dropped rows are still counted in the summary aggregates, so the dashboard is silently inconsistent
with itself. The existing e2e can't catch it (all seeds are `.000`-millisecond-clean, which round-trip
losslessly). This violates the analytics-api requirement that "walking all pages returns every in-range
row exactly once."

## What Changes

- **Full-precision cursor (E3.1):** `listRequests` selects the raw timestamp text
  (`created_at::text`) alongside each row; `encodeCursor` encodes that string (not a JS `Date`); the
  cursor's `createdAt` field becomes a **string**; and the next-page predicate binds it back as a
  `::timestamptz` so Postgres compares at full stored precision. `parseCursor` keeps the timestamp as a
  validated string. Code-only — no migration, fixes historical rows, and preserves the existing
  `(owner_user_id, created_at)` index eligibility (the parameter is cast, not the indexed column; the
  small in-tie-group `id` sort is unchanged from before). The cursor timestamp is emitted with a
  DateStyle-independent `to_char` UTC/µs format and validated against that exact grammar.
- **µs-realistic regression test (E3.2):** a pagination e2e that inserts rows via
  `port.requestLogs.insertMany` **without** an explicit `created_at` (DB-default shared-µs `now()`),
  plus one seeding explicit-microsecond values, then walks pages with `limit=1` asserting exactly-once
  coverage. Fails on the current code, passes after the fix.

## Capabilities

### New Capabilities

*None.*

### Modified Capabilities

- `analytics-api`: the keyset-pagination requirement is sharpened to make explicit that the cursor
  SHALL preserve the stored timestamp's **full precision** (not a millisecond-truncated round-trip), so
  a batch of rows sharing one microsecond-precision `created_at` pages exactly once. (The "exactly
  once" guarantee already exists; this makes the precision requirement — the actual defect — explicit
  and adds the microsecond-batch scenario.)

## Impact

- **Modified (production):** `packages/control-plane/src/database/analytics.queries.ts` (`listRequests`
  select + cursor predicate, `encodeCursor`), `packages/control-plane/src/analytics/analytics.service.ts`
  (`parseCursor`), `packages/shared/src/server/persistence.ts` (`AnalyticsRequestsCursor.createdAt:
  Date → string`).
- **Modified (tests):** `packages/control-plane/test/analytics/analytics.e2e-spec.ts` (µs-realistic
  pagination case).
- **Schema/migration:** none (the string-cursor approach avoids a migration on the hot `request_log`
  table). **Changeset:** required (user-facing: dashboard pagination no longer drops rows).
- **Dependencies:** none (`getTableColumns` from the already-present `drizzle-orm`).

## Non-goals

- Migrating `request_log.created_at` to `timestamptz(3)` — the heavier alternative (a migration on the
  hottest table, rounding stored values); the string-cursor fix is code-only and precise.
- Any change to the summary/timeseries/breakdown aggregates, the range validation, or the safe-view
  column stripping.
