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

  it('the exits sum to evaluated', () => {
    const vm = toPipelineVm(input());
    const counts = vm.stages
      .slice(1)
      .map((s) => (s.figure.kind === 'count' ? s.figure.count : Number.NaN));
    expect(counts.reduce((a, n) => a + n, 0)).toBe(40);
  });

  it('the Default detail reconciles: default = high.unroutable + low.unroutable + fallthrough', () => {
    const vm = toPipelineVm(input());
    const d = vm.defaultDetail;
    // The routed-here total is the Default ROW's count; the detail does not repeat it.
    expect(d).toEqual({ unroutable: { high: 1, low: 0 }, fallthrough: 2, other: 0 });
    const row = stage(vm, 'default').figure;
    expect(row.kind === 'count' ? row.count : NaN).toBe(
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
    expect(vm.defaultDetail?.other).toBe(1);
  });

  it('an absent `exits` block reads as unavailable, never zero — other figures still render', () => {
    const data = perf();
    delete data.exits;
    const vm = toPipelineVm(input({ data }));
    expect(vm.measured).toBe('unavailable');
    expect(stage(vm, 'classify').figure).toEqual({ kind: 'count', count: 40, share: null });
    // Stages 2–6 carry no per-stage figure at all, visible or hidden: the panel's
    // `Unavailable` notice names the state (adopt-figure-states D5), never a lone dash.
    for (const s of vm.stages.slice(1)) expect(s.figure).toEqual({ kind: 'none' });
    for (const s of vm.stages.slice(1)) expect(s.bar).toBeNull();
    expect(vm.defaultDetail).toEqual({
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
    expect(vm.defaultDetail).toBeNull();
    expect(vm.perf).toBeNull();
  });

  it('a set error shows no figure at all — even with the earlier load still in the store', () => {
    const vm = toPipelineVm(input({ data: perf(), error: 'timeout' }));
    expect(vm.measured).toBe('error');
    // No figure slot on any stage: the failure notice names the state (adopt-figure-states D5).
    for (const s of vm.stages) expect(s.figure).toEqual({ kind: 'none' });
    expect(vm.defaultDetail).toBeNull();
    expect(vm.perf).toBeNull();
    expect(JSON.stringify(vm)).not.toContain('"count":');
  });

  it('zero evaluated gives zero counts and not-applicable shares, never NaN%, 0% or a dash, and no bar', () => {
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
      expect(s.figure).toEqual({ kind: 'count', count: 0, share: 'not applicable' });
    expect(JSON.stringify(vm)).not.toContain('NaN');
    expect(JSON.stringify(vm.stages.map((s) => s.figure))).not.toMatch(/"—"|"0%"/);
    expect(vm.defaultDetail).toEqual({
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
      expect(s.figure).toEqual({ kind: 'count', count: 0, share: 'not applicable' });
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
    expect(vm.defaultDetail).toBeNull();
    expect(vm.perf).toBeNull();
  });
});

describe('toPipelineVm — switches and off-states', () => {
  it('a null auto-layers view is loading — never "off instance-wide", never paused', () => {
    const vm = toPipelineVm(input({ autoLayers: null }));
    for (const id of ['classify', 'semantic', 'cascade'] as const) {
      expect(stage(vm, id).switchState).toEqual({ kind: 'loading' });
      expect(stage(vm, id).statusNow.loading).toBe(true);
    }
    expect(vm.stages.every((s) => s.status === null)).toBe(true);
    expect(JSON.stringify(vm.stages)).not.toContain('off instance-wide');
  });

  it('Layer 1 off pauses stages 2–5 in text, with no dimming style', () => {
    const vm = toPipelineVm(
      input({ autoLayers: layers({ structural: false, semantic: false, cascade: false }) }),
    );
    expect(stage(vm, 'classify').status).toEqual({ kind: 'off', tone: 'caution' });
    expect(stage(vm, 'classify').statusNow.text).toBe(
      'Off — new auto requests go straight to the default tier',
    );
    for (const id of ['workload', 'band', 'semantic', 'cascade'] as const) {
      expect(stage(vm, id).status).toEqual({ kind: 'paused', label: 'paused · needs L1' });
    }
    expect(stage(vm, 'default').status).toBeNull();
    // Text only: nothing in a row describes a reduced-contrast treatment.
    expect(JSON.stringify(vm.stages)).not.toMatch(/opacity|dim|muted|faint/i);
    // A paused stage whose OWN layer is off says so — it never describes a switched-off
    // layer as routing (the server clears L2/L3 with L1, so this is the common case).
    expect(stage(vm, 'semantic').statusNow.text).toBe('Off');
    expect(stage(vm, 'cascade').statusNow.text).toBe('Off');
    expect(stage(vm, 'semantic').caption).toBe('routed while L1 was on');
  });

  it('a paused stage whose own layer is on keeps its configuration summary', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ structural: false }) }));
    expect(stage(vm, 'semantic').status).toEqual({ kind: 'paused', label: 'paused · needs L1' });
    expect(stage(vm, 'semantic').statusNow.text).toBe('On · learning off');
    expect(stage(vm, 'cascade').status).toEqual({ kind: 'paused', label: 'paused · needs L1' });
    expect(stage(vm, 'cascade').statusNow.text).toBe(
      'On · Cheap first (tier:cheap), escalates to Strong (tier:premium)',
    );
  });

  it('L2 off alone is neutral and says where its traffic goes', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ semantic: false }) }));
    expect(stage(vm, 'semantic').status).toEqual({ kind: 'off', tone: 'neutral' });
    expect(stage(vm, 'semantic').statusNow).toMatchObject({
      text: 'Off — the ambiguous slice goes straight to the cascade',
      tone: 'neutral',
    });
    expect(stage(vm, 'semantic').caption).toBe('routed while on');
    expect(stage(vm, 'cascade').status).toBeNull();
    expect(stage(vm, 'workload').status).toBeNull();
    // Its count is still shown — as history for the range.
    expect(stage(vm, 'semantic').figure).toEqual({ kind: 'count', count: 5, share: '13%' });
  });

  it('L2 and L3 off: the ambiguous slice goes to the default tier, both neutral', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ semantic: false, cascade: false }) }));
    expect(stage(vm, 'semantic').statusNow.text).toBe(
      'Off — the ambiguous slice goes straight to the default tier',
    );
    expect(stage(vm, 'cascade').status).toEqual({ kind: 'off', tone: 'neutral' });
    expect(stage(vm, 'cascade').statusNow.text).toBe(
      'Off — still-ambiguous requests use the default tier',
    );
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

