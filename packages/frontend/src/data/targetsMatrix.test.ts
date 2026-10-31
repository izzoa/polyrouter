import { describe, expect, it } from 'vitest';
import type { Model } from '../types';
import type { AutoPerformance, RuleDto } from './api';
import { WORKLOAD_ROW_ORDER } from './workloadTargets';
import {
  toTargetsMatrixVm,
  unresolvedHint,
  type TargetsMatrixInput,
  type TargetsRowVm,
} from './targetsMatrix';
import { DEFAULT_AUTO_PERF } from '../test/fakeClient';

const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-02T00:00:00.000Z';
const RANGE = '7d' as const;
const HALF = 'add semantic to ROUTING_AUTO_LAYERS';

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

function model(id: string, over: Partial<Model> = {}): Model {
  return {
    id,
    providerId: 'p1',
    externalModelId: `ext-${id}`,
    displayName: null,
    // contextWindow omitted: absent = unknown (honest-model-capabilities)
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
    ...over,
  };
}

function entry(id: string, tierId: string, modelId: string, position: number) {
  return { id, tierId, modelId, position, mode: 'any' as const, model: null };
}

function input(
  over: Partial<Omit<TargetsMatrixInput, 'catalog'>> & { rules?: RuleDto[] } = {},
): TargetsMatrixInput {
  const { rules = [], ...rest } = over;
  return {
    catalog: {
      rules,
      tiers: [
        { id: 't-premium', key: 'premium', displayName: null, description: null, createdAt: T0 },
        { id: 't-cheap', key: 'cheap', displayName: null, description: null, createdAt: T0 },
        { id: 't-empty', key: 'empty', displayName: null, description: null, createdAt: T0 },
        { id: 't-default', key: 'default', displayName: null, description: null, createdAt: T0 },
      ],
      tierEntries: {
        't-premium': [entry('e1', 't-premium', 'm1', 0), entry('e2', 't-premium', 'm2', 1)],
        't-cheap': [entry('e3', 't-cheap', 'm2', 0)],
        't-empty': [],
        't-default': [entry('e4', 't-default', 'm1', 0)],
      },
      models: [
        model('m1', { displayName: 'GPT X' }),
        model('m2'),
        model('m-gone', { displayName: 'Retired', unlistedSince: T1 }),
        model('m-twin', {
          externalModelId: 'openai/gpt-x:batch',
          variant: 'batch',
          baseExternalModelId: 'openai/gpt-x',
        }),
      ],
      providers: [{ id: 'p1', name: 'Stub' } as TargetsMatrixInput['catalog']['providers'][number]],
    },
    autoPerf: { data: null, error: null, range: RANGE },
    semanticWorkload: false,
    missingHalf: HALF,
    cascadeEffective: true,
    ...rest,
  };
}

function perf(over: Partial<AutoPerformance> = {}): AutoPerformance {
  return { ...DEFAULT_AUTO_PERF, ...over };
}

function withClasses(classes: AutoPerformance['workloadMix']['classes']): AutoPerformance {
  return perf({ workloadMix: { ...DEFAULT_AUTO_PERF.workloadMix, classes } });
}

function mixRow(cls: string, requests: number, routed: number) {
  return { class: cls, requests, unpricedRequests: 0, unpricedAttempts: 0, spendUsd: null, routed };
}

const GENERIC_HIGH = rule({ id: 'g-high', matchType: 'auto_high', target: 'tier:premium' });
const GENERIC_LOW = rule({ id: 'g-low', matchType: 'auto_low', target: 'tier:cheap' });

function row(vm: ReturnType<typeof toTargetsMatrixVm>, id: TargetsRowVm['id']): TargetsRowVm {
  const r = vm.rows.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
}

