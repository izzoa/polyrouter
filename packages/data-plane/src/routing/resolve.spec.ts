import {
  resolveRoute,
  isRouteError,
  type RouteModel,
  type RouteRule,
  type RouteEntry,
  type RoutingSnapshot,
} from './resolve';

const model = (id: string, providerId: string, externalModelId: string): RouteModel => ({
  id,
  providerId,
  externalModelId,
});

const rule = (over: Partial<RouteRule>): RouteRule => ({
  id: over.id ?? 'r1',
  matchType: over.matchType ?? 'header',
  headerName: over.headerName ?? 'x-polyrouter-tier',
  headerValue: over.headerValue ?? null,
  target: over.target ?? 'tier:default',
  priority: over.priority ?? 0,
  createdAt: over.createdAt ?? new Date('2026-01-01T00:00:00Z'),
});

function snap(over: Partial<RoutingSnapshot> = {}): RoutingSnapshot {
  const entries = new Map<string, RouteEntry[]>([
    ['t_default', [{ modelId: 'm_def', position: 0 }]],
    ['t_fast', [{ modelId: 'm_fast', position: 0 }]],
  ]);
  return {
    tiers: [
      { id: 't_default', key: 'default' },
      { id: 't_fast', key: 'fast' },
    ],
    entriesByTierId: over.entriesByTierId ?? entries,
    rules: over.rules ?? [],
    models: over.models ?? [model('m_def', 'p1', 'gpt-4o-mini'), model('m_fast', 'p1', 'gpt-4o')],
    ...(over.tiers ? { tiers: over.tiers } : {}),
  };
}

const parse = (modelField: string, headers: Record<string, string> = {}) => ({
  modelField,
  headers,
});

describe('resolveRoute — phase 1 (model field)', () => {
  it('routes a bare unambiguous model explicitly', () => {
    const r = resolveRoute(snap(), parse('gpt-4o'));
    expect(r).toMatchObject({ modelId: 'm_fast', decisionLayer: 'explicit' });
  });

  it('routes a provider-qualified model', () => {
    const r = resolveRoute(snap(), parse('p1:gpt-4o'));
    expect(r).toMatchObject({ modelId: 'm_fast', externalModelId: 'gpt-4o' });
  });

  it('routes a tier key in the model field', () => {
    const r = resolveRoute(snap(), parse('fast'));
    expect(r).toMatchObject({ modelId: 'm_fast', decisionLayer: 'explicit' });
  });

  it('errors ambiguous_model when a bare id is on two providers', () => {
    const s = snap({
      models: [model('m1', 'p1', 'gpt-4o'), model('m2', 'p2', 'gpt-4o'), model('m_def', 'p1', 'x')],
    });
    expect(resolveRoute(s, parse('gpt-4o'))).toEqual({
      error: 'ambiguous_model',
      detail: 'gpt-4o',
    });
    // ...but the provider-qualified form disambiguates.
    expect(resolveRoute(s, parse('p2:gpt-4o'))).toMatchObject({ modelId: 'm2' });
  });

  it('errors unknown_model for a non-empty unrecognized value (never silent default)', () => {
    expect(resolveRoute(snap(), parse('typo-model'))).toEqual({
      error: 'unknown_model',
      detail: 'typo-model',
    });
  });

  it('resolves a name that is both a model id and a tier key to the model', () => {
    const s = snap({
      tiers: [
        { id: 't_default', key: 'default' },
        { id: 't_clash', key: 'clash' },
      ],
      models: [model('m_def', 'p1', 'x'), model('m_clash', 'p1', 'clash')],
      entriesByTierId: new Map([
        ['t_default', [{ modelId: 'm_def', position: 0 }]],
        ['t_clash', [{ modelId: 'm_def', position: 0 }]],
      ]),
    });
    expect(resolveRoute(s, parse('clash'))).toMatchObject({ modelId: 'm_clash' });
  });
});