describe('toPipelineVm — configuration never waits on the aggregation', () => {
  it('statuses and switches are identical loading, failed or ready', () => {
    const config = (vm: { stages: StageRowVm[] }) =>
      vm.stages.map((s) => [s.statusNow, s.status, s.switchState]);
    const ready = config(toPipelineVm(input()));
    expect(config(toPipelineVm(input({ data: null })))).toEqual(ready);
    expect(config(toPipelineVm(input({ error: 'boom' })))).toEqual(ready);
  });
});

/* ── split-auto-routing-readout-setup: status now, history captions, verdicts ── */

function status(vm: { stages: StageRowVm[] }, id: StageRowVm['id']) {
  return stage(vm, id).statusNow;
}

/** Every string a stage's status carries, for "never contains" checks. */
function statusText(vm: { stages: StageRowVm[] }): string {
  return JSON.stringify(vm.stages.map((s) => s.statusNow));
}

describe('toPipelineVm — status now (D3)', () => {
  it('describes the current configuration of every stage', () => {
    const vm = toPipelineVm(input());
    expect(status(vm, 'classify')).toMatchObject({
      loading: false,
      text: 'On · thresholds high 0.6 · low 0.25 · instance defaults',
      tone: 'neutral',
    });
    expect(status(vm, 'workload').text).toBe('No class claims now');
    expect(status(vm, 'band')).toMatchObject({
      text: 'Strong: tier:premium · Cheap: tier:cheap',
      tone: 'neutral',
      routes: [
        { from: 'Strong', to: 'tier:premium' },
        { from: 'Cheap', to: 'tier:cheap' },
      ],
      lines: [{ text: 'For requests no claim took', tone: 'neutral' }],
    });
    expect(status(vm, 'semantic').text).toBe('On · learning off');
    expect(status(vm, 'cascade')).toMatchObject({
      text: 'On · Cheap first (tier:cheap), escalates to Strong (tier:premium)',
      tone: 'neutral',
      lines: [
        {
          text: 'A class’s own Strong or Cheap target replaces that leg for the class',
          tone: 'neutral',
        },
      ],
    });
    expect(status(vm, 'default')).toMatchObject({
      text: 'Always on',
      lines: [{ text: 'Where auto lands when a stage is off or a target is unusable' }],
    });
  });

  it('no status phrase contains an arrow character — pairs travel as routes', () => {
    const vm = toPipelineVm(
      input({
        rules: [
          ...GENERIC,
          rule({
            id: 'w',
            matchType: 'auto_workload',
            workloadClass: 'code',
            target: 'tier:cheap',
          }),
        ],
      }),
    );
    expect(statusText(vm)).not.toContain('→');
    expect(status(vm, 'workload').routes).toEqual([{ from: 'code', to: 'tier:cheap' }]);
    expect(status(vm, 'workload').text).toBe('code: tier:cheap');
    expect(status(vm, 'workload').lines).toEqual([
      { text: '1 of 5 classes claims — the rest pass to stage 3', tone: 'neutral' },
    ]);
  });

  it('loading auto-layers: stages 1–5 show a loading status, Default does not', () => {
    const vm = toPipelineVm(input({ autoLayers: null }));
    for (const id of ['classify', 'workload', 'band', 'semantic', 'cascade'] as const) {
      expect(status(vm, id).loading).toBe(true);
      expect(stage(vm, id).caption).toBeNull();
    }
    expect(status(vm, 'default').loading).toBe(false);
    expect(statusText(vm)).not.toMatch(/navailable|off instance/);
  });

  it('Layer 1 off: Classify is a caution, its dependants keep describing themselves', () => {
    const vm = toPipelineVm(
      input({ autoLayers: layers({ structural: false, semantic: false, cascade: false }) }),
    );
    expect(status(vm, 'classify')).toMatchObject({
      text: 'Off — new auto requests go straight to the default tier',
      tone: 'caution',
      lines: [{ text: 'Stages 2–5 pause without Layer 1’s verdicts', tone: 'neutral' }],
    });
    expect(status(vm, 'semantic').text).toBe('Off');
    expect(status(vm, 'cascade').text).toBe('Off');
  });

  it('L2 and L3 off are neutral and say where traffic goes instead', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ semantic: false, cascade: false }) }));
    expect(status(vm, 'semantic')).toMatchObject({
      text: 'Off — the ambiguous slice goes straight to the default tier',
      tone: 'neutral',
    });
    expect(status(vm, 'cascade')).toMatchObject({
      text: 'Off — still-ambiguous requests use the default tier',
      tone: 'neutral',
    });
  });

  it('an instance that cannot run a layer says it is unavailable, neutrally for L2/L3', () => {
    const vm = toPipelineVm(
      input({
        autoLayers: layers({
          semantic: false,
          semanticAvailable: false,
          cascade: false,
          cascadeAvailable: false,
        }),
      }),
    );
    expect(status(vm, 'semantic')).toMatchObject({
      text: 'Unavailable on this instance',
      tone: 'neutral',
      lines: [{ text: 'The ambiguous slice goes straight to the default tier' }],
    });
    expect(status(vm, 'cascade')).toMatchObject({
      text: 'Unavailable on this instance',
      tone: 'neutral',
    });
  });

  it('without the structural capability: Classify unavailable, stages 2–5 need L1, none paused', () => {
    const vm = toPipelineVm(
      input({
        autoLayers: layers({
          structural: false,
          structuralAvailable: false,
          semantic: false,
          cascade: false,
        }),
        data: null,
      }),
    );
    expect(status(vm, 'classify')).toMatchObject({
      text: 'Unavailable on this instance',
      tone: 'caution',
    });
    for (const id of ['workload', 'band', 'semantic', 'cascade'] as const) {
      expect(status(vm, id).text).toBe('Needs L1 — unavailable on this instance');
      expect(stage(vm, id).status?.kind).not.toBe('paused');
    }
    expect(statusText(vm)).not.toContain('paused');
  });

  it('a set but unusable generic target keeps its mark and turns Confident band to caution', () => {
    const empty = toPipelineVm(
      input({ rules: [rule({ id: 'hi', matchType: 'auto_high', target: 'tier:hollow' })] }),
    );
    expect(status(empty, 'band')).toMatchObject({
      text: 'Strong: tier:hollow (empty) · Cheap: not set',
      tone: 'caution',
    });
    const gone = toPipelineVm(
      input({ rules: [rule({ id: 'hi', matchType: 'auto_high', target: 'tier:deleted' })] }),
    );
    expect(status(gone, 'band').text).toBe('Strong: tier:deleted (unresolved) · Cheap: not set');
    expect(status(gone, 'band').tone).toBe('caution');
    // Unset alone is a configuration choice, never a caution.
    const unset = toPipelineVm(input({ rules: [GENERIC[0]!] }));
    expect(status(unset, 'band').tone).toBe('neutral');
  });

  it('Confident band names unclaimed classes with their own targets, never claimed ones', () => {
    const vm = toPipelineVm(
      input({
        rules: [
          ...GENERIC,
          rule({ id: 'v', matchType: 'auto_high', workloadClass: 'vision', target: 'model:m1' }),
          rule({ id: 'c1', matchType: 'auto_high', workloadClass: 'code', target: 'tier:cheap' }),
          rule({ id: 'c2', matchType: 'auto_low', workloadClass: 'code', target: 'tier:cheap' }),
          // structured is claimed: its scoped Strong is never consulted, so never named
          rule({
            id: 's1',
            matchType: 'auto_high',
            workloadClass: 'structured',
            target: 'tier:cheap',
          }),
          rule({
            id: 's2',
            matchType: 'auto_workload',
            workloadClass: 'structured',
            target: 'tier:premium',
          }),
        ],
      }),
    );
    expect(status(vm, 'band').lines[0]?.text).toBe(
      'For requests no claim took · code uses its own Strong and Cheap · vision uses its own Strong',
    );
    expect(status(vm, 'band').lines[0]?.text).not.toContain('structured');
  });

  it('a configured claim that steers nothing is a caution line on Workload claim', () => {
    const vm = toPipelineVm(
      input({
        rules: [
          ...GENERIC,
          rule({
            id: 'w',
            matchType: 'auto_workload',
            workloadClass: 'vision',
            target: 'tier:hollow',
          }),
        ],
      }),
    );
    expect(status(vm, 'workload').text).toBe('No class claims now');
    expect(status(vm, 'workload').lines).toEqual([
      { text: '1 configured claim steers nothing', tone: 'caution' },
    ]);
  });

  it('status now is identical whether the aggregation is loading, failed or ready', () => {
    const all = (vm: { stages: StageRowVm[] }) => vm.stages.map((s) => s.statusNow);
    const ready = all(toPipelineVm(input()));
    expect(all(toPipelineVm(input({ data: null })))).toEqual(ready);
    expect(all(toPipelineVm(input({ error: 'boom' })))).toEqual(ready);
  });
});

