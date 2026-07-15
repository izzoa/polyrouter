import { computeCost, estimateTokens, resolveUsage } from './cost';
import type { PriceSnapshot } from '@polyrouter/shared/server';

const price = (over: Partial<PriceSnapshot> = {}): PriceSnapshot => ({
  priceVersionId: 'v1',
  modelKey: 'openai:gpt-4o',
  inputPricePer1m: 2.5,
  outputPricePer1m: 10,
  cacheReadPricePer1m: 1.25,
  cacheWritePricePer1m: 3.75,
  isFree: false,
  source: 'bundled',
  validFrom: new Date('2026-07-15T00:00:00Z'),
  ...over,
});

describe('computeCost', () => {
  it('sums per-component per-1M USD', () => {
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 200_000, estimated: false },
      price(),
    );
    // 2.5 + 5 + 0.25 = 7.75
    expect(cost).toBeCloseTo(7.75, 6);
  });

  it('returns null for an unknown price', () => {
    expect(computeCost({ inputTokens: 100, outputTokens: 10, estimated: false }, null)).toBeNull();
  });

  it('returns 0 for a free model', () => {
    expect(
      computeCost(
        { inputTokens: 100, outputTokens: 10, estimated: false },
        price({ isFree: true }),
      ),
    ).toBe(0);
  });

  it('returns null when a non-zero cache component lacks its rate (never understated)', () => {
    expect(
      computeCost(
        { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5_000, estimated: false },
        price({ cacheReadPricePer1m: null }),
      ),
    ).toBeNull();
    // ...but zero cache tokens with a null rate is fine.
    expect(
      computeCost(
        { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, estimated: false },
        price({ cacheReadPricePer1m: null }),
      ),
    ).not.toBeNull();
  });
});

describe('estimateTokens', () => {
  it('is chars/4, rounded up, non-negative', () => {
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101);
    expect(estimateTokens(-5)).toBe(0);
  });
});

describe('resolveUsage', () => {
  it('uses complete provider usage verbatim (not estimated)', () => {
    const r = resolveUsage({
      providerUsage: { inputTokens: 30, outputTokens: 12, cacheReadTokens: 8 },
      requestChars: 9999,
      outputChars: 9999,
    });
    expect(r).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 8, estimated: false });
  });

  it('estimates missing usage from chars and flags it', () => {
    const r = resolveUsage({ requestChars: 400, outputChars: 40 });
    expect(r).toMatchObject({ inputTokens: 100, outputTokens: 10, estimated: true });
  });

  it('subtracts known cache tokens from an estimated uncached input (no double count)', () => {
    // total input estimate = 400/4 = 100; known cache = 80 → uncached = 20
    const r = resolveUsage({
      providerUsage: { cacheReadTokens: 80 },
      requestChars: 400,
      outputChars: 40,
    });
    expect(r).toMatchObject({
      inputTokens: 20,
      cacheReadTokens: 80,
      outputTokens: 10,
      estimated: true,
    });
  });

  it('estimates a tool-only output from tool chars (non-zero)', () => {
    // outputChars carries tool name + args chars from the caller
    const r = resolveUsage({ requestChars: 40, outputChars: 40 });
    expect(r.outputTokens).toBe(10);
    expect(r.estimated).toBe(true);
  });
});
