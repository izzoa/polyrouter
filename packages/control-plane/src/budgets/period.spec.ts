import { periodInfo, toMicros } from './period';

const DAY = 86_400_000;

describe('toMicros', () => {
  it('converts USD to exact integer micro-dollars', () => {
    expect(toMicros(1.23)).toBe(1_230_000);
    expect(toMicros(10)).toBe(10_000_000);
    expect(toMicros(0)).toBe(0);
    expect(toMicros(0.000001)).toBe(1);
  });
});

describe('periodInfo — day', () => {
  it('bounds the UTC day containing `at`', () => {
    const p = periodInfo('day', new Date(Date.UTC(2026, 2, 15, 12, 30)));
    expect(p.periodId).toBe('2026-03-15');
    expect(p.startMs).toBe(Date.UTC(2026, 2, 15));
    expect(p.endMs).toBe(Date.UTC(2026, 2, 16));
  });

  it('is stable across the whole day (inclusive start, exclusive end)', () => {
    const start = periodInfo('day', new Date(Date.UTC(2026, 2, 15, 0, 0, 0, 0)));
    const end = periodInfo('day', new Date(Date.UTC(2026, 2, 15, 23, 59, 59, 999)));
    expect(start.periodId).toBe('2026-03-15');
    expect(end.periodId).toBe('2026-03-15');
    // the next instant rolls to a new period
    expect(periodInfo('day', new Date(Date.UTC(2026, 2, 16, 0, 0, 0, 0))).periodId).toBe(
      '2026-03-16',
    );
  });
});

describe('periodInfo — month', () => {
  it('bounds the UTC calendar month', () => {
    const p = periodInfo('month', new Date(Date.UTC(2026, 2, 15)));
    expect(p.periodId).toBe('2026-03');
    expect(p.startMs).toBe(Date.UTC(2026, 2, 1));
    expect(p.endMs).toBe(Date.UTC(2026, 3, 1));
  });

  it('rolls the year over at December', () => {
    const p = periodInfo('month', new Date(Date.UTC(2026, 11, 31, 23, 59)));
    expect(p.periodId).toBe('2026-12');
    expect(p.endMs).toBe(Date.UTC(2027, 0, 1));
  });
});

describe('periodInfo — ISO week', () => {
  it('starts on Monday, spans 7 days, contains `at`', () => {
    const at = new Date(Date.UTC(2026, 5, 17, 9)); // a Wednesday
    const p = periodInfo('week', at);
    expect(new Date(p.startMs).getUTCDay()).toBe(1); // Monday
    expect(p.endMs - p.startMs).toBe(7 * DAY);
    expect(p.startMs).toBeLessThanOrEqual(at.getTime());
    expect(at.getTime()).toBeLessThan(p.endMs);
    expect(p.periodId).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('attributes a year-crossing week to its ISO year (Thursday rule)', () => {
    // 2026-01-01 is a Thursday, so ISO week 1 of 2026 starts Mon 2025-12-29.
    const p = periodInfo('week', new Date(Date.UTC(2026, 0, 1, 12)));
    expect(p.periodId).toBe('2026-W01');
    expect(p.startMs).toBe(Date.UTC(2025, 11, 29));
    expect(p.endMs).toBe(Date.UTC(2026, 0, 5));
    // Dec 31 2025 falls in the same ISO week 1 of 2026
    expect(periodInfo('week', new Date(Date.UTC(2025, 11, 31))).periodId).toBe('2026-W01');
  });
});