describe('cascadePairs — each leg resolves on its own (D3)', () => {
  const codeCheap = rule({
    id: 'cc',
    matchType: 'auto_low',
    workloadClass: 'code',
    target: 'tier:cheap',
  });
  const strongOnly = [rule({ id: 'hi', matchType: 'auto_high', target: 'tier:premium' })];

  it('generic Cheap unset + an unclaimed code with its own Cheap: code cascades, not caution', () => {
    const vm = toPipelineVm(input({ rules: [...strongOnly, codeCheap] }));
    expect(status(vm, 'cascade')).toMatchObject({
      text: 'On · Cheap first (not set), escalates to Strong (tier:premium)',
      tone: 'neutral',
      lines: [{ text: 'Only code can cascade — other ambiguous requests go to Default' }],
    });
    expect(stage(vm, 'cascade').caption).toBe('routed here');
    expect(vm.cascadeHistory).toBe(false);
  });

  it('a scoped Cheap that is set but empty never falls back to the generic one', () => {
    const vm = toPipelineVm(
      input({
        rules: [
          ...GENERIC,
          rule({ id: 'cc', matchType: 'auto_low', workloadClass: 'code', target: 'tier:hollow' }),
        ],
      }),
    );
    // The generic pair is usable, so the cascade runs — but not through code's pair.
    expect(status(vm, 'cascade').tone).toBe('neutral');
    const onlyScoped = toPipelineVm(
      input({
        rules: [
          ...strongOnly,
          rule({ id: 'cc', matchType: 'auto_low', workloadClass: 'code', target: 'tier:hollow' }),
        ],
      }),
    );
    expect(status(onlyScoped, 'cascade')).toMatchObject({
      text: 'On, but needs usable Strong and Cheap targets',
      tone: 'caution',
      lines: [{ text: 'Cheap: not set · Strong: tier:premium' }],
    });
  });

  it('a claimed class’s scoped pair does not count — its claim wins', () => {
    const vm = toPipelineVm(
      input({
        rules: [
          ...strongOnly,
          codeCheap,
          rule({
            id: 'w',
            matchType: 'auto_workload',
            workloadClass: 'code',
            target: 'tier:premium',
          }),
        ],
      }),
    );
    expect(status(vm, 'cascade').text).toBe('On, but needs usable Strong and Cheap targets');
    expect(stage(vm, 'cascade').caption).toBe('routed while it could run');
    expect(vm.cascadeHistory).toBe(true);
  });

  it('several classes are listed in words', () => {
    const vm = toPipelineVm(
      input({
        rules: [
          ...strongOnly,
          codeCheap,
          rule({ id: 'vc', matchType: 'auto_low', workloadClass: 'vision', target: 'tier:cheap' }),
        ],
      }),
    );
    expect(status(vm, 'cascade').lines[0]?.text).toBe(
      'Only code and vision can cascade — other ambiguous requests go to Default',
    );
  });
});

