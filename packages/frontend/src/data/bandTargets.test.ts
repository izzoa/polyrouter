import { describe, expect, it } from 'vitest';
import type { Model } from '../types';
import type { RuleDto } from './api';
import { bandVms, effectiveRuleOrder, type BandTargetsInput } from './bandTargets';
import { DEFAULT_AUTO_PERF } from '../test/fakeClient';

const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-02T00:00:00.000Z';

function rule(over: Partial<RuleDto>): RuleDto {
  return {
    id: 'r1',
    matchType: 'auto_high',
    headerName: 'x-polyrouter-tier',
    headerValue: null,
    target: 'tier:premium',
    priority: 0,
    createdAt: T0,
    ...over,
  };
}

function model(id: string, over: Partial<Model> = {}): Model {
  return {
    id,
    providerId: 'p1',
    externalModelId: `ext-${id}`,
    displayName: null,
    contextWindow: null,
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    isFree: false,
    inputPricePer1m: 1,
    outputPricePer1m: 2,
    effectivePrice: {
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      isFree: false,
      source: 'model',
      estimated: false,
    },
    listedPrice: null,
    lastSyncedAt: null,
    ...over,
  };
}

function input(over: Partial<BandTargetsInput> = {}): BandTargetsInput {
  return {
    rules: [],
    tiers: [
      { id: 't-premium', key: 'premium', displayName: null, description: null, createdAt: T0 },
      { id: 't-cheap', key: 'cheap', displayName: null, description: null, createdAt: T0 },
      { id: 't-default', key: 'default', displayName: null, description: null, createdAt: T0 },
    ],
    tierEntries: {
      't-premium': [
        { id: 'e1', tierId: 't-premium', modelId: 'm1', position: 0, model: null },
        { id: 'e2', tierId: 't-premium', modelId: 'm2', position: 1, model: null },
      ],
      't-cheap': [{ id: 'e3', tierId: 't-cheap', modelId: 'm2', position: 0, model: null }],
      't-default': [{ id: 'e4', tierId: 't-default', modelId: 'm1', position: 0, model: null }],
    },
    models: [model('m1', { displayName: 'GPT X' }), model('m2')],
    providers: [
      {
        id: 'p1',
        name: 'Stub',
        kind: 'api_key',
        protocol: 'openai',
        baseUrl: null,
      } as BandTargetsInput['providers'][number],
    ],
    cascadeEffective: true,
    autoPerf: { data: null, range: '7d' },
    ...over,
  };
}

describe('effectiveRuleOrder — the proxy order', () => {
  it('sorts priority DESC, then createdAt, then id (a total order)', () => {
    const rules = [
      rule({ id: 'b', priority: 0, createdAt: T1 }),
      rule({ id: 'c', priority: 5, createdAt: T1 }),
      rule({ id: 'a', priority: 0, createdAt: T0 }),
      rule({ id: 'aa', priority: 0, createdAt: T0 }),
    ];
    const sorted = [...rules].sort(effectiveRuleOrder).map((r) => r.id);
    expect(sorted).toEqual(['c', 'a', 'aa', 'b']);
  });
});