describe('toTargetsMatrixVm — rows and wiring', () => {
  it('orders Any request first, then the workload classes live-before-reserved', () => {
    const vm = toTargetsMatrixVm(input());
    expect(vm.rows.map((r) => r.id)).toEqual(['any', ...WORKLOAD_ROW_ORDER]);
    expect(vm.rows.map((r) => r.label)).toEqual([
      'Any request',
      'Code',
      'Vision',
      'Structured output',
      'Research',
      'Writing',
    ]);
    expect(vm.rows.filter((r) => r.reserved).map((r) => r.id)).toEqual(['research', 'writing']);
  });

  it('wires each cell to the rule type and scope its store action takes', () => {
    const vm = toTargetsMatrixVm(input());
    const any = row(vm, 'any');
    expect([any.strong.band, any.strong.scope, any.cheap.band, any.cheap.scope]).toEqual([
      'auto_high',
      null,
      'auto_low',
      null,
    ]);
    const code = row(vm, 'code');
    expect([code.claim.band, code.claim.scope]).toEqual(['auto_workload', 'code']);
    expect([code.strong.band, code.strong.scope]).toEqual(['auto_high', 'code']);
    expect([code.cheap.band, code.cheap.scope]).toEqual(['auto_low', 'code']);
    expect([code.claim.column, code.strong.column, code.cheap.column]).toEqual([
      'claim',
      'strong',
      'cheap',
    ]);
  });

  it('keeps generic and scoped rules apart: each scope resolves and sheds its own duplicates', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [
          GENERIC_HIGH,
          rule({ id: 'g-high-dup', target: 'tier:cheap', createdAt: T1 }),
          rule({ id: 'code-high', workloadClass: 'code', target: 'tier:default', priority: 9 }),
          rule({ id: 'code-high-dup', workloadClass: 'code', target: 'tier:cheap', createdAt: T1 }),
        ],
      }),
    );
    const any = row(vm, 'any');
    expect(any.strong.effective?.id).toBe('g-high');
    expect(any.strong.shadowed.map((r) => r.id)).toEqual(['g-high-dup']);
    const code = row(vm, 'code');
    expect(code.strong.kind).toBe('set');
    expect(code.strong.effective?.id).toBe('code-high');
    expect(code.strong.shadowed.map((r) => r.id)).toEqual(['code-high-dup']);
    // Another class sees neither scope's rules as its own.
    expect(row(vm, 'vision').strong.effective).toBeNull();
  });
});

describe('toTargetsMatrixVm — the Any request row', () => {
  it('has an n/a, read-only Claim cell that says a claim needs a class', () => {
    const claim = row(toTargetsMatrixVm(input()), 'any').claim;
    expect(claim.kind).toBe('na');
    expect(claim.editable).toBe(false);
    expect(claim.claimed).toBe(false);
    expect(claim.effective).toBeNull();
    expect(claim.unsetText).toMatch(/a claim needs a workload class/);
  });

  it('presents the generic bands: unset copy names the fall-through, a set band resolves', () => {
    const any = row(toTargetsMatrixVm(input({ rules: [GENERIC_HIGH] })), 'any');
    expect(any.strong.kind).toBe('set');
    expect(any.strong.target).toMatchObject({ kind: 'tier', key: 'premium', fallbacks: 1 });
    expect(any.strong.editable).toBe(true);
    expect(any.cheap.kind).toBe('unset');
    expect(any.cheap.inherits).toBeNull();
    expect(any.cheap.unsetText).toBe('Not set — confident low verdicts fall through to default');
    expect(any.claimed).toBe(false);
    expect(any.claimNote).toBeNull();
    expect(any.inertNote).toBeNull();
  });

  it('its Detected cell is the evaluated count once loaded', () => {
    const vm = toTargetsMatrixVm(
      input({ autoPerf: { data: perf({ evaluated: 41 }), error: null, range: '30d' } }),
    );
    expect(row(vm, 'any').detected).toEqual({
      kind: 'value',
      value: { requests: 41, routed: null, range: '30d' },
    });
  });
});

