import { describe, expect, it } from 'vitest';
import { rangeToParams } from './range';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const DAY = 86_400_000;

describe('rangeToParams', () => {
  it('24h → hourly bucket over the last 24h', () => {
    const p = rangeToParams('24h', NOW);
    expect(p.bucket).toBe('hour');
    expect(p.to).toBe(new Date(NOW).toISOString());
    expect(p.from).toBe(new Date(NOW - DAY).toISOString());
  });

  it('7d → daily bucket over the last 7 days', () => {
    const p = rangeToParams('7d', NOW);
    expect(p.bucket).toBe('day');
    expect(p.to).toBe(new Date(NOW).toISOString());
    expect(p.from).toBe(new Date(NOW - 7 * DAY).toISOString());
  });

  it('30d → daily bucket over the last 30 days', () => {
    const p = rangeToParams('30d', NOW);
    expect(p.bucket).toBe('day');
    expect(p.from).toBe(new Date(NOW - 30 * DAY).toISOString());
  });

  it('is pure — a frozen `now` yields a stable window', () => {
    expect(rangeToParams('24h', NOW)).toEqual(rangeToParams('24h', NOW));
  });
});