describe('toPipelineVm — history captions (D3)', () => {
  it('a running pipeline captions every count as what it routed', () => {
    const vm = toPipelineVm(input());
    expect(vm.stages.map((s) => s.caption)).toEqual([
      'evaluated',
      'routed here',
      'routed here',
      'routed here',
      'routed here',
      'routed here',
    ]);
    expect(vm.cascadeHistory).toBe(false);
  });

  it('Layer 1 off: Classify counts were evaluated while it was on, stages 2–5 routed while it was on', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ structural: false }) }));
    expect(vm.stages.map((s) => s.caption)).toEqual([
      'evaluated while L1 was on',
      'routed while L1 was on',
      'routed while L1 was on',
      'routed while L1 was on',
      'routed while L1 was on',
      'routed here',
    ]);
    expect(vm.cascadeHistory).toBe(true);
  });

  it('L2 or L3 off: that stage routed while on, and the savings cover earlier cascades', () => {
    const vm = toPipelineVm(input({ autoLayers: layers({ semantic: false, cascade: false }) }));
    expect(stage(vm, 'semantic').caption).toBe('routed while on');
    expect(stage(vm, 'cascade').caption).toBe('routed while on');
    expect(stage(vm, 'band').caption).toBe('routed here');
    expect(vm.cascadeHistory).toBe(true);
  });

  it('no usable band target anywhere: Confident band routed under earlier targets', () => {
    const vm = toPipelineVm(input({ rules: [] }));
    expect(stage(vm, 'band').caption).toBe('routed under earlier targets');
    // A class with a usable target of its own still routes some requests: no history.
    const scoped = toPipelineVm(
      input({
        rules: [
          rule({ id: 'v', matchType: 'auto_high', workloadClass: 'vision', target: 'model:m1' }),
        ],
      }),
    );
    expect(stage(scoped, 'band').caption).toBe('routed here');
  });

  it('no live claim now but claim traffic in the range: routed under earlier claims', () => {
    const data = perf({
      exits: { workload: 4, structural: 18, semantic: 5, cascade: 10, default: 3 },
    });
    expect(stage(toPipelineVm(input({ data })), 'workload').caption).toBe(
      'routed under earlier claims',
    );
    // A zero claim exit is not history.
    expect(stage(toPipelineVm(input()), 'workload').caption).toBe('routed here');
  });

  it('an unverified column withholds every caption the stale snapshot would produce', () => {
    const data = perf({
      exits: { workload: 4, structural: 18, semantic: 5, cascade: 10, default: 3 },
    });
    for (const unverified of [
      { bands: true, claims: false },
      { bands: false, claims: true },
    ]) {
      const vm = toPipelineVm({ ...input({ data, rules: [] }), unverified });
      expect(stage(vm, 'workload').caption).toBe('routed here');
      expect(stage(vm, 'band').caption).toBe('routed here');
      expect(stage(vm, 'cascade').caption).toBe('routed here');
      expect(vm.cascadeHistory).toBe(false);
      for (const id of ['workload', 'band', 'cascade'] as const) {
        expect(status(vm, id).lines).toContainEqual({
          text: 'Last loaded targets — routing may have changed; see Targets',
          tone: 'caution',
        });
      }
      // Classify, Semantic and Default do not read the rules snapshot.
      for (const id of ['classify', 'semantic', 'default'] as const)
        expect(JSON.stringify(status(vm, id))).not.toContain('Last loaded targets');
    }
    // The same snapshot verified does draw the conclusions.
    const verified = toPipelineVm(input({ data, rules: [] }));
    expect(stage(verified, 'workload').caption).toBe('routed under earlier claims');
    expect(stage(verified, 'band').caption).toBe('routed under earlier targets');
    expect(stage(verified, 'cascade').caption).toBe('routed while it could run');
  });
});

