import { describe, expect, it } from 'vitest';
import { fmtAsOf, fmtReset, fmtUntil, fmtUsd, fmtWhen } from './format';

describe('fmtUsd — per-1M price display', () => {
  it('kills float64 noise from the ×1e6 listed-price derivation', () => {
    expect(fmtUsd(0.19999999999999998)).toBe('$0.2');
    expect(fmtUsd(0.7999999999999999)).toBe('$0.8');
  });

  it('preserves every real price shape untouched', () => {
    expect(fmtUsd(3)).toBe('$3');
    expect(fmtUsd(2.5)).toBe('$2.5');
    expect(fmtUsd(0.74)).toBe('$0.74');
    expect(fmtUsd(15)).toBe('$15');
    expect(fmtUsd(0.0375)).toBe('$0.0375'); // small real prices survive (no toFixed(2) flattening)
  });

  it('degrades safely on non-finite input', () => {
    expect(fmtUsd(Number.NaN)).toBe('$?');
    expect(fmtUsd(Infinity)).toBe('$?');
  });
});

describe('fmtWhen — relative time (hoisted from the agents table)', () => {
  const NOW = Date.parse('2026-09-24T12:00:00Z');
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it('seconds read as "just now"', () => {
    expect(fmtWhen(ago(0), NOW)).toBe('just now');
    expect(fmtWhen(ago(59_000), NOW)).toBe('just now');
  });

  it('minutes and hours read as "Nm ago" / "Nh ago"', () => {
    expect(fmtWhen(ago(12 * 60_000), NOW)).toBe('12m ago');
    expect(fmtWhen(ago(59 * 60_000), NOW)).toBe('59m ago');
    expect(fmtWhen(ago(3 * 3_600_000), NOW)).toBe('3h ago');
  });

  it('a day or more reads as the calendar date', () => {
    const iso = ago(2 * 86_400_000);
    expect(fmtWhen(iso, NOW)).toBe(new Date(Date.parse(iso)).toLocaleDateString());
  });

  it('missing or unparseable reads as "never"', () => {
    expect(fmtWhen(null, NOW)).toBe('never');
    expect(fmtWhen('not a date', NOW)).toBe('never');
  });
});

describe('fmtUntil — a future end as an absolute clock time (classify-plan-quota-errors)', () => {
  const NOW = Date.parse('2026-11-06T12:00:00Z');

  it('an end on the same calendar day is the clock time and the zone', () => {
    expect(fmtUntil('2026-11-06T18:00:00Z', NOW, 'UTC')).toBe('18:00 UTC');
  });

  it('an end on another day adds the month and day', () => {
    expect(fmtUntil('2026-11-09T18:00:00Z', NOW, 'UTC')).toBe('Nov 9, 18:00 UTC');
  });

  it('midnight reads 00:00, never 24:00', () => {
    expect(fmtUntil('2026-11-07T00:00:00Z', NOW, 'UTC')).toBe('Nov 7, 00:00 UTC');
  });

  it('"same day" is the viewer zone calendar day, not UTC', () => {
    // 23:30 UTC on the 6th is already the 7th in Tokyo (UTC+9): not the same day as 12:00 UTC.
    expect(fmtUntil('2026-11-06T23:30:00Z', NOW, 'Asia/Tokyo')).toMatch(/^Nov 7, 08:30 /);
  });

  it('is null for a past instant, the present instant and an invalid value', () => {
    expect(fmtUntil('2026-11-06T11:59:59Z', NOW, 'UTC')).toBeNull();
    expect(fmtUntil('2026-11-06T12:00:00Z', NOW, 'UTC')).toBeNull();
    expect(fmtUntil('not a date', NOW, 'UTC')).toBeNull();
  });
});

describe('fmtReset — a plan-usage reset, with the year outside the current one (add-subscription-quota-display)', () => {
  const NOW = Date.parse('2026-11-06T13:40:00Z');

  it('a reset today or in the current year names no year, exactly as fmtUntil reads it', () => {
    expect(fmtReset('2026-11-06T14:10:00Z', NOW, 'UTC')).toBe('14:10 UTC');
    expect(fmtReset('2026-11-09T18:00:00Z', NOW, 'UTC')).toBe('Nov 9, 18:00 UTC');
    expect(fmtReset('2026-12-31T23:30:00Z', NOW, 'UTC')).toBe(
      fmtUntil('2026-12-31T23:30:00Z', NOW, 'UTC'),
    );
  });

  it('a reset in the next year names it', () => {
    expect(fmtReset('2027-01-05T18:00:00Z', NOW, 'UTC')).toBe('Jan 5, 2027, 18:00 UTC');
    // 400 days out: two calendar years on, still one reading.
    expect(fmtReset('2027-12-12T18:00:00Z', NOW, 'UTC')).toBe('Dec 12, 2027, 18:00 UTC');
  });

  it('reads the year in the pinned zone, not the machine’s', () => {
    // 23:30 UTC on Dec 31 is already 2027 in Tokyo.
    const now = Date.parse('2026-12-31T12:00:00Z');
    expect(fmtReset('2026-12-31T23:30:00Z', now, 'UTC')).toBe('23:30 UTC');
    expect(fmtReset('2026-12-31T23:30:00Z', now, 'Asia/Tokyo')).toBe('Jan 1, 2027, 08:30 GMT+9');
  });

  it('is null for a passed or unparseable instant, like fmtUntil', () => {
    expect(fmtReset('2026-11-06T13:40:00Z', NOW, 'UTC')).toBeNull();
    expect(fmtReset('not a date', NOW, 'UTC')).toBeNull();
  });
});

describe('fmtAsOf — an observation time, never relative (add-subscription-quota-display)', () => {
  const NOW = Date.parse('2026-11-06T13:40:00Z');

  it('today is a clock time with the zone named', () => {
    expect(fmtAsOf('2026-11-06T13:02:00Z', NOW, 'UTC')).toBe('13:02 UTC');
  });

  it('another day adds the date', () => {
    expect(fmtAsOf('2026-11-05T23:15:00Z', NOW, 'UTC')).toBe('Nov 5, 23:15 UTC');
  });

  it('is null for an unparseable instant', () => {
    expect(fmtAsOf('nope', NOW, 'UTC')).toBeNull();
  });
});
