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