describe('toTargetsMatrixVm — inheritance', () => {
  it('an unset scoped cell inherits and names the generic target', () => {
    const vm = toTargetsMatrixVm(input({ rules: [GENERIC_HIGH, GENERIC_LOW] }));
    const structured = row(vm, 'structured');
    expect(structured.strong.kind).toBe('inherit');
    expect(structured.strong.inherits).toMatchObject({ label: 'tier: premium', usable: true });
    expect(structured.strong.unsetText).toBe(
      '= any — structured requests use the Any request strong target: tier: premium',
    );
    expect(structured.cheap.kind).toBe('inherit');
    expect(structured.cheap.inherits?.label).toBe('tier: cheap');
    // Inheriting is configuration, not a measured figure — and still editable.
    expect(structured.strong.editable).toBe(true);
    expect(structured.strong.unroutable).toEqual({ kind: 'none' });
  });

  it('an inherit cell over an unset or unusable generic says where verdicts go', () => {
    const unset = row(toTargetsMatrixVm(input()), 'vision').strong;
    expect(unset.kind).toBe('inherit');
    expect(unset.inherits).toMatchObject({ label: 'not set', usable: false });
    expect(unset.unsetText).toMatch(
      /which is not set: confident high verdicts fall through to default$/,
    );
    const empty = row(
      toTargetsMatrixVm(input({ rules: [rule({ matchType: 'auto_low', target: 'tier:empty' })] })),
      'vision',
    ).cheap;
    expect(empty.kind).toBe('inherit');
    expect(empty.inherits).toMatchObject({ label: 'tier: empty', usable: false });
    expect(empty.unsetText).toMatch(/\(tier: empty\), which is unusable: confident low verdicts/);
  });

  it('a set-but-unusable scoped cell is unroutable for the class, not inherited', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [
          GENERIC_HIGH,
          GENERIC_LOW,
          rule({ id: 'v-high', workloadClass: 'vision', target: 'tier:empty' }),
          rule({
            id: 'v-low',
            matchType: 'auto_low',
            workloadClass: 'vision',
            target: 'tier:gone',
          }),
        ],
      }),
    );
    const vision = row(vm, 'vision');
    expect(vision.strong.kind).toBe('empty');
    expect(vision.strong.inherits).toBeNull();
    expect(vision.strong.usable).toBe(false);
    expect(vision.strong.notes.emptyTier).toBe(true);
    expect(vision.cheap.kind).toBe('unresolved');
    expect(vision.cheap.inherits).toBeNull();
    expect(vision.cheap.target).toEqual({
      kind: 'unresolved',
      literal: 'tier:gone',
      parsed: 'tier',
    });
    expect(vision.cheap.notes.unresolvedHint).toBe('Recreating the tier key rebinds this rule.');
  });
});

describe('toTargetsMatrixVm — the claimed flag', () => {
  const claim = (cls: string, target = 'tier:premium', id = `claim-${cls}`) =>
    rule({ id, matchType: 'auto_workload', workloadClass: cls, target });

  it('is a flag beside the kind on the band cells of a usable, live claim', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [
          GENERIC_HIGH,
          claim('code'),
          rule({
            id: 'code-low',
            matchType: 'auto_low',
            workloadClass: 'code',
            target: 'tier:cheap',
          }),
        ],
      }),
    );
    const code = row(vm, 'code');
    expect(code.claimed).toBe(true);
    expect(code.claim.kind).toBe('set');
    expect(code.claim.claimed).toBe(false); // the row carries the annotation
    expect([code.strong.kind, code.strong.claimed]).toEqual(['inherit', true]);
    expect([code.cheap.kind, code.cheap.claimed]).toEqual(['set', true]);
    // No row note: the claimed annotation rides the band cells, never replacing them.
    expect(code.claimNote).toBeNull();
    // Other rows stay unclaimed.
    expect(row(vm, 'vision').strong.claimed).toBe(false);
  });

  it('a usable claim with an unresolved scoped Strong rule still presents that rule in full', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [
          claim('code'),
          rule({ id: 'code-high', workloadClass: 'code', target: 'model:deleted' }),
          rule({ id: 'code-high-dup', workloadClass: 'code', target: 'tier:cheap', createdAt: T1 }),
        ],
      }),
    );
    const strong = row(vm, 'code').strong;
    expect(strong.claimed).toBe(true);
    expect(strong.kind).toBe('unresolved');
    expect(strong.target).toEqual({
      kind: 'unresolved',
      literal: 'model:deleted',
      parsed: 'model',
    });
    expect(strong.notes.unresolvedHint).toBe('The model no longer exists — pick a new target.');
    // Picker, Clear and cleanup stay available under the claim.
    expect(strong.editable).toBe(true);
    expect(strong.effective?.id).toBe('code-high');
    expect(strong.shadowed.map((r) => r.id)).toEqual(['code-high-dup']);
  });

  it('a configured but unusable claim does not claim, and the row says the bands apply', () => {
    const empty = row(toTargetsMatrixVm(input({ rules: [claim('code', 'tier:empty')] })), 'code');
    expect(empty.claimed).toBe(false);
    expect(empty.strong.claimed).toBe(false);
    expect(empty.claim.kind).toBe('empty');
    expect(empty.claimNote).toEqual({
      kind: 'unusable',
      text: 'The Workload target for code is set but unusable (empty tier) — it does not claim; the bands apply.',
    });
    const unresolved = row(
      toTargetsMatrixVm(input({ rules: [claim('vision', 'tier:gone')] })),
      'vision',
    );
    expect(unresolved.claim.kind).toBe('unresolved');
    expect(unresolved.claimNote?.text).toMatch(
      /\(unresolved\) — it does not claim; the bands apply/,
    );
  });

  it('no claim leaves the row unannotated and the claim cell on its unset copy', () => {
    const code = row(toTargetsMatrixVm(input()), 'code');
    expect(code.claim.kind).toBe('unset');
    expect(code.claim.editable).toBe(true);
    expect(code.claim.unsetText).toMatch(/follow the complexity path/);
    expect(code.claimNote).toBeNull();
  });

  it('a reserved class with an API-created usable claim and an inert source is not claimed', () => {
    const research = row(
      toTargetsMatrixVm(input({ rules: [claim('research')], semanticWorkload: false })),
      'research',
    );
    expect(research.live).toBe(false);
    expect(research.claimed).toBe(false);
    expect(research.strong.claimed).toBe(false);
    expect(research.cheap.claimed).toBe(false);
    expect(research.claimNote).toBeNull();
    // The API-created rule is carried for read-only disclosure.
    expect(research.claim.kind).toBe('readonly');
    expect(research.claim.editable).toBe(false);
    expect(research.claim.effective?.id).toBe('claim-research');
    expect(research.claim.target).toMatchObject({ kind: 'tier', key: 'premium' });
  });
});