describe('bandVms', () => {
  it('unset bands: not usable, cascade note on, no shadowed', () => {
    const vm = bandVms(input());
    expect(vm.high.target).toEqual({ kind: 'unset' });
    expect(vm.high.usable).toBe(false);
    expect(vm.high.shadowed).toEqual([]);
    expect(vm.cascadeNeedsBoth).toBe(true);
    expect(vm.sameDestination).toBe(false);
  });

  it('a tier target resolves with primary label, fallback count, and usability', () => {
    const vm = bandVms(input({ rules: [rule({ target: 'tier:premium' })] }));
    expect(vm.high.target).toEqual({
      kind: 'tier',
      key: 'premium',
      isDefault: false,
      primary: 'GPT X',
      fallbacks: 1,
      empty: false,
    });
    expect(vm.high.usable).toBe(true);
  });

  it('the default tier is a neutral, usable choice (isDefault, never a warning state)', () => {
    const vm = bandVms(input({ rules: [rule({ target: 'tier:default' })] }));
    expect(vm.high.target).toMatchObject({ kind: 'tier', isDefault: true, empty: false });
    expect(vm.high.usable).toBe(true);
  });

  it('an EMPTY tier target is flagged and NOT usable (fall-through truth)', () => {
    const vm = bandVms(
      input({
        rules: [rule({ target: 'tier:premium' })],
        tierEntries: { 't-premium': [] },
      }),
    );
    expect(vm.high.target).toMatchObject({ kind: 'tier', empty: true, primary: null });
    expect(vm.high.usable).toBe(false);
    expect(vm.cascadeNeedsBoth).toBe(true); // empty ≠ usable — the planner's truth
  });

  it('a model target resolves with label, provider, and the model itself', () => {
    const vm = bandVms(input({ rules: [rule({ target: 'model:m2' })] }));
    expect(vm.high.target).toMatchObject({ kind: 'model', label: 'ext-m2', provider: 'Stub' });
    expect(vm.high.usable).toBe(true);
  });

  it('unresolved targets carry WHAT was unresolved — only tier keys late-bind', () => {
    const cases = [
      { target: 'garbage', parsed: 'malformed' },
      { target: 'tier:gone', parsed: 'tier' },
      { target: 'model:gone', parsed: 'model' },
    ] as const;
    for (const c of cases) {
      const vm = bandVms(input({ rules: [rule({ target: c.target })] }));
      expect(vm.high.target).toEqual({ kind: 'unresolved', literal: c.target, parsed: c.parsed });
      expect(vm.high.usable).toBe(false);
    }
  });

  it('multiple band rules: the proxy pick is effective, the rest shadowed', () => {
    const vm = bandVms(
      input({
        rules: [
          rule({ id: 'low-prio', priority: 0, target: 'tier:cheap' }),
          rule({ id: 'winner', priority: 9, target: 'tier:premium' }),
        ],
      }),
    );
    expect(vm.high.effective?.id).toBe('winner');
    expect(vm.high.target).toMatchObject({ kind: 'tier', key: 'premium' });
    expect(vm.high.shadowed.map((r) => r.id)).toEqual(['low-prio']);
  });

  it('cascadeNeedsBoth follows USABILITY, and is off entirely without cascade', () => {
    const both = input({
      rules: [
        rule({ id: 'h', target: 'tier:premium' }),
        rule({ id: 'l', matchType: 'auto_low', target: 'tier:cheap' }),
      ],
    });
    expect(bandVms(both).cascadeNeedsBoth).toBe(false);
    // One band degraded (empty tier) → the note returns.
    expect(
      bandVms({ ...both, tierEntries: { ...both.tierEntries, 't-cheap': [] } }).cascadeNeedsBoth,
    ).toBe(true);
    // Cascade off → never the note.
    expect(bandVms({ ...input(), cascadeEffective: false }).cascadeNeedsBoth).toBe(false);
  });

  it('sameDestination warns only when both bands resolve to ONE destination', () => {
    const same = bandVms(
      input({
        rules: [
          rule({ id: 'h', target: 'tier:premium' }),
          rule({ id: 'l', matchType: 'auto_low', target: 'tier:premium' }),
        ],
      }),
    );
    expect(same.sameDestination).toBe(true);
    const differ = bandVms(
      input({
        rules: [
          rule({ id: 'h', target: 'tier:premium' }),
          rule({ id: 'l', matchType: 'auto_low', target: 'tier:cheap' }),
        ],
      }),
    );
    expect(differ.sameDestination).toBe(false);
  });

  it('unroutable counts are range-framed and null until the perf data loads', () => {
    expect(bandVms(input()).high.unroutable).toBeNull();
    const vm = bandVms(input({ autoPerf: { data: DEFAULT_AUTO_PERF, range: '30d' } }));
    expect(vm.high.unroutable).toEqual({ count: 1, range: '30d' }); // fixture high.unroutable = 1
    expect(vm.low.unroutable).toEqual({ count: 0, range: '30d' });
  });
});
