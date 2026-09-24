import { describe, expect, it } from 'vitest';
import { fmtUsd, fmtWhen } from './format';

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
