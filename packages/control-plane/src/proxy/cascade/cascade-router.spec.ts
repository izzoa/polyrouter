import {
  DEFAULT_STRUCTURAL_WEIGHTS,
  type NormalizedResponse,
  type RouteRule,
  type RoutingSnapshot,
  DEFAULT_WORKLOAD_THRESHOLDS,
  workloadRevision,
} from '@polyrouter/data-plane';
import type { RoutingConfig } from '../routing.config';
import { CascadeRouter } from './cascade-router';

function cfg(over?: Partial<RoutingConfig['cascade']>): RoutingConfig {
  return {
    autoLayers: new Set(['structural', 'cascade']),
    structural: {
      high: 0.6,
      low: 0.25,
      baselineAlpha: 0.2,
      weights: DEFAULT_STRUCTURAL_WEIGHTS,
      reasoningAdjust: 0.1,
    },
    cascade: { enabled: true, qualityThreshold: 0.5, cheapTimeoutMs: 30_000, ...over },
    workload: {
      thresholds: DEFAULT_WORKLOAD_THRESHOLDS,
      revision: workloadRevision(DEFAULT_WORKLOAD_THRESHOLDS),
    },
  };
}

function rule(id: string, matchType: string, target: string): RouteRule {
  return {
    id,
    matchType,
    headerName: '',
    headerValue: null,
    target,
    priority: 0,
    createdAt: new Date(0),
  };
}

function snapshot(rules: RouteRule[]): RoutingSnapshot {
  return {
    tiers: [
      { id: 't-prem', key: 'premium' },
      { id: 't-cheap', key: 'cheap' },
    ],
    entriesByTierId: new Map([
      ['t-prem', [{ modelId: 'm-prem', position: 0 }]],
      ['t-cheap', [{ modelId: 'm-cheap', position: 0 }]],
    ]),
    rules,
    models: [
      { id: 'm-prem', providerId: 'p1', externalModelId: 'gpt-4o' },
      { id: 'm-cheap', providerId: 'p1', externalModelId: 'gpt-4o-mini' },
    ],
  };
}

function resp(
  content: NormalizedResponse['content'],
  stopReason: NormalizedResponse['stopReason'] = 'stop',
): NormalizedResponse {
  return { id: 'r', model: 'm', content, stopReason };
}

describe('CascadeRouter', () => {
  it('reflects the enabled config', () => {
    expect(new CascadeRouter(cfg()).enabled).toBe(true);
    expect(new CascadeRouter(cfg({ enabled: false })).enabled).toBe(false);
  });

  it('plans cheap + strong from auto_low / auto_high', () => {
    const r = new CascadeRouter(cfg());
    const plan = r.plan(
      snapshot([rule('a', 'auto_low', 'tier:cheap'), rule('b', 'auto_high', 'tier:premium')]),
    );
    expect(plan).not.toBeNull();
    expect(plan!.cheap.tierKey).toBe('cheap');
    expect(plan!.strong.tierKey).toBe('premium');
  });

  it('returns null when either band target is missing', () => {
    const r = new CascadeRouter(cfg());
    expect(r.plan(snapshot([rule('b', 'auto_high', 'tier:premium')]))).toBeNull(); // no cheap
    expect(r.plan(snapshot([rule('a', 'auto_low', 'tier:cheap')]))).toBeNull(); // no strong
  });

  it('escalates a low-quality answer and passes a good one', () => {
    const r = new CascadeRouter(cfg());
    expect(r.shouldEscalate(resp([{ type: 'text', text: 'a real answer' }]), false)).toEqual({
      score: 1,
      escalate: false,
    });
    expect(r.shouldEscalate(resp([]), false)).toEqual({ score: 0, escalate: true }); // empty
    expect(r.shouldEscalate(resp([{ type: 'text', text: 'x' }], 'error'), false)).toEqual({
      score: 0,
      escalate: true,
    });
  });

  it('structured demand escalates prose; truncation is inert at the default threshold, live above it (harden-cascade-quality-gate)', () => {
    const r = new CascadeRouter(cfg());
    expect(r.shouldEscalate(resp([{ type: 'text', text: 'Hello from stub' }]), true)).toEqual({
      score: 0,
      escalate: true,
    });
    expect(r.shouldEscalate(resp([{ type: 'text', text: '{"a":1}' }]), true)).toEqual({
      score: 1,
      escalate: false,
    });
    // 0.5 at the default 0.5 threshold: the DECISION is unchanged (strictly below).
    expect(r.shouldEscalate(resp([{ type: 'text', text: 'x' }], 'length'), false)).toEqual({
      score: 0.5,
      escalate: false,
    });
    // A threshold above 0.5 opts into escalating truncation.
    const strict = new CascadeRouter(cfg({ qualityThreshold: 0.6 }));
    expect(strict.shouldEscalate(resp([{ type: 'text', text: 'x' }], 'length'), false)).toEqual({
      score: 0.5,
      escalate: true,
    });
  });

  it('fails open when the evaluator throws (deliver cheap, score null)', () => {
    const r = new CascadeRouter(cfg());
    // Non-iterable content makes evaluateQuality throw naturally — no mocking.
    const broken = { ...resp([]), content: null } as unknown as Parameters<
      CascadeRouter['shouldEscalate']
    >[0];
    expect(r.shouldEscalate(broken, true)).toEqual({ score: null, escalate: false });
  });
});