describe('toTargetsMatrixVm — reserved rows', () => {
  it('with an inert source: band cells stay editable and the row says it is inert', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [
          rule({
            id: 'w-claim',
            matchType: 'auto_workload',
            workloadClass: 'writing',
            target: 'tier:empty',
          }),
          rule({ id: 'w-high', workloadClass: 'writing', target: 'tier:premium' }),
        ],
      }),
    );
    for (const id of ['research', 'writing'] as const) {
      const r = row(vm, id);
      expect(r.claim.kind).toBe('readonly');
      expect(r.claim.unsetText).toMatch(/stays inert until it is/);
      expect(r.strong.editable).toBe(true);
      expect(r.cheap.editable).toBe(true);
      expect(r.inertNote).toContain('inert until the semantic workload source is effective');
      expect(r.inertNote).toContain(`(${HALF})`);
      // Never "the bands apply" — not even for an unusable API-created claim.
      expect(r.claimNote).toBeNull();
      expect(r.inertNote).not.toMatch(/bands apply/);
    }
    expect(row(vm, 'writing').strong.kind).toBe('set');
    expect(row(vm, 'writing').claim.notes.emptyTier).toBe(true);
    // Structural rows are never inert.
    expect(row(vm, 'code').inertNote).toBeNull();
  });

  it('omits the missing-half parenthetical when the page has none to name', () => {
    const r = row(toTargetsMatrixVm(input({ missingHalf: '' })), 'research');
    expect(r.inertNote).toBe(
      "This row's claim and bands are inert until the semantic workload source is effective: research requests are not detected yet.",
    );
  });

  it('go live exactly when the semantic workload source is effective', () => {
    const vm = toTargetsMatrixVm(
      input({
        semanticWorkload: true,
        missingHalf: '',
        rules: [rule({ id: 'r-claim', matchType: 'auto_workload', workloadClass: 'research' })],
      }),
    );
    const research = row(vm, 'research');
    expect(research.live).toBe(true);
    expect(research.inertNote).toBeNull();
    expect(research.claim.kind).toBe('set');
    expect(research.claim.editable).toBe(true);
    expect(research.claimed).toBe(true);
    expect(research.strong.claimed).toBe(true);
    const writing = row(vm, 'writing');
    expect(writing.claim.kind).toBe('unset');
    expect(writing.claim.editable).toBe(true);
  });
});

