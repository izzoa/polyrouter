import { describe, expect, it } from 'vitest';
import { fmtUsd } from './format';

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
