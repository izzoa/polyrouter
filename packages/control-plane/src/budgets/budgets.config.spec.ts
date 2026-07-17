import { assertStalenessConsistent, type BudgetsConfig } from './budgets.config';

const base: BudgetsConfig = {
  redisTimeoutMs: 50,
  reconcileTimeoutMs: 2_000,
  cacheTtlMs: 10_000,
  cacheMax: 5_000,
  failOpen: true,
  schedEnabled: true,
  schedCron: '* * * * *', // every minute
  staleMs: 180_000, // 3 min
};

describe('assertStalenessConsistent (A-16)', () => {
  it('accepts the shipped default (per-minute cron, 3-minute stale)', () => {
    expect(() => assertStalenessConsistent(base)).not.toThrow();
  });

  it('rejects a staleness bound shorter than 2× the cron interval', () => {
    // hourly cron = 3.6M ms fire interval; needs >= 7.2M ms stale, default is 180k.
    expect(() => assertStalenessConsistent({ ...base, schedCron: '0 * * * *' })).toThrow(
      /BUDGET_STALE_MS/,
    );
  });

  it('rejects an every-5-minute cron with the 3-minute default (5min gap needs >= 10min)', () => {
    expect(() => assertStalenessConsistent({ ...base, schedCron: '*/5 * * * *' })).toThrow(
      /BUDGET_STALE_MS/,
    );
  });

  it('accepts an every-5-minute cron when stale clears 2× the interval', () => {
    expect(() =>
      assertStalenessConsistent({ ...base, schedCron: '*/5 * * * *', staleMs: 700_000 }),
    ).not.toThrow();
  });

  it('exempts a disabled scheduler (its always-stale state is intended)', () => {
    expect(() =>
      assertStalenessConsistent({
        ...base,
        schedEnabled: false,
        schedCron: '0 * * * *',
        staleMs: 1_000,
      }),
    ).not.toThrow();
  });

  it('surfaces an invalid cron as a boot error', () => {
    expect(() => assertStalenessConsistent({ ...base, schedCron: 'not a cron' })).toThrow();
  });

  const MONDAY = new Date('2026-01-05T08:00:00Z');

  it('catches a monthly schedule (its ~month-long gap far exceeds any sane bound)', () => {
    // Sampling real fires (not cron fields) surfaces the ~30-day gap directly.
    expect(() =>
      assertStalenessConsistent({ ...base, schedCron: '0 0 1 * *', staleMs: 999_999_999 }, MONDAY),
    ).toThrow(/BUDGET_STALE_MS/);
  });

  it('catches an every-day business-hours cron whose 16h overnight gap exceeds the bound', () => {
    // `0 9-17 * * *` fires daily but has a 17:00 → 09:00 = 16h overnight gap; the fire walk
    // reaches it (a few-sample-from-9am check would miss it).
    expect(() =>
      assertStalenessConsistent({ ...base, schedCron: '0 9-17 * * *', staleMs: 7_200_000 }, MONDAY),
    ).toThrow(/BUDGET_STALE_MS/);
  });

  it('accepts an every-day business-hours cron when the stale bound clears the overnight gap', () => {
    expect(() =>
      assertStalenessConsistent(
        { ...base, schedCron: '0 9-17 * * *', staleMs: 200_000_000 }, // > 16h × 2 = 115.2M
        MONDAY,
      ),
    ).not.toThrow();
  });

  it('catches an hourly weekday cron via its weekend gap (real-fire sampling handles DOW)', () => {
    // `0 * * * 1-5`: the Fri 23:00 → Mon 00:00 gap (49h) is reached within the walk, so a
    // day-of-week restriction is caught by its real gap — no cron-field length heuristics.
    expect(() =>
      assertStalenessConsistent({ ...base, schedCron: '0 * * * 1-5', staleMs: 7_200_000 }, MONDAY),
    ).toThrow(/BUDGET_STALE_MS/);
  });
});
