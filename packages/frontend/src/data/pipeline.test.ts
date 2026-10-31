import { describe, expect, it } from 'vitest';
import type { Model, Provider, Range } from '../types';
import type { AutoLayers, AutoPerformance, RuleDto, TierEntryDto } from './api';
import { toPipelineVm, type PipelineInput, type StageRowVm } from './pipeline';
import { DEFAULT_AUTO_PERF, DEFAULT_CALIBRATION } from '../test/fakeClient';

const T0 = '2026-07-01T00:00:00.000Z';

function rule(over: Partial<RuleDto>): RuleDto {
  return {
    id: 'r1',
    matchType: 'auto_high',
    workloadClass: null,
    headerName: 'x-polyrouter-tier',
    headerValue: null,
    target: 'tier:premium',
    priority: 0,
    createdAt: T0,
    ...over,
  };
}

function model(id: string): Model {
  return {
    id,
    providerId: 'p1',
    externalModelId: `ext-${id}`,
    displayName: null,
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
    variant: null,
    baseExternalModelId: null,
    batchCapable: true,
    batchEffectivePrice: null,
    lastSyncedAt: null,
    unlistedSince: null,
  };
}

function entry(tierId: string, modelId: string, position: number): TierEntryDto {
  return { id: `${tierId}-${modelId}`, tierId, modelId, position, mode: 'any', model: null };
}

/** Both generic bands usable; `hollow` is an empty tier for the degraded cases. */
const GENERIC = [
  rule({ id: 'hi', matchType: 'auto_high', target: 'tier:premium' }),
  rule({ id: 'lo', matchType: 'auto_low', target: 'tier:cheap' }),
];

function layers(over: Partial<AutoLayers> = {}): AutoLayers {
  return {
    structural: true,
    cascade: true,
    semantic: true,
    semanticAvailable: true,
    semanticLearning: false,
    semanticLearningAvailable: true,
    structuralAvailable: true,
    cascadeAvailable: true,
    calibration: DEFAULT_CALIBRATION,
    ...over,
  };
}

function perf(over: Partial<AutoPerformance> = {}): AutoPerformance {
  return { ...DEFAULT_AUTO_PERF, ...over };
}

function input(
  over: {
    autoLayers?: AutoLayers | null;
    data?: AutoPerformance | null;
    error?: string | null;
    range?: Range;
    rules?: RuleDto[];
  } = {},
): PipelineInput {
  return {
    autoLayers: over.autoLayers === undefined ? layers() : over.autoLayers,
    autoPerf: {
      data: over.data === undefined ? perf() : over.data,
      error: over.error ?? null,
      range: over.range ?? '7d',
    },
    catalog: {
      rules: over.rules ?? GENERIC,
      tiers: [
        { id: 't-premium', key: 'premium', displayName: null, description: null, createdAt: T0 },
        { id: 't-cheap', key: 'cheap', displayName: null, description: null, createdAt: T0 },
        { id: 't-hollow', key: 'hollow', displayName: null, description: null, createdAt: T0 },
        { id: 't-default', key: 'default', displayName: null, description: null, createdAt: T0 },
      ],
      tierEntries: {
        't-premium': [entry('t-premium', 'm1', 0), entry('t-premium', 'm2', 1)],
        't-cheap': [entry('t-cheap', 'm3', 0)],
        't-default': [entry('t-default', 'm3', 0)],
      },
      models: [model('m1'), model('m2'), model('m3')],
      providers: [
        { id: 'p1', name: 'acme', kind: 'api_key', protocol: 'openai', baseUrl: null } as Provider,
      ],
    },
  };
}

