/** The figure-state vocabulary (adopt-figure-states task 1.3; design D1, D2, D4, D8;
 * dashboard-core "Every figure slot names its state in words" and its siblings).
 *
 * Pure: every spec string, every rounding edge the requirements name, the request cost
 * state's precedence, and the parts each figure renders through `FigureText` with their
 * tones. The view tests (`notBilled.view.test.tsx`) assert that the parts reach the
 * screen in those tones. */
import { describe, expect, it } from 'vitest';
import type { RequestRow } from './api';
import {
  ceilingMoney,
  costParts,
  costText,
  EST,
  EST_USAGE,
  EST_USAGE_PARTS,
  EXPIRED,
  FREE,
  fmtLatency,
  fmtTokensCompact,
  isEstimateSource,
  money,
  NOT_APPLICABLE,
  NOT_BILLED,
  NOT_BILLED_LABEL,
  partsText,
  PENDING,
  priceLabelParts,
  priceLabelText,
  requestCostState,
  RESERVED_LABEL,
  share,
  UNKNOWN,
  UNPRICED,
  type CostStateRow,
  type FigurePart,
  type PriceLabel,
  type RequestCostState,
} from './figures';

describe('the contract strings', () => {
  it('are spelled exactly as DESIGN.md writes them', () => {
    expect(EST).toBe('· est.');
    expect(EST_USAGE).toBe('· est. usage');
    expect(NOT_BILLED).toBe('$0 · not billed');
    expect(FREE).toBe('$0 free');
    expect(UNPRICED).toBe('unpriced');
    expect(UNKNOWN).toBe('unknown');
    expect(NOT_APPLICABLE).toBe('not applicable');
    expect(PENDING).toBe('—');
    expect(RESERVED_LABEL).toBe('reserved, not spent');
    expect(EXPIRED).toBe('expired · awaiting refresh');
  });

  it('keeps NOT_BILLED_LABEL as an alias of NOT_BILLED (its data/analytics.ts re-export is gone)', () => {
    expect(NOT_BILLED_LABEL).toBe(NOT_BILLED);
  });
});

describe('money at a declared precision (design D2)', () => {
  it('reads a positive amount below the precision as `<` plus one unit, with no space', () => {
    expect(money(4_000, 'cents')).toBe('<$0.01'); // $0.004 on Overview
    expect(money(9_999, 'cents')).toBe('<$0.01');
    expect(money(40, 'four')).toBe('<$0.0001'); // a 40 µ$ request
    expect(money(99, 'four')).toBe('<$0.0001');
    expect(money(40, 'adaptive')).toBe('<$0.0001');
    // A Limits threshold can sit below one micro-dollar: still positive, still below a cent.
    expect(money(0.1, 'cents')).toBe('<$0.01');
  });

  it('reads one unit and above at the precision, and an exact zero as a measured zero', () => {
    expect(money(10_000, 'cents')).toBe('$0.01');
    expect(money(25_000_000, 'cents')).toBe('$25.00');
    expect(money(1_500_000, 'cents')).toBe('$1.50');
    expect(money(100, 'four')).toBe('$0.0001');
    expect(money(4_200, 'four')).toBe('$0.0042');
    expect(money(1_234_000, 'four')).toBe('$1.2340');
    expect(money(0, 'cents')).toBe('$0.00');
    expect(money(0, 'four')).toBe('$0.0000');
    expect(money(0, 'adaptive')).toBe('$0.00');
  });

  it('rounds half up on whole units, never through a binary-float toFixed', () => {
    expect(money(1_005_000, 'cents')).toBe('$1.01');
    expect(money(12_350, 'four')).toBe('$0.0124');
    expect(money(12_349, 'four')).toBe('$0.0123');
  });

  it('switches the savings line from four decimals to cents at $0.01', () => {
    expect(money(150, 'adaptive')).toBe('$0.0002');
    expect(money(9_999, 'adaptive')).toBe('$0.0100');
    expect(money(10_000, 'adaptive')).toBe('$0.01');
    expect(money(1_234_567, 'adaptive')).toBe('$1.23');
  });

  it('formats a negative magnitude after a leading minus, and a non-finite amount as unknown', () => {
    expect(money(-1_500_000, 'cents')).toBe('-$1.50');
    expect(money(-1_500, 'four')).toBe('-$0.0015');
  });

  // A negative below precision states its true bound: -$0.004 is greater than -$0.01, so it
  // reads `>-$0.01`, never `-<$0.01` (which would claim it is below minus a cent).
  it('reads a negative amount below precision as greater than minus one unit', () => {
    expect(money(-4_000, 'cents')).toBe('>-$0.01');
    expect(money(-40, 'four')).toBe('>-$0.0001');
    expect(money(-40, 'adaptive')).toBe('>-$0.0001');
    expect(money(-150, 'adaptive')).toBe('-$0.0002');
    for (const p of ['cents', 'four', 'adaptive'] as const) {
      expect(money(-1, p)).not.toMatch(/^-</);
    }
    expect(money(Number.NaN, 'cents')).toBe('unknown');
    expect(money(Number.POSITIVE_INFINITY, 'four')).toBe('unknown');
  });
});