describe('toPipelineVm — Classify verdicts', () => {
  it('states the verdict counts worded as verdicts, under the figures’ designed states', () => {
    const ready = stage(toPipelineVm(input()), 'classify').verdicts;
    expect(ready).toEqual({
      kind: 'value',
      text: 'verdicts: 12 high · 16 low · 12 ambiguous',
      claimed: null,
    });
    expect(stage(toPipelineVm(input({ data: null })), 'classify').verdicts).toEqual({
      kind: 'placeholder',
    });
    expect(stage(toPipelineVm(input({ error: 'boom' })), 'classify').verdicts).toEqual({
      kind: 'none',
    });
    for (const id of ['workload', 'band', 'semantic', 'cascade', 'default'] as const)
      expect(stage(toPipelineVm(input()), id).verdicts).toBeNull();
  });

  it('Layer 1 off captions the verdicts as history; a workload claim’s share is disclosed', () => {
    const off = stage(
      toPipelineVm(input({ autoLayers: layers({ structural: false }) })),
      'classify',
    ).verdicts;
    expect(off).toMatchObject({
      text: 'verdicts while L1 was on: 12 high · 16 low · 12 ambiguous',
    });
    const data = perf({
      workloadMix: {
        ...DEFAULT_AUTO_PERF.workloadMix,
        classes: [
          {
            class: 'code',
            requests: 5,
            spendUsd: 0.1,
            unpricedRequests: 0,
            unpricedAttempts: 0,
            routed: 3,
          },
        ],
      },
    });
    expect(stage(toPipelineVm(input({ data })), 'classify').verdicts).toMatchObject({
      claimed: '3 of these were served by a Workload claim, not a band target',
    });
  });
});