describe('toTargetsMatrixVm — Detected cells', () => {
  it('read requests and routed from the workload mix, zero for an absent class once loaded', () => {
    const vm = toTargetsMatrixVm(
      input({
        autoPerf: {
          data: withClasses([mixRow('none', 20, 0), mixRow('code', 9, 4), mixRow('vision', 0, 0)]),
          error: null,
          range: '24h',
        },
      }),
    );
    expect(row(vm, 'code').detected).toEqual({
      kind: 'value',
      value: { requests: 9, routed: 4, range: '24h' },
    });
    expect(row(vm, 'vision').detected).toEqual({
      kind: 'value',
      value: { requests: 0, routed: 0, range: '24h' },
    });
    for (const id of ['structured', 'research', 'writing'] as const) {
      expect(row(vm, id).detected).toEqual({
        kind: 'value',
        value: { requests: 0, routed: 0, range: '24h' },
      });
    }
  });

  it('show a placeholder on every row while the aggregation has no data', () => {
    const vm = toTargetsMatrixVm(input());
    for (const r of vm.rows) expect(r.detected).toEqual({ kind: 'placeholder' });
  });

  it('show nothing on every row while the load has failed — even with earlier data kept', () => {
    const vm = toTargetsMatrixVm(
      input({ autoPerf: { data: DEFAULT_AUTO_PERF, error: 'boom', range: RANGE } }),
    );
    for (const r of vm.rows) expect(r.detected).toEqual({ kind: 'none' });
  });
});

describe('toTargetsMatrixVm — unroutable notes', () => {
  const loaded = (high: number, low: number): TargetsMatrixInput['autoPerf'] => ({
    data: perf({
      bands: {
        ...DEFAULT_AUTO_PERF.bands,
        high: { ...DEFAULT_AUTO_PERF.bands.high, unroutable: high },
        low: { ...DEFAULT_AUTO_PERF.bands.low, unroutable: low },
      },
    }),
    error: null,
    range: '30d',
  });

  it('carry the range-framed count on an unset or degraded generic cell once loaded', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [rule({ matchType: 'auto_low', target: 'tier:empty' })],
        autoPerf: loaded(3, 2),
      }),
    );
    const any = row(vm, 'any');
    expect(any.strong.unroutable).toEqual({ kind: 'value', value: { count: 3, range: '30d' } });
    expect(any.cheap.kind).toBe('empty');
    expect(any.cheap.unroutable).toEqual({ kind: 'value', value: { count: 2, range: '30d' } });
  });

  it('follow the same loading and failure rules as Detected', () => {
    const loading = row(toTargetsMatrixVm(input()), 'any');
    expect(loading.strong.unroutable).toEqual({ kind: 'placeholder' });
    expect(loading.cheap.unroutable).toEqual({ kind: 'placeholder' });
    const failed = row(
      toTargetsMatrixVm(input({ autoPerf: { ...loaded(3, 2), error: 'boom' } })),
      'any',
    );
    expect(failed.strong.unroutable).toEqual({ kind: 'none' });
    expect(failed.cheap.unroutable).toEqual({ kind: 'none' });
  });

  it('are absent on a usable generic cell, a zero count, and every class or claim cell', () => {
    const vm = toTargetsMatrixVm(input({ rules: [GENERIC_HIGH], autoPerf: loaded(5, 0) }));
    const any = row(vm, 'any');
    expect(any.strong.unroutable).toEqual({ kind: 'none' }); // usable
    expect(any.cheap.unroutable).toEqual({ kind: 'none' }); // unset, but nothing fell through
    expect(any.claim.unroutable).toEqual({ kind: 'none' });
    for (const r of vm.rows.slice(1)) {
      for (const c of [r.claim, r.strong, r.cheap]) expect(c.unroutable).toEqual({ kind: 'none' });
    }
  });
});