describe('a reserved ceiling rounds up, so its bound stays true', () => {
  it('reads cents, rounded up to the next cent', () => {
    expect(ceilingMoney(3_000_000)).toBe('$3.00');
    expect(ceilingMoney(3_004_000)).toBe('$3.01');
    expect(ceilingMoney(40)).toBe('$0.01');
    expect(ceilingMoney(10_001)).toBe('$0.02');
    expect(ceilingMoney(0)).toBe('$0.00');
  });
});

describe('shares (design D5, Not applicable)', () => {
  it('reads a zero denominator as not applicable', () => {
    expect(share(0, 0)).toBe('not applicable');
    expect(share(5, 0)).toBe('not applicable');
  });
  it('reads a share at the precision the surface pins', () => {
    expect(share(1, 4)).toBe('25%');
    expect(share(0, 4)).toBe('0%');
    expect(share(1, 3, 1)).toBe('33.3%');
  });
});

describe('request latency (design D8)', () => {
  it('formats by magnitude', () => {
    expect(fmtLatency(412)).toBe('412ms');
    expect(fmtLatency(1_240)).toBe('1.24s');
    expect(fmtLatency(125_000)).toBe('2m 05s');
  });

  it('rounds first, then picks the unit, so it never reads an out-of-range unit', () => {
    expect(fmtLatency(999.6)).toBe('1.00s');
    expect(fmtLatency(999.4)).toBe('999ms');
    expect(fmtLatency(59_996)).toBe('1m 00s');
    expect(fmtLatency(59_994)).toBe('59.99s');
  });

  it('reads zero, a negative tick and a non-finite value as 0ms', () => {
    expect(fmtLatency(0)).toBe('0ms');
    expect(fmtLatency(-5)).toBe('0ms');
    expect(fmtLatency(Number.NaN)).toBe('0ms');
  });
});

describe('compact token counts (design D8)', () => {
  it('choose their unit by magnitude', () => {
    expect(fmtTokensCompact(999)).toBe('999');
    expect(fmtTokensCompact(1_240)).toBe('1.2k');
    expect(fmtTokensCompact(12_000)).toBe('12k');
    expect(fmtTokensCompact(12_431)).toBe('12.4k');
    expect(fmtTokensCompact(1_240_000)).toBe('1.2M');
    expect(fmtTokensCompact(3_100_000_000)).toBe('3.1B');
  });

  it('choose their unit after rounding, at the last count below each roll-over and the first at it', () => {
    expect(fmtTokensCompact(999_949)).toBe('999.9k');
    expect(fmtTokensCompact(999_950)).toBe('1M');
    expect(fmtTokensCompact(999_949_999)).toBe('999.9M');
    expect(fmtTokensCompact(999_950_000)).toBe('1B');
  });

  it('never read 1240k, 1.24M or 3100M, and B continues without a cap', () => {
    for (const n of [1_240_000, 1_240_000, 3_100_000_000]) {
      expect(fmtTokensCompact(n)).not.toMatch(/^(1240k|1\.24M|3100M)$/);
    }
    expect(fmtTokensCompact(1_000_000_000_000)).toBe('1000B');
  });
});

/** A billed, bundled-priced, provider-reported request at non-zero prices. */
const BASE: CostStateRow = {
  billed: true,
  attemptCostMicros: 0,
  cost: 0.0042,
  inputPriceSnapshot: 1.5,
  outputPriceSnapshot: 6,
  priceEstimated: false,
};