describe('toPipelineVm — per-row bars (D1)', () => {
  it('stages 2–6 draw a track at their exit’s share; the five shares sum to evaluated', () => {
    const vm = toPipelineVm(input());
    expect(stage(vm, 'classify').bar).toBeNull();
    const ratios = vm.stages.slice(1).map((s) => (s.bar?.kind === 'track' ? s.bar.ratio : NaN));
    expect(ratios).toEqual([0, 22 / 40, 5 / 40, 10 / 40, 3 / 40]);
    expect(ratios.reduce((a, r) => a + r, 0)).toBeCloseTo(1, 10);
  });

  it('a zero exit keeps an empty track rather than no bar', () => {
    expect(stage(toPipelineVm(input()), 'workload').bar).toEqual({ kind: 'track', ratio: 0 });
  });

  it('loading shows placeholders; zero, failure, no exits and no capability draw none', () => {
    for (const s of toPipelineVm(input({ data: null })).stages.slice(1))
      expect(s.bar).toEqual({ kind: 'placeholder' });
    const zero = perf({
      evaluated: 0,
      fallthrough: 0,
      exits: { workload: 0, structural: 0, semantic: 0, cascade: 0, default: 0 },
    });
    const noExits = perf();
    delete noExits.exits;
    for (const vm of [
      toPipelineVm(input({ data: zero })),
      toPipelineVm(input({ error: 'boom' })),
      toPipelineVm(input({ data: noExits })),
      toPipelineVm(
        input({
          autoLayers: layers({ structural: false, structuralAvailable: false }),
          data: null,
        }),
      ),
    ])
      for (const s of vm.stages) expect(s.bar).toBeNull();
  });
});

