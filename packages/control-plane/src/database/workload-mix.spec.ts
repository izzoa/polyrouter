import { buildWorkloadMix } from './workload-mix';

describe('buildWorkloadMix (add-workload-telemetry D6)', () => {
  it('merges parents + attempts per class, sums spend in micro-dollars once, orders deterministically', () => {
    const mix = buildWorkloadMix(
      [
        { cls: 'code', requests: 3, unpriced: 1, micros: 1_500_000 },
        { cls: 'none', requests: 3, unpriced: 0, micros: 10 },
        { cls: 'structured', requests: 1, unpriced: 0, micros: 250_000 },
      ],
      [{ cls: 'code', micros: '500000', costed: '1', unpriced: '0' }], // pg strings coerced
      '4',
      '2026-08-01T00:00:00.000Z',
      [
        { revision: 'structural/v1/c1/bbb', requests: 5 },
        { revision: 'structural/v1/c1/aaa', requests: 2 },
      ],
    );
    expect(mix.evaluated).toBe(7);
    expect(mix.unclassified).toBe(4);
    expect(mix.since).toBe('2026-08-01T00:00:00.000Z');
    expect(mix.revisions).toEqual([
      { revision: 'structural/v1/c1/aaa', requests: 2 },
      { revision: 'structural/v1/c1/bbb', requests: 5 },
    ]);
    // requests desc, then slug asc: code (3) and none (3) tie → code < none.
    expect(mix.classes.map((c) => c.class)).toEqual(['code', 'none', 'structured']);
    expect(mix.classes[0]).toEqual({
      class: 'code',
      requests: 3,
      unpricedRequests: 1,
      unpricedAttempts: 0,
      spendUsd: 2, // 1.5 + 0.5
      routed: 0,
    });
  });

  it('routed (add-workload-routing) rides the parent aggregate per class; absent → 0; never counted for attempt-only classes', () => {
    const mix = buildWorkloadMix(
      [
        { cls: 'code', requests: 5, unpriced: 0, micros: 0, routed: 2 },
        { cls: 'vision', requests: 1, unpriced: 0, micros: 0, routed: '1' as never }, // pg string coerced
        { cls: 'none', requests: 4, unpriced: 0, micros: 0, routed: 0 },
        { cls: 'structured', requests: 1, unpriced: 0, micros: 0 }, // legacy shape (no routed)
      ],
      [{ cls: 'writing', micros: 0, costed: 1, unpriced: 0 }],
      0,
      null,
      [],
    );
    const by = new Map(mix.classes.map((c) => [c.class, c]));
    expect(by.get('code')!).toMatchObject({ requests: 5, routed: 2 });
    expect(by.get('vision')!.routed).toBe(1);
    expect(by.get('none')!.routed).toBe(0);
    expect(by.get('structured')!.routed).toBe(0);
    expect(by.get('writing')!).toMatchObject({ requests: 0, routed: 0 });
  });

  it('costability follows null-is-unpriced / zero-is-free', () => {
    const mix = buildWorkloadMix(
      [
        { cls: 'vision', requests: 2, unpriced: 2, micros: 0 }, // all-null parents, no attempts
        { cls: 'code', requests: 2, unpriced: 0, micros: 0 }, // all-free (cost = 0)
        { cls: 'writing', requests: 1, unpriced: 1, micros: 0 }, // unpriced parent + zero-cost attempt
        { cls: 'research', requests: 1, unpriced: 0, micros: 0 }, // subscription-only priced (excluded → 0)
      ],
      [{ cls: 'writing', micros: 0, costed: 1, unpriced: 0 }],
      0,
      null,
      [],
    );
    const by = new Map(mix.classes.map((c) => [c.class, c]));
    expect(by.get('vision')!.spendUsd).toBeNull();
    expect(by.get('vision')!.unpricedRequests).toBe(2);
    expect(by.get('code')!.spendUsd).toBe(0);
    expect(by.get('writing')!.spendUsd).toBe(0); // costable through the zero-cost attempt
    expect(by.get('research')!.spendUsd).toBe(0);
  });

  it('an attempt-only class appears with requests 0 (reverse ledger boundary); evaluated counts parents only', () => {
    const mix = buildWorkloadMix(
      [],
      [{ cls: 'code', micros: 750_000, costed: 1, unpriced: 1 }],
      0,
      null,
      [],
    );
    expect(mix.evaluated).toBe(0);
    expect(mix.classes).toEqual([
      {
        class: 'code',
        requests: 0,
        unpricedRequests: 0,
        unpricedAttempts: 1,
        spendUsd: 0.75,
        routed: 0,
      },
    ]);
  });

  it('a priced parent with an unpriced attempt reports numeric spend and unpricedAttempts', () => {
    const mix = buildWorkloadMix(
      [{ cls: 'code', requests: 1, unpriced: 0, micros: 1_000_000 }],
      [{ cls: 'code', micros: 0, costed: 0, unpriced: 1 }],
      0,
      null,
      [],
    );
    expect(mix.classes[0]).toMatchObject({ spendUsd: 1, unpricedAttempts: 1, unpricedRequests: 0 });
  });

  it('null class rows are ignored; the empty input is the honest empty shape', () => {
    expect(
      buildWorkloadMix([{ cls: null, requests: 9, unpriced: 0, micros: 1 }], [], 3, null, []),
    ).toEqual({
      evaluated: 0,
      unclassified: 3,
      since: null,
      revisions: [],
      classes: [],
    });
  });
});