describe('toTargetsMatrixVm — per-cell notes', () => {
  it('flag an unlisted model target in any column', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [
          rule({ id: 'g-high', target: 'model:m-gone' }),
          rule({
            id: 'c-claim',
            matchType: 'auto_workload',
            workloadClass: 'code',
            target: 'model:m-gone',
          }),
          rule({
            id: 'c-low',
            matchType: 'auto_low',
            workloadClass: 'code',
            target: 'model:m-gone',
          }),
        ],
      }),
    );
    const cells = [row(vm, 'any').strong, row(vm, 'code').claim, row(vm, 'code').cheap];
    // The cell carries the unlisted model itself; TargetSummary words the note, so
    // the matrix never prints it a second time.
    for (const c of cells) {
      expect(c.target.kind === 'model' && c.target.model.id).toBe('m-gone');
      expect(c.target.kind === 'model' && c.target.model.unlistedSince).toBe(T1);
      expect(c.notes.nonRoutable).toBeNull();
    }
  });

  it('flag a batch-only (non-routable) model target in any column', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [
          rule({ id: 'g-low', matchType: 'auto_low', target: 'model:m-twin' }),
          rule({
            id: 's-claim',
            matchType: 'auto_workload',
            workloadClass: 'structured',
            target: 'model:m-twin',
          }),
          rule({ id: 's-high', workloadClass: 'structured', target: 'model:m-twin' }),
        ],
      }),
    );
    const cells = [row(vm, 'any').cheap, row(vm, 'structured').claim, row(vm, 'structured').strong];
    for (const c of cells) {
      expect(c.notes.nonRoutable?.id).toBe('m-twin');
    }
    expect(row(vm, 'any').strong.notes.nonRoutable).toBeNull();
  });

  it('flag empty tiers and carry the unresolved hint, read-only claims included', () => {
    const vm = toTargetsMatrixVm(
      input({
        rules: [
          rule({ id: 'g-high', target: 'tier:empty' }),
          rule({
            id: 'r-claim',
            matchType: 'auto_workload',
            workloadClass: 'research',
            target: 'nonsense',
          }),
        ],
      }),
    );
    const strong = row(vm, 'any').strong;
    expect(strong.kind).toBe('empty');
    expect(strong.notes).toEqual({
      nonRoutable: null,
      emptyTier: true,
      unresolvedHint: null,
    });
    const research = row(vm, 'research').claim;
    expect(research.kind).toBe('readonly');
    expect(research.notes.unresolvedHint).toBe(
      'The stored target is malformed — pick a new target.',
    );
  });

  it('unresolvedHint keeps the page text and is null for a resolved target', () => {
    expect(unresolvedHint({ kind: 'unresolved', literal: 'tier:x', parsed: 'tier' })).toBe(
      'Recreating the tier key rebinds this rule.',
    );
    expect(unresolvedHint({ kind: 'unset' })).toBeNull();
  });
});

describe('toTargetsMatrixVm — matrix notes consider generic rules only', () => {
  it('cascade-needs-both reads the generic bands, never a scoped rule', () => {
    const scopedOnly = toTargetsMatrixVm(
      input({
        rules: [
          GENERIC_HIGH,
          rule({
            id: 'code-low',
            matchType: 'auto_low',
            workloadClass: 'code',
            target: 'tier:cheap',
          }),
        ],
      }),
    );
    expect(scopedOnly.cascadeNeedsBoth).toBe(true);
    const both = toTargetsMatrixVm(input({ rules: [GENERIC_HIGH, GENERIC_LOW] }));
    expect(both.cascadeNeedsBoth).toBe(false);
    const cascadeOff = toTargetsMatrixVm(input({ rules: [GENERIC_HIGH], cascadeEffective: false }));
    expect(cascadeOff.cascadeNeedsBoth).toBe(false);
  });

  it('same-destination reads the generic bands, never a scoped rule', () => {
    const generic = toTargetsMatrixVm(
      input({ rules: [GENERIC_HIGH, rule({ id: 'g-low', matchType: 'auto_low' })] }),
    );
    expect(generic.sameDestination).toBe(true);
    const scoped = toTargetsMatrixVm(
      input({
        rules: [
          GENERIC_HIGH,
          GENERIC_LOW,
          rule({
            id: 'code-low',
            matchType: 'auto_low',
            workloadClass: 'code',
            target: 'tier:premium',
          }),
        ],
      }),
    );
    expect(scoped.sameDestination).toBe(false);
  });
});