describe('toPipelineVm — the Confident band alert (D5)', () => {
  const unroutable = (high: number, low: number) =>
    perf({
      bands: {
        ...DEFAULT_AUTO_PERF.bands,
        high: { ...DEFAULT_AUTO_PERF.bands.high, unroutable: high },
        low: { ...DEFAULT_AUTO_PERF.bands.low, unroutable: low },
      },
    });

  it('names one band’s column when only it fell through', () => {
    expect(toPipelineVm(input({ data: unroutable(1, 0) })).bandAlert).toEqual({
      text: '1 confident high verdict had no usable Strong target and went to Default — check the missing-or-unusable target in the Targets matrix’s Strong column, on the Any request and class rows',
      columns: ['strong'],
    });
    expect(toPipelineVm(input({ data: unroutable(0, 3) })).bandAlert).toMatchObject({
      text: expect.stringMatching(/^3 confident low verdicts had no usable Cheap target/) as string,
      columns: ['cheap'],
    });
  });

  it('names both columns, Strong first, when both fell through', () => {
    expect(toPipelineVm(input({ data: unroutable(2, 5) })).bandAlert).toMatchObject({
      text: expect.stringContaining('Strong and Cheap columns') as string,
      columns: ['strong', 'cheap'],
    });
  });

  it('is absent while loading, after a failure, and at zero — never a placeholder', () => {
    expect(toPipelineVm(input({ data: null })).bandAlert).toBeNull();
    expect(toPipelineVm(input({ data: unroutable(1, 1), error: 'boom' })).bandAlert).toBeNull();
    expect(toPipelineVm(input({ data: unroutable(0, 0) })).bandAlert).toBeNull();
  });

  it('never names the Any request target as the cause (the count is not scope-aware)', () => {
    const text = toPipelineVm(input({ data: unroutable(1, 1) })).bandAlert?.text ?? '';
    expect(text).not.toMatch(/Any request (Strong|Cheap) target/);
    expect(text).not.toMatch(/\b(above|below)\b/);
  });
});