describe('resolveRoute — auto / header / default cascade', () => {
  it('auto alone resolves to the default tier', () => {
    const r = resolveRoute(snap(), parse('auto'));
    expect(r).toMatchObject({ modelId: 'm_def', decisionLayer: 'default' });
  });

  it('auto still honors an x-polyrouter-tier header', () => {
    const r = resolveRoute(snap(), parse('auto', { 'x-polyrouter-tier': 'fast' }));
    expect(r).toMatchObject({ modelId: 'm_fast', decisionLayer: 'header' });
  });

  it('empty model falls through to default', () => {
    expect(resolveRoute(snap(), parse(''))).toMatchObject({ modelId: 'm_def' });
  });

  it('a custom header rule matches by header name/value', () => {
    const s = snap({
      rules: [rule({ headerName: 'x-tenant', headerValue: 'vip', target: 'tier:fast' })],
    });
    const r = resolveRoute(s, parse('auto', { 'x-tenant': 'vip' }));
    expect(r).toMatchObject({ modelId: 'm_fast', decisionLayer: 'header' });
  });

  it('a header rule can target a model directly', () => {
    const s = snap({
      rules: [rule({ headerName: 'x-tenant', headerValue: 'vip', target: 'model:m_fast' })],
    });
    expect(resolveRoute(s, parse('auto', { 'x-tenant': 'vip' }))).toMatchObject({
      modelId: 'm_fast',
    });
  });

  it('the built-in header beats a default rule', () => {
    const s = snap({ rules: [rule({ id: 'd', matchType: 'default', target: 'tier:fast' })] });
    // default rule would pick fast; the built-in header forces default tier.
    const r = resolveRoute(s, parse('auto', { 'x-polyrouter-tier': 'default' }));
    expect(r).toMatchObject({ modelId: 'm_def', decisionLayer: 'header' });
  });

  it('applies rule order (priority desc, created asc, id asc) over shuffled input', () => {
    const s = snap({
      rules: [
        rule({ id: 'b', headerName: 'x', headerValue: 'v', target: 'tier:default', priority: 1 }),
        rule({ id: 'a', headerName: 'x', headerValue: 'v', target: 'tier:fast', priority: 5 }),
      ],
    });
    // highest priority (a → fast) wins regardless of array order.
    expect(resolveRoute(s, parse('', { x: 'v' }))).toMatchObject({ modelId: 'm_fast' });
  });

  it('selects position 0 as primary regardless of entry array order', () => {
    const s = snap({
      entriesByTierId: new Map([
        [
          't_default',
          [
            { modelId: 'm_fast', position: 2 },
            { modelId: 'm_def', position: 0 },
          ],
        ],
      ]),
    });
    expect(resolveRoute(s, parse('auto'))).toMatchObject({ modelId: 'm_def' });
  });
});

describe('resolveRoute — tierKey (tier_assigned producer)', () => {
  it('is the tier key for tier paths and null for a direct model', () => {
    expect(resolveRoute(snap(), parse('gpt-4o'))).toMatchObject({ tierKey: null }); // explicit model
    expect(resolveRoute(snap(), parse('fast'))).toMatchObject({ tierKey: 'fast' }); // tier key
    expect(resolveRoute(snap(), parse('auto'))).toMatchObject({ tierKey: 'default' }); // auto → default
    expect(resolveRoute(snap(), parse('auto', { 'x-polyrouter-tier': 'fast' }))).toMatchObject({
      tierKey: 'fast',
    }); // header
    const modelRule = snap({
      rules: [rule({ headerName: 'x', headerValue: 'v', target: 'model:m_fast' })],
    });
    expect(resolveRoute(modelRule, parse('auto', { x: 'v' }))).toMatchObject({ tierKey: null }); // model-target rule
  });
});

describe('resolveRoute — typed errors', () => {
  it('empty_tier when the resolved tier has no entries', () => {
    const s = snap({ entriesByTierId: new Map() });
    expect(resolveRoute(s, parse('auto'))).toEqual({ error: 'empty_tier', detail: 'default' });
  });

  it('empty_tier when position 0 is gone (no silent promotion of a fallback)', () => {
    const s = snap({
      entriesByTierId: new Map([['t_default', [{ modelId: 'm_fast', position: 1 }]]]),
    });
    expect(resolveRoute(s, parse('auto'))).toEqual({ error: 'empty_tier', detail: 'default' });
  });

  it('unresolved_target when a rule points at a missing tier', () => {
    const s = snap({ rules: [rule({ id: 'd', matchType: 'default', target: 'tier:ghost' })] });
    expect(resolveRoute(s, parse('auto', {}))).toMatchObject({ error: 'unresolved_target' });
  });

  it('no_default when there is no default tier', () => {
    const s = snap({ tiers: [{ id: 't_fast', key: 'fast' }] });
    expect(resolveRoute(s, parse(''))).toEqual({ error: 'no_default' });
  });

  it('isRouteError narrows the union', () => {
    const r = resolveRoute(snap(), parse('nope'));
    expect(isRouteError(r)).toBe(true);
  });
});