/** The precedence fixtures the task names, plus the amounts the spec strings need. */
const CASES: readonly {
  name: string;
  row: CostStateRow;
  state: RequestCostState;
  text: string;
  tones: readonly FigurePart['tone'][];
}[] = [
  {
    name: 'a not-billed row with no attempt cost',
    row: { ...BASE, billed: false, cost: 0, priceEstimated: true },
    state: { kind: 'not-billed' },
    text: '$0 · not billed',
    tones: ['ink2', 'ink2'],
  },
  {
    name: 'a not-billed row WITH attempt cost (its total is the attempt cost)',
    row: { ...BASE, billed: false, cost: 0, attemptCostMicros: 1_500 },
    state: { kind: 'amount', micros: 1_500, text: '$0.0015', priceEstimated: false },
    text: '$0.0015',
    tones: ['slot'],
  },
  {
    name: 'a null cost with attempt cost',
    row: { ...BASE, cost: null, attemptCostMicros: 250, priceEstimated: true },
    state: { kind: 'unpriced' },
    text: 'unpriced',
    tones: ['ink3'],
  },
  {
    name: 'a zero cost with zero snapshots, priced from the bundled table',
    row: { ...BASE, cost: 0, inputPriceSnapshot: 0, outputPriceSnapshot: 0 },
    state: { kind: 'free', priceEstimated: false },
    text: '$0 free',
    tones: ['slot', 'green'],
  },
  {
    name: 'a zero cost with zero snapshots priced `listed`',
    row: {
      ...BASE,
      cost: 0,
      inputPriceSnapshot: 0,
      outputPriceSnapshot: 0,
      priceEstimated: true,
    },
    state: { kind: 'free', priceEstimated: true },
    text: '$0 free · est.',
    tones: ['slot', 'green', 'ink3'],
  },
  {
    name: 'a zero cost with non-zero snapshots (a measured zero)',
    row: { ...BASE, cost: 0 },
    state: { kind: 'amount', micros: 0, text: '$0.0000', priceEstimated: false },
    text: '$0.0000',
    tones: ['slot'],
  },
  {
    name: 'a free-priced row with attempt cost is an amount, not free',
    row: {
      ...BASE,
      cost: 0,
      inputPriceSnapshot: 0,
      outputPriceSnapshot: 0,
      attemptCostMicros: 300,
    },
    state: { kind: 'amount', micros: 300, text: '$0.0003', priceEstimated: false },
    text: '$0.0003',
    tones: ['slot'],
  },
  {
    name: 'a 40 µ$ request',
    row: { ...BASE, cost: 0.00004 },
    state: { kind: 'amount', micros: 40, text: '<$0.0001', priceEstimated: false },
    text: '<$0.0001',
    tones: ['slot'],
  },
  {
    name: 'an estimate-priced amount',
    row: { ...BASE, priceEstimated: true },
    state: { kind: 'amount', micros: 4_200, text: '$0.0042', priceEstimated: true },
    text: '$0.0042 · est.',
    tones: ['slot', 'ink3'],
  },
];

describe('the request cost state (design D4)', () => {
  it.each(CASES)('$name', ({ row, state, text }) => {
    expect(requestCostState(row)).toEqual(state);
    expect(costText(requestCostState(row))).toBe(text);
  });

  it('resolves not-billed, then unpriced, then free, then amount', () => {
    // Every condition at once: not-billed wins.
    const all: CostStateRow = {
      billed: false,
      attemptCostMicros: 0,
      cost: 0,
      inputPriceSnapshot: 0,
      outputPriceSnapshot: 0,
      priceEstimated: true,
    };
    expect(requestCostState(all).kind).toBe('not-billed');
    // Billed, null cost: unpriced beats free's zero snapshots.
    expect(requestCostState({ ...all, billed: true, cost: null }).kind).toBe('unpriced');
    // Legacy `billed = null` reads as billed as recorded.
    expect(requestCostState({ ...all, billed: null }).kind).toBe('free');
    // A legacy row with null snapshots cannot prove it was free: a measured zero.
    expect(
      requestCostState({
        ...all,
        billed: true,
        inputPriceSnapshot: null,
        outputPriceSnapshot: null,
      }),
    ).toEqual({ kind: 'amount', micros: 0, text: '$0.0000', priceEstimated: true });
  });

  it('never marks money for estimated usage alone: the state reads no usage flag at all', () => {
    const usageOnly = { ...BASE, usageEstimated: true } as CostStateRow;
    expect(costText(requestCostState(usageOnly))).toBe('$0.0042');
  });
});

