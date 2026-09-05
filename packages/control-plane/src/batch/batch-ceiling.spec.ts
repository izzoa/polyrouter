import { computeCeiling, estimateInputTokens } from './batch-ceiling';

const RATE = { inputPricePer1m: 1.25, outputPricePer1m: 5 };

describe('computeCeiling (add-batch-inference D20)', () => {
  it('sums chars/4 × batch_in plus each item’s output cap × batch_out, in µ$ rounded up', () => {
    const c = computeCeiling(
      [
        { chars: 400, maxOutputTokens: 100 }, // 100 in → 125 µ$; 100 out → 500 µ$
        { chars: 7, maxOutputTokens: 1 }, // 2 in → 2.5 µ$; 1 out → 5 µ$
      ],
      RATE,
      null,
    );
    expect(c).toEqual({
      kind: 'bounded',
      micros: Math.ceil(125 + 500 + 2.5 + 5),
      estimatedInputTokens: 102,
    });
  });

  it('falls back to the catalog output cap only for items without their own', () => {
    const c = computeCeiling(
      [
        { chars: 4, maxOutputTokens: null },
        { chars: 4, maxOutputTokens: 10 },
      ],
      RATE,
      1_000,
    );
    expect(c).toEqual({
      kind: 'bounded',
      micros: Math.ceil(2 * 1.25 + (1_000 + 10) * 5),
      estimatedInputTokens: 2,
    });
  });

  it('is unbounded when any item has no cap and the catalog has none', () => {
    expect(
      computeCeiling(
        [
          { chars: 4, maxOutputTokens: 10 },
          { chars: 4, maxOutputTokens: null },
        ],
        RATE,
        null,
      ),
    ).toEqual({ kind: 'unbounded', reason: 'no_output_cap', estimatedInputTokens: 2 });
    expect(computeCeiling([{ chars: 4, maxOutputTokens: 0 }], RATE, null)).toMatchObject({
      reason: 'no_output_cap',
    });
  });

  it('is unbounded when the batch rate is unknown — never a synchronous rate, never zero', () => {
    expect(computeCeiling([{ chars: 4, maxOutputTokens: 10 }], null, 100)).toEqual({
      kind: 'unbounded',
      reason: 'unknown_rate',
      estimatedInputTokens: 1,
    });
  });

  it('a free batch rate bounds at zero; an empty batch is a zero ceiling', () => {
    expect(
      computeCeiling(
        [{ chars: 4000, maxOutputTokens: 10 }],
        { inputPricePer1m: 0, outputPricePer1m: 0 },
        null,
      ),
    ).toEqual({ kind: 'bounded', micros: 0, estimatedInputTokens: 1000 });
    expect(computeCeiling([], RATE, null)).toEqual({
      kind: 'bounded',
      micros: 0,
      estimatedInputTokens: 0,
    });
  });

  it('estimates input tokens as ceil(chars/4), clamped at zero', () => {
    expect(estimateInputTokens(0)).toBe(0);
    expect(estimateInputTokens(1)).toBe(1);
    expect(estimateInputTokens(8)).toBe(2);
    expect(estimateInputTokens(-5)).toBe(0);
  });
});
