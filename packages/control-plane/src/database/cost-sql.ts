import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Row-level integer micro-dollars: `Σ round(cost × 1e6)` — rounded **per row** (not
 * sum-then-round) with null → 0. The single source of truth for every spend reader
 * (budget enforcement #16, analytics, the weekly summary #15b): they all sum with this
 * identical expression and convert to dollars once at the edge (`micros / 1_000_000`),
 * so their figures reconcile exactly instead of drifting at the sub-µ$ margin a raw
 * float `sum(cost)` would introduce (invariant 4 — cost is one immutable number).
 */
export function microsSum(col: AnyPgColumn): SQL<number> {
  return sql<number>`coalesce(sum(round(coalesce(${col}, 0) * 1000000)), 0)`;
}

/** `microsSum` restricted to rows matching `cond` — identical per-row rounding, so a
 * split (e.g. native_family-priced spend) reconciles exactly with the total it is a
 * portion of (add-native-price-fallback). */
export function microsSumIf(col: AnyPgColumn, cond: SQL): SQL<number> {
  return sql<number>`coalesce(sum(case when ${cond} then round(coalesce(${col}, 0) * 1000000) else 0 end), 0)`;
}

/* ── Spend components (split-subscription-spend) ───────────────────────────────────
 *
 * A row's component is decided by its IMMUTABLE `provider_kind` snapshot — never by a
 * join against current provider configuration, which would let today's config
 * reclassify a past request (invariant 4):
 *
 *   subscription            → prepaid at a flat rate; NOT money owed
 *   api_key/custom/local    → cash; money owed
 *   NULL                    → unknown (predates the column); counted, but never
 *                             *described* as cash
 *
 * Every spend reader — the seven analytics sums AND budget metering — routes through
 * these, so a chart, a breakdown panel and a budget counter cannot disagree about what
 * a dollar means. `IS DISTINCT FROM` (not `<>`) is load-bearing: a plain inequality is
 * NULL for NULL rows, which would silently drop every pre-snapshot row from the total.
 */

/** True for rows that represent money owed — i.e. everything except subscription. */
export function isCashLike(kindCol: AnyPgColumn): SQL {
  return sql`${kindCol} IS DISTINCT FROM 'subscription'`;
}

/** Spend excluding prepaid subscription traffic: the reported total, and what a
 * `cash`-basis budget meters. Includes unknown rows (conservative — a row we cannot
 * classify keeps its prior treatment). */
export function cashMicrosSum(col: AnyPgColumn, kindCol: AnyPgColumn): SQL<number> {
  return microsSumIf(col, isCashLike(kindCol));
}

/** The prepaid component, reported but never added to spend. */
export function subscriptionMicrosSum(col: AnyPgColumn, kindCol: AnyPgColumn): SQL<number> {
  return microsSumIf(col, sql`${kindCol} = 'subscription'`);
}

/** Rows recorded before the snapshot existed. Inside the reported total, but surfaced
 * separately so nothing claims they are known cash. */
export function unknownMicrosSum(col: AnyPgColumn, kindCol: AnyPgColumn): SQL<number> {
  return microsSumIf(col, sql`${kindCol} IS NULL`);
}

/** True only for rows known to be cash — excludes unknown, unlike `isCashLike`. */
export function isKnownCash(kindCol: AnyPgColumn): SQL {
  return sql`${kindCol} IS NOT NULL AND ${kindCol} <> 'subscription'`;
}

/** Strictly-cash spend (excludes unknown) — lets a presentation layer show a pure cash
 * figure without inferring one by subtraction. */
export function knownCashMicrosSum(col: AnyPgColumn, kindCol: AnyPgColumn): SQL<number> {
  return microsSumIf(col, isKnownCash(kindCol));
}
