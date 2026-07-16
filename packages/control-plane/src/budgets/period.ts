/** UTC calendar-period math for spend budgets (#16, spec §10). A window is a
 * resetting calendar period; a counter key embeds the period id, so a new period
 * starts at zero. All arithmetic is in UTC epoch ms (no DST, 86_400_000 ms/day
 * is exact), and every function is pure (deterministic in `at`) for unit tests. */

export type BudgetWindow = 'day' | 'week' | 'month';

const DAY_MS = 86_400_000;

export interface PeriodInfo {
  /** Stable, human-legible id for the calendar period (part of the counter key). */
  readonly periodId: string;
  /** UTC epoch ms of the period start (inclusive). */
  readonly startMs: number;
  /** UTC epoch ms of the period end (exclusive) — the next period's start. */
  readonly endMs: number;
}

/** USD → integer micro-dollars (µ$). Exact-integer money so counters never drift
 * on float addition; thresholds compare `µ$ ≥ round(amount × 1e6)`. */
export function toMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The UTC calendar period containing `at` for the given window. */
export function periodInfo(window: BudgetWindow, at: Date): PeriodInfo {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth(); // 0-11
  const d = at.getUTCDate();

  if (window === 'day') {
    return {
      periodId: `${y}-${pad2(m + 1)}-${pad2(d)}`,
      startMs: Date.UTC(y, m, d),
      endMs: Date.UTC(y, m, d + 1),
    };
  }
  if (window === 'month') {
    return {
      periodId: `${y}-${pad2(m + 1)}`,
      startMs: Date.UTC(y, m, 1),
      endMs: Date.UTC(y, m + 1, 1),
    };
  }

  // ISO-8601 week: Monday-start; week 1 is the week containing the first Thursday
  // (equivalently, Jan 4). The period's ISO year is the year of its Thursday.
  const dayStartMs = Date.UTC(y, m, d);
  const isoDow = (new Date(dayStartMs).getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const mondayMs = dayStartMs - isoDow * DAY_MS;
  const thursday = new Date(mondayMs + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const jan4Ms = Date.UTC(isoYear, 0, 4);
  const jan4Dow = (new Date(jan4Ms).getUTCDay() + 6) % 7;
  const week1MondayMs = jan4Ms - jan4Dow * DAY_MS;
  const weekNum = Math.round((mondayMs - week1MondayMs) / (7 * DAY_MS)) + 1;
  return {
    periodId: `${isoYear}-W${pad2(weekNum)}`,
    startMs: mondayMs,
    endMs: mondayMs + 7 * DAY_MS,
  };
}