describe('CascadeRouter.plan — class scope + per-leg provenance (add-workload-scoped-bands)', () => {
  const scoped = (id: string, matchType: string, target: string, cls: string): RouteRule => ({
    ...rule(id, matchType, target),
    workloadClass: cls,
  });
  const withCodeTiers = (rules: RouteRule[]): RoutingSnapshot => {
    const base = snapshot(rules);
    return {
      ...base,
      tiers: [
        ...base.tiers,
        { id: 't-cc', key: 'cheap-code' },
        { id: 't-sc', key: 'strong-code' },
        { id: 't-empty', key: 'empty' },
      ],
      entriesByTierId: new Map([
        ...base.entriesByTierId,
        ['t-cc', [{ modelId: 'm-cheap', position: 0 }]],
        ['t-sc', [{ modelId: 'm-prem', position: 0 }]],
        ['t-empty', []],
      ]),
    };
  };
  const generic = [rule('a', 'auto_low', 'tier:cheap'), rule('b', 'auto_high', 'tier:premium')];

  it('without a scope the plan is byte-identical to today and carries scope null / unscoped provenance', () => {
    const r = new CascadeRouter(cfg());
    const plan = r.plan(
      withCodeTiers([...generic, scoped('c', 'auto_low', 'tier:cheap-code', 'code')]),
    );
    expect(plan).toMatchObject({ scope: null, cheapScoped: false, strongScoped: false });
    expect(plan!.cheap.tierKey).toBe('cheap');
    expect(plan!.strong.tierKey).toBe('premium');
    expect(plan!.cheap.routingReason).toBe('cascade cheap tier');
  });

  it('cascade within a class: both scoped legs, with reasons suffixed and provenance true', () => {
    const r = new CascadeRouter(cfg());
    const plan = r.plan(
      withCodeTiers([
        ...generic,
        scoped('c', 'auto_low', 'tier:cheap-code', 'code'),
        scoped('d', 'auto_high', 'tier:strong-code', 'code'),
      ]),
      'code',
    );
    expect(plan).toMatchObject({ scope: 'code', cheapScoped: true, strongScoped: true });
    expect(plan!.cheap.tierKey).toBe('cheap-code');
    expect(plan!.strong.tierKey).toBe('strong-code');
    expect(plan!.cheap).toMatchObject({ routingReason: 'cascade cheap tier', scope: 'code' });
    expect(plan!.strong).toMatchObject({ routingReason: 'cascade strong tier', scope: 'code' });
  });

  it('each band falls back to the generic rule independently — the hybrids carry honest provenance', () => {
    const r = new CascadeRouter(cfg());
    const cheapOnly = r.plan(
      withCodeTiers([...generic, scoped('c', 'auto_low', 'tier:cheap-code', 'code')]),
      'code',
    );
    expect(cheapOnly).toMatchObject({ scope: 'code', cheapScoped: true, strongScoped: false });
    expect(cheapOnly!.cheap.tierKey).toBe('cheap-code');
    expect(cheapOnly!.strong.tierKey).toBe('premium');
    const strongOnly = r.plan(
      withCodeTiers([...generic, scoped('d', 'auto_high', 'tier:strong-code', 'code')]),
      'code',
    );
    expect(strongOnly).toMatchObject({ scope: 'code', cheapScoped: false, strongScoped: true });
    expect(strongOnly!.cheap.tierKey).toBe('cheap');
    expect(strongOnly!.strong.tierKey).toBe('strong-code');
    // another class → generic pair, no provenance
    expect(
      r.plan(
        withCodeTiers([...generic, scoped('c', 'auto_low', 'tier:cheap-code', 'code')]),
        'vision',
      ),
    ).toMatchObject({ scope: 'vision', cheapScoped: false, strongScoped: false });
  });

  it('a scoped cheap rule with an empty target leaves the class without a plan (no silent substitution)', () => {
    const r = new CascadeRouter(cfg());
    expect(
      r.plan(withCodeTiers([...generic, scoped('c', 'auto_low', 'tier:empty', 'code')]), 'code'),
    ).toBeNull();
    expect(
      r.plan(withCodeTiers([...generic, scoped('c', 'auto_low', 'tier:empty', 'code')]), 'vision'),
    ).not.toBeNull();
  });
});