describe('figure parts and their tones (design D1)', () => {
  it.each(CASES)(
    '$name: the parts join to the string form, in the tones of D1',
    ({ row, text, tones }) => {
      const parts = costParts(requestCostState(row));
      expect(partsText(parts)).toBe(text);
      expect(parts.map((p) => p.tone)).toEqual(tones);
    },
  );

  it('splits `$0 · not billed` into its two no-wrap halves, both Ink 2, with no `· est.`', () => {
    expect(costParts({ kind: 'not-billed' })).toEqual([
      { text: '$0 ·', tone: 'ink2' },
      { text: 'not billed', tone: 'ink2' },
    ]);
  });

  const LABELS: readonly { label: PriceLabel; text: string; parts: readonly FigurePart[] }[] = [
    { label: { kind: 'unpriced' }, text: 'unpriced', parts: [{ text: 'unpriced', tone: 'ink3' }] },
    {
      label: { kind: 'free', estimated: false },
      text: '$0 free',
      parts: [
        { text: '$0', tone: 'slot' },
        { text: 'free', tone: 'green' },
      ],
    },
    {
      label: { kind: 'free', estimated: true },
      text: '$0 free · est.',
      parts: [
        { text: '$0', tone: 'slot' },
        { text: 'free', tone: 'green' },
        { text: '· est.', tone: 'ink3' },
      ],
    },
    {
      label: { kind: 'priced', text: '$0.1 / 1M', estimated: false },
      text: '$0.1 / 1M',
      parts: [{ text: '$0.1 / 1M', tone: 'slot' }],
    },
    {
      label: { kind: 'priced', text: '$3 / $15 per 1M', estimated: true },
      text: '$3 / $15 per 1M · est.',
      parts: [
        { text: '$3 / $15 per 1M', tone: 'slot' },
        { text: '· est.', tone: 'ink3' },
      ],
    },
  ];

  it.each(LABELS)('price label $text', ({ label, text, parts }) => {
    expect(priceLabelParts(label)).toEqual(parts);
    expect(priceLabelText(label)).toBe(text);
    expect(partsText(priceLabelParts(label))).toBe(text);
  });

  it('never renders `free` as a whole price label', () => {
    for (const { label } of LABELS) expect(priceLabelText(label)).not.toBe('free');
  });

  it('marks estimated usage as one Ink 3 unit', () => {
    expect(EST_USAGE_PARTS).toEqual([{ text: '· est. usage', tone: 'ink3' }]);
    expect(partsText(EST_USAGE_PARTS)).toBe(EST_USAGE);
  });

  it('reads `native_family` and `listed` as estimate sources, and nothing else', () => {
    expect(isEstimateSource('native_family')).toBe(true);
    expect(isEstimateSource('listed')).toBe(true);
    for (const s of ['bundled', 'refresh', 'manual', 'model', 'local', null]) {
      expect(isEstimateSource(s)).toBe(false);
    }
  });
});

describe('inputs are never mutated', () => {
  it('leaves a frozen row and frozen labels exactly as given', () => {
    const row = Object.freeze({ ...BASE, priceEstimated: true }) as RequestRow;
    const before = JSON.stringify(row);
    const state = requestCostState(row);
    costParts(state);
    costText(state);
    expect(JSON.stringify(row)).toBe(before);

    const label = Object.freeze({ kind: 'free', estimated: true } as const);
    priceLabelParts(label);
    expect(label).toEqual({ kind: 'free', estimated: true });

    const parts = Object.freeze([...EST_USAGE_PARTS]);
    expect(partsText(parts)).toBe(EST_USAGE);
    expect(EST_USAGE_PARTS).toHaveLength(1);
  });

  it('returns a fresh array when an estimate is appended, never the shared one', () => {
    const plain = priceLabelParts({ kind: 'priced', text: '$1 / 1M', estimated: false });
    const est = priceLabelParts({ kind: 'priced', text: '$1 / 1M', estimated: true });
    expect(plain).toHaveLength(1);
    expect(est).toHaveLength(2);
  });
});