function stage(vm: { stages: StageRowVm[] }, id: StageRowVm['id']): StageRowVm {
  const s = vm.stages.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no stage ${id}`);
  return s;
}

describe('toPipelineVm — stage rows', () => {
  it('renders six stages in proxy order, naming the layer on 1, 4 and 5 only', () => {
    const vm = toPipelineVm(input());
    expect(vm.stages.map((s) => [s.number, s.id, s.name, s.layer])).toEqual([
      [1, 'classify', 'Classify', 'L1 · Structural'],
      [2, 'workload', 'Workload claim', null],
      [3, 'band', 'Confident band', null],
      [4, 'semantic', 'Semantic', 'L2 · Semantic'],
      [5, 'cascade', 'Cascade', 'L3 · Cascade'],
      [6, 'default', 'Default', null],
    ]);
  });

  it('carries a switch only on stages 1, 4 and 5, wired to the right layer', () => {
    const vm = toPipelineVm(input());
    expect(vm.stages.map((s) => s.layerRow?.id ?? null)).toEqual([
      'structural',
      null,
      null,
      'semantic',
      'cascade',
      null,
    ]);
    expect(vm.stages.map((s) => s.switchState?.kind ?? null)).toEqual([
      'on',
      null,
      null,
      'on',
      'on',
      null,
    ]);
  });

  it('every stage but Confident band expands; Confident band carries the Targets link', () => {
    const vm = toPipelineVm(input());
    expect(vm.stages.filter((s) => s.expandable).map((s) => s.id)).toEqual([
      'classify',
      'workload',
      'semantic',
      'cascade',
      'default',
    ]);
    expect(vm.stages.filter((s) => s.targetsLink).map((s) => s.id)).toEqual(['band']);
    expect(stage(vm, 'band').expandable).toBe(false);
  });

  it('maps stages 2–6 to the exits in order; Classify counts evaluated', () => {
    const vm = toPipelineVm(input());
    expect(vm.stages.map((s) => s.exit)).toEqual([
      null,
      'workload',
      'structural',
      'semantic',
      'cascade',
      'default',
    ]);
  });
});

describe('toPipelineVm — figures', () => {
  it('shows evaluated on Classify and each exit with its share of evaluated', () => {
    const vm = toPipelineVm(input());
    expect(vm.measured).toBe('ready');
    expect(vm.stages.map((s) => s.figure)).toEqual([
      { kind: 'count', count: 40, share: null },
      { kind: 'count', count: 0, share: '0%' },
      { kind: 'count', count: 22, share: '55%' },
      { kind: 'count', count: 5, share: '13%' }, // 12.5%
      { kind: 'count', count: 10, share: '25%' },
      { kind: 'count', count: 3, share: '8%' }, // 7.5%
    ]);
  });

  it('the exits sum to evaluated, and the bar totals evaluated', () => {
    const vm = toPipelineVm(input());
    const counts = vm.stages
      .slice(1)
      .map((s) => (s.figure.kind === 'count' ? s.figure.count : Number.NaN));
    expect(counts.reduce((a, n) => a + n, 0)).toBe(40);
    expect(vm.exitBar?.total).toBe(40);
    expect(vm.exitBar?.legend.reduce((a, e) => a + e.count, 0)).toBe(40);
  });

  it('the bar omits a zero exit while the legend keeps it, in stage order', () => {
    const vm = toPipelineVm(input());
    expect(vm.exitBar?.legend.map((e) => [e.number, e.label, e.count, e.share])).toEqual([
      [2, 'Workload claim', 0, '0%'],
      [3, 'Confident band', 22, '55%'],
      [4, 'Semantic', 5, '13%'],
      [5, 'Cascade', 10, '25%'],
      [6, 'Default', 3, '8%'],
    ]);
    expect(vm.exitBar?.segments.map((e) => e.exit)).toEqual([
      'structural',
      'semantic',
      'cascade',
      'default',
    ]);
  });

  it('the Default detail reconciles: default = high.unroutable + low.unroutable + fallthrough', () => {
    const vm = toPipelineVm(input());
    const d = vm.defaultDetail;
    expect(d).toEqual({ total: 3, unroutable: { high: 1, low: 0 }, fallthrough: 2, other: 0 });
    expect(d?.total).toBe(
      (d?.unroutable.high ?? 0) + (d?.unroutable.low ?? 0) + (d?.fallthrough ?? 0),
    );
  });

  it('a banded row at a layer the proxy never writes on auto lands in `other`, never a gap', () => {
    const vm = toPipelineVm(
      input({
        data: perf({
          evaluated: 41,
          exits: { workload: 0, structural: 22, semantic: 5, cascade: 10, default: 4 },
        }),
      }),
    );
    expect(vm.defaultDetail?.total).toBe(4);
    expect(vm.defaultDetail?.other).toBe(1);
  });

  it('an absent `exits` block reads as unavailable, never zero — other figures still render', () => {
    const data = perf();
    delete data.exits;
    const vm = toPipelineVm(input({ data }));
    expect(vm.measured).toBe('unavailable');
    expect(stage(vm, 'classify').figure).toEqual({ kind: 'count', count: 40, share: null });
    for (const s of vm.stages.slice(1)) expect(s.figure).toEqual({ kind: 'unavailable' });
    expect(vm.exitBar).toBeNull();
    expect(vm.defaultDetail).toEqual({
      total: null,
      unroutable: { high: 1, low: 0 },
      fallthrough: 2,
      other: null,
    });
    expect(vm.perf?.evaluated).toBe(40);
  });

  it('null data shows a placeholder on every stage and no bar, detail or perf figures', () => {
    const vm = toPipelineVm(input({ data: null }));
    expect(vm.measured).toBe('loading');
    for (const s of vm.stages) expect(s.figure).toEqual({ kind: 'placeholder' });
    expect(vm.exitBar).toBeNull();
    expect(vm.defaultDetail).toBeNull();
    expect(vm.perf).toBeNull();
  });

  it('a set error shows no figure at all — even with the earlier load still in the store', () => {
    const vm = toPipelineVm(input({ data: perf(), error: 'timeout' }));
    expect(vm.measured).toBe('error');
    for (const s of vm.stages) expect(s.figure.kind).not.toBe('count');
    expect(vm.exitBar).toBeNull();
    expect(vm.defaultDetail).toBeNull();
    expect(vm.perf).toBeNull();
    expect(JSON.stringify(vm)).not.toContain('"count":');
  });

  it('zero evaluated gives zero counts and "—" shares, never NaN%, and no bar', () => {
    const zero = perf({
      evaluated: 0,
      bands: {
        high: { requests: 0, declared: 0, unroutable: 0 },
        low: { requests: 0, declared: 0, unroutable: 0 },
        ambiguous: { requests: 0 },
      },
      fallthrough: 0,
      exits: { workload: 0, structural: 0, semantic: 0, cascade: 0, default: 0 },
    });
    const vm = toPipelineVm(input({ data: zero }));
    expect(vm.measured).toBe('zero');
    expect(stage(vm, 'classify').figure).toEqual({ kind: 'count', count: 0, share: null });
    for (const s of vm.stages.slice(1))
      expect(s.figure).toEqual({ kind: 'count', count: 0, share: '—' });
    expect(vm.exitBar).toBeNull();
    expect(JSON.stringify(vm)).not.toContain('NaN');
    expect(vm.defaultDetail).toEqual({
      total: 0,
      unroutable: { high: 0, low: 0 },
      fallthrough: 0,
      other: 0,
    });
    // The zero state's telemetrySince distinction rides on the perf view-model.
    expect(vm.perf?.zeroState).toBe('preCapture');
    expect(toPipelineVm(input({ data: { ...zero, telemetrySince: null } })).perf?.zeroState).toBe(
      'empty',
    );
  });

  it('zero evaluated without an `exits` block is still a true zero — the exits partition 0', () => {
    const zero = perf({ evaluated: 0, fallthrough: 0 });
    delete zero.exits;
    const vm = toPipelineVm(input({ data: zero }));
    expect(vm.measured).toBe('zero');
    for (const s of vm.stages.slice(1))
      expect(s.figure).toEqual({ kind: 'count', count: 0, share: '—' });
  });

  it('frames the figures to the selected range', () => {
    expect(toPipelineVm(input({ range: '30d' })).range).toBe('30d');
  });

  it('no structural capability: the pipeline renders with its hint and every figure is absent', () => {
    const vm = toPipelineVm(
      input({
        autoLayers: layers({
          structural: false,
          structuralAvailable: false,
          cascade: false,
          semantic: false,
        }),
        data: null,
      }),
    );
    expect(vm.measured).toBe('absent');
    expect(vm.stages).toHaveLength(6);
    for (const s of vm.stages) expect(s.figure).toEqual({ kind: 'none' });
    expect(stage(vm, 'classify').switchState).toEqual({
      kind: 'unavailable',
      hint: 'off instance-wide (ROUTING_AUTO_LAYERS)',
    });
    expect(vm.exitBar).toBeNull();
    expect(vm.defaultDetail).toBeNull();
    expect(vm.perf).toBeNull();
  });
});

describe('toPipelineVm — switches and off-states', () => {
  it('a null auto-layers view is loading — never "off instance-wide", never paused', () => {
    const vm = toPipelineVm(input({ autoLayers: null }));
    for (const id of ['classify', 'semantic', 'cascade'] as const) {
      expect(stage(vm, id).switchState).toEqual({ kind: 'loading' });
      expect(stage(vm, id).setup).toBe('Loading…');
    }
    expect(vm.stages.every((s) => s.status === null)).toBe(true);
    expect(JSON.stringify(vm.stages)).not.toContain('off instance-wide');
  });

  it('Layer 1 off pauses stages 2–5 in text, with no dimming style', () => {
    const vm = toPipelineVm(
      input({ autoLayers: layers({ structural: false, semantic: false, cascade: false }) }),
    );
    expect(stage(vm, 'classify').status).toEqual({ kind: 'off', tone: 'caution' });
    expect(stage(vm, 'classify').setup).toBe(
      'Off — new auto requests go straight to the default tier',
    );
    expect(stage(vm, 'classify').setupSub).toBe('Stages 2–5 pause without Layer 1’s verdicts');
    for (const id of ['workload', 'band', 'semantic', 'cascade'] as const) {
      expect(stage(vm, id).status).toEqual({ kind: 'paused', label: 'paused · needs L1' });
    }
    expect(stage(vm, 'default').status).toBeNull();
    // Text only: nothing in a row describes a reduced-contrast treatment.
    expect(JSON.stringify(vm.stages)).not.toMatch(/opacity|dim|muted|faint/i);
    // A paused stage whose OWN layer is off says so — it never describes a switched-off
    // layer as routing (the server clears L2/L3 with L1, so this is the common case).
    expect(stage(vm, 'semantic').setup).toBe('Off');
    expect(stage(vm, 'cascade').setup).toBe('Off');
    expect(stage(vm, 'semantic').setupSub).toBe('Any count shown is history from when it was on');
  });

  it('a paused stage whose own layer is on keeps its configuration summary', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ structural: false }) }));
    expect(stage(vm, 'semantic').status).toEqual({ kind: 'paused', label: 'paused · needs L1' });
    expect(stage(vm, 'semantic').setup).toBe('Routes the ambiguous slice Layer 1 can’t read');
    expect(stage(vm, 'cascade').status).toEqual({ kind: 'paused', label: 'paused · needs L1' });
    expect(stage(vm, 'cascade').setup).toBe(
      'Tries cheap first, escalates on a failed quality check',
    );
  });

  it('L2 off alone is neutral and says where its traffic goes', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ semantic: false }) }));
    expect(stage(vm, 'semantic').status).toEqual({ kind: 'off', tone: 'neutral' });
    expect(stage(vm, 'semantic').setup).toBe(
      'Off — the ambiguous slice goes straight to the cascade',
    );
    expect(stage(vm, 'semantic').setupSub).toBe('Any count shown is history from when it was on');
    expect(stage(vm, 'cascade').status).toBeNull();
    expect(stage(vm, 'workload').status).toBeNull();
    // Its count is still shown — as history for the range.
    expect(stage(vm, 'semantic').figure).toEqual({ kind: 'count', count: 5, share: '13%' });
  });

  it('L2 and L3 off: the ambiguous slice goes to the default tier, both neutral', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ semantic: false, cascade: false }) }));
    expect(stage(vm, 'semantic').setup).toBe(
      'Off — the ambiguous slice goes straight to the default tier',
    );
    expect(stage(vm, 'cascade').status).toEqual({ kind: 'off', tone: 'neutral' });
    expect(stage(vm, 'cascade').setup).toBe('Off — still-ambiguous requests use the default tier');
  });

  it('an instance-unavailable L2 carries its missing-half hint and a neutral off-state', () => {
    const vm = toPipelineVm(
      input({
        autoLayers: layers({
          semantic: false,
          semanticAvailable: false,
          semanticFlagEnabled: true,
        }),
      }),
    );
    const s = stage(vm, 'semantic');
    expect(s.switchState?.kind).toBe('unavailable');
    expect(s.status).toEqual({ kind: 'off', tone: 'neutral' });
  });
});

describe('toPipelineVm — setup summaries', () => {
  it('Classify states the effective thresholds and the self-calibration state', () => {
    const vm = toPipelineVm(input());
    expect(stage(vm, 'classify').setup).toBe('Thresholds high 0.6 · low 0.25');
    expect(stage(vm, 'classify').setupSub).toBe('instance defaults · self-calibration off');
  });

  it('Confident band and Cascade read the generic band targets', () => {
    const vm = toPipelineVm(input());
    expect(stage(vm, 'band').setup).toBe('Strong: tier:premium · Cheap: tier:cheap');
    // The arrows are drawn by the view (no font carries one), so the pairs are data.
    expect(stage(vm, 'band').setupRoutes).toEqual([
      { from: 'Strong', to: 'tier:premium' },
      { from: 'Cheap', to: 'tier:cheap' },
    ]);
    expect(stage(vm, 'band').setupSub).toBeNull();
    expect(stage(vm, 'cascade').setupSub).toBe('tier:cheap first, then tier:premium');
    expect(stage(vm, 'semantic').setupSub).toBe('learning off');
  });

  it('a class-scoped rule is named on Confident band but never replaces the generic target', () => {
    const vm = toPipelineVm(
      input({
        rules: [
          ...GENERIC,
          rule({ id: 'v', matchType: 'auto_high', workloadClass: 'vision', target: 'model:m1' }),
          rule({ id: 'c1', matchType: 'auto_high', workloadClass: 'code', target: 'tier:cheap' }),
          rule({ id: 'c2', matchType: 'auto_low', workloadClass: 'code', target: 'tier:cheap' }),
        ],
      }),
    );
    expect(stage(vm, 'band').setup).toBe('Strong: tier:premium · Cheap: tier:cheap');
    expect(stage(vm, 'band').setupSub).toBe(
      'code has its own Strong and Cheap targets · vision has its own Strong target',
    );
  });

  it('degraded generic targets say so, and a half-configured cascade names the fall-through', () => {
    const vm = toPipelineVm(
      input({ rules: [rule({ id: 'hi', matchType: 'auto_high', target: 'tier:hollow' })] }),
    );
    expect(stage(vm, 'band').setup).toBe('Strong: tier:hollow (empty) · Cheap: unset');
    expect(stage(vm, 'cascade').setupSub).toBe(
      'Needs usable Strong and Cheap targets — ambiguous requests stay on the default tier until both are',
    );
    const gone = toPipelineVm(
      input({ rules: [rule({ id: 'hi', matchType: 'auto_high', target: 'tier:deleted' })] }),
    );
    expect(stage(gone, 'band').setup).toBe('Strong: tier:deleted (unresolved) · Cheap: unset');
  });

  it('Workload claim lists only usable, live claims', () => {
    const none = toPipelineVm(input());
    expect(stage(none, 'workload').setup).toBe('No class claims — every request passes to stage 3');
    expect(stage(none, 'workload').setupRoutes).toBeNull(); // prose, not pairs
    expect(stage(none, 'workload').setupSub).toBeNull();

    const vm = toPipelineVm(
      input({
        rules: [
          ...GENERIC,
          rule({
            id: 'w1',
            matchType: 'auto_workload',
            workloadClass: 'code',
            target: 'tier:premium',
          }),
          // configured but empty: does not claim
          rule({
            id: 'w2',
            matchType: 'auto_workload',
            workloadClass: 'vision',
            target: 'tier:hollow',
          }),
          // reserved class, semantic workload source not effective: inert
          rule({
            id: 'w3',
            matchType: 'auto_workload',
            workloadClass: 'research',
            target: 'tier:cheap',
          }),
        ],
      }),
    );
    expect(stage(vm, 'workload').setup).toBe('code: tier:premium');
    expect(stage(vm, 'workload').setupRoutes).toEqual([{ from: 'code', to: 'tier:premium' }]);
    expect(stage(vm, 'workload').setupSub).toBe(
      '1 of 5 classes claims — the rest pass to stage 3 · 1 configured claim steers nothing',
    );

    const live = toPipelineVm(
      input({
        autoLayers: layers({ semanticWorkload: true, semanticWorkloadAvailable: true }),
        rules: [
          rule({
            id: 'w1',
            matchType: 'auto_workload',
            workloadClass: 'code',
            target: 'tier:premium',
          }),
          rule({
            id: 'w3',
            matchType: 'auto_workload',
            workloadClass: 'research',
            target: 'model:m1',
          }),
        ],
      }),
    );
    expect(stage(live, 'workload').setup).toBe('code: tier:premium · research: ext-m1');
    expect(stage(live, 'workload').setupRoutes).toEqual([
      { from: 'code', to: 'tier:premium' },
      { from: 'research', to: 'ext-m1' },
    ]);
    expect(stage(live, 'workload').setupSub).toBe(
      '2 of 5 classes claim — the rest pass to stage 3',
    );
  });

  it('configuration never waits on the aggregation: setups are identical loading, failed or ready', () => {
    const setups = (vm: { stages: StageRowVm[] }) =>
      vm.stages.map((s) => [s.setup, s.setupRoutes, s.setupSub, s.status, s.switchState]);
    const ready = setups(toPipelineVm(input()));
    expect(setups(toPipelineVm(input({ data: null })))).toEqual(ready);
    expect(setups(toPipelineVm(input({ error: 'boom' })))).toEqual(ready);
  });
});
