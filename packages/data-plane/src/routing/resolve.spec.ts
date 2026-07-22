import {
  resolveRoute,
  resolveBandTarget,
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

describe('resolveRoute — chain (#12 fallback order)', () => {
  it('a tier resolves to all entries in position order (primary first)', () => {
    const s = snap({
      entriesByTierId: new Map([
        [
          't_default',
          [
            { modelId: 'm_fast', position: 1 },
            { modelId: 'm_def', position: 0 },
          ],
        ],
      ]),
    });
    const r = resolveRoute(s, parse('auto'));
    if (isRouteError(r)) throw new Error('unexpected error');
    expect(r.chain.map((c) => c.modelId)).toEqual(['m_def', 'm_fast']); // position order
    expect(r.chain[0]!.modelId).toBe(r.modelId); // chain[0] is the primary
  });

  it('an explicit model has a single-element chain', () => {
    const r = resolveRoute(snap(), parse('gpt-4o'));
    if (isRouteError(r)) throw new Error('unexpected error');
    expect(r.chain).toHaveLength(1);
    expect(r.chain[0]!.externalModelId).toBe('gpt-4o');
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

describe('resolveRoute — tier-header precedence (add-tier-header-precedence)', () => {
  it('a resolving x-polyrouter-tier beats a HIGHER-priority rule on another header (direct lookup)', () => {
    const s = snap({
      rules: [rule({ headerName: 'x-env', headerValue: 'prod', target: 'tier:fast', priority: 999 })],
    });
    const r = resolveRoute(s, parse('auto', { 'x-env': 'prod', 'x-polyrouter-tier': 'default' }));
    expect(r).toMatchObject({
      tierKey: 'default', // the tier header won, not the x-env rule
      decisionLayer: 'header',
      routingReason: 'x-polyrouter-tier: default',
      matchedHeader: { name: 'x-polyrouter-tier', value: 'default' },
    });
  });

  it('a tier-header REMAP also beats a higher-priority other-header rule', () => {
    const s = snap({
      rules: [
        rule({ id: 'a', headerName: 'x-env', headerValue: 'prod', target: 'tier:fast', priority: 999 }),
        rule({ id: 'b', headerValue: 'shopping', target: 'tier:default', priority: 0 }),
      ],
    });
    const r = resolveRoute(s, parse('auto', { 'x-env': 'prod', 'x-polyrouter-tier': 'shopping' }));
    expect(r).toMatchObject({
      tierKey: 'default',
      routingReason: 'header rule x-polyrouter-tier', // unchanged rule-reason shape
      // record-tier-header-value: a tier-header remap records the matched OWNED
      // rule value (the tier-ask category), not name-only.
      matchedHeader: { name: 'x-polyrouter-tier', value: 'shopping' },
    });
  });

  it('a remap still beats the direct lookup when its value collides with a real tier key', () => {
    const s = snap({ rules: [rule({ headerValue: 'fast', target: 'tier:default' })] });
    const r = resolveRoute(s, parse('auto', { 'x-polyrouter-tier': 'fast' }));
    expect(r).toMatchObject({ tierKey: 'default', routingReason: 'header rule x-polyrouter-tier' });
  });

  it('an advisory tier header still lets an other-header rule match, then default', () => {
    const s = snap({
      rules: [rule({ headerName: 'x-env', headerValue: 'prod', target: 'tier:fast' })],
    });
    const withRule = resolveRoute(
      s,
      parse('auto', { 'x-polyrouter-tier': 'no-such-tier', 'x-env': 'prod' }),
    );
    expect(withRule).toMatchObject({
      tierKey: 'fast',
      matchedHeader: { name: 'x-env', value: null },
    });
    expect(JSON.stringify(withRule)).not.toContain('no-such-tier'); // advisory value never captured
    const noRule = resolveRoute(snap(), parse('auto', { 'x-polyrouter-tier': 'no-such-tier' }));
    expect(noRule).toMatchObject({ decisionLayer: 'default', tierKey: 'default' });
  });

  it('a corrupt empty-string tier-header rule no longer matches an empty header (hardening, D4)', () => {
    const s = snap({ rules: [rule({ headerValue: '', target: 'tier:fast' })] });
    const r = resolveRoute(s, parse('auto', { 'x-polyrouter-tier': '' }));
    expect(r).toMatchObject({ tierKey: 'default', decisionLayer: 'default' }); // not tier fast
  });

  // Fail-closed error precedence (clink re-review 2026-07-20): a MATCHED tier
  // header that cannot serve surfaces its error — never a silent reroute via an
  // other-header rule or default.
  it('an empty explicitly-asked tier errors even when an other-header rule matches', () => {
    const s = snap({
      tiers: [
        { id: 't_default', key: 'default' },
        { id: 't_empty', key: 'empty' },
      ],
      entriesByTierId: new Map([['t_default', [{ modelId: 'm_def', position: 0 }]]]),
      rules: [rule({ headerName: 'x-env', headerValue: 'prod', target: 'tier:default', priority: 999 })],
    });
    expect(
      resolveRoute(s, parse('auto', { 'x-polyrouter-tier': 'empty', 'x-env': 'prod' })),
    ).toEqual({ error: 'empty_tier', detail: 'empty' }); // the x-env rule did not rescue it
  });

  it('a matched remap with an unresolved target errors — no direct-lookup or other-rule rescue', () => {
    const s = snap({
      rules: [
        rule({ id: 'remap', headerValue: 'fast', target: 'tier:ghost' }), // target deleted
        rule({ id: 'other', headerName: 'x-env', headerValue: 'prod', target: 'tier:default', priority: 999 }),
      ],
    });
    // 'fast' is ALSO a real tier — the broken remap still owns the match.
    expect(
      resolveRoute(s, parse('auto', { 'x-polyrouter-tier': 'fast', 'x-env': 'prod' })),
    ).toMatchObject({ error: 'unresolved_target' });
  });

  it('two remaps matching the same sent value are ordered by priority', () => {
    const s = snap({
      rules: [
        rule({ id: 'lo', headerValue: 'shopping', target: 'tier:default', priority: 1 }),
        rule({ id: 'hi', headerValue: 'shopping', target: 'tier:fast', priority: 5 }),
      ],
    });
    expect(resolveRoute(s, parse('auto', { 'x-polyrouter-tier': 'shopping' }))).toMatchObject({
      tierKey: 'fast', // priority still totally orders WITHIN the phase
    });
  });
});

describe('resolveRoute — matchedHeader (add-routing-header-visibility)', () => {
  it('the built-in header emits its name + the matched OWNED tier key, reason unchanged', () => {
    const r = resolveRoute(snap(), parse('auto', { 'x-polyrouter-tier': 'fast' }));
    expect(r).toMatchObject({
      decisionLayer: 'header',
      matchedHeader: { name: 'x-polyrouter-tier', value: 'fast' },
      routingReason: 'x-polyrouter-tier: fast', // byte-for-byte as before
    });
  });

  it('a custom rule emits its name with a NULL value — the configured value appears nowhere', () => {
    const secret = 'Bearer sk-live-EXTREMELY-SECRET';
    const s = snap({
      rules: [rule({ headerName: 'authorization', headerValue: secret, target: 'tier:fast' })],
    });
    const r = resolveRoute(s, parse('auto', { authorization: secret }));
    expect(r).toMatchObject({
      decisionLayer: 'header',
      matchedHeader: { name: 'authorization', value: null },
      routingReason: 'header rule authorization', // unchanged, value-free
    });
    // Fail-closed: the secret is in NO field of the decision.
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('a model-target custom rule also emits name-only', () => {
    const s = snap({
      rules: [rule({ headerName: 'x-tenant', headerValue: 'vip', target: 'model:m_fast' })],
    });
    expect(resolveRoute(s, parse('auto', { 'x-tenant': 'vip' }))).toMatchObject({
      matchedHeader: { name: 'x-tenant', value: null },
    });
  });

  it('is null for explicit, default-rule, default-tier, and auto paths', () => {
    expect(resolveRoute(snap(), parse('gpt-4o'))).toMatchObject({ matchedHeader: null });
    expect(resolveRoute(snap(), parse('fast'))).toMatchObject({ matchedHeader: null }); // explicit tier
    expect(resolveRoute(snap(), parse('auto'))).toMatchObject({ matchedHeader: null });
    expect(resolveRoute(snap(), parse(''))).toMatchObject({ matchedHeader: null });
    const s = snap({ rules: [rule({ id: 'd', matchType: 'default', target: 'tier:fast' })] });
    expect(resolveRoute(s, parse(''))).toMatchObject({ matchedHeader: null }); // default rule
  });

  it('is null on the advisory fall-through — the non-matching client value is never captured', () => {
    const r = resolveRoute(snap(), parse('auto', { 'x-polyrouter-tier': 'no-such-tier' }));
    expect(r).toMatchObject({ decisionLayer: 'default', matchedHeader: null });
    expect(JSON.stringify(r)).not.toContain('no-such-tier');
  });

  it('is null on band-target decisions (structural/cascade reuse)', () => {
    const s = snap({ rules: [rule({ id: 'h', matchType: 'auto_high', target: 'tier:fast' })] });
    const d = resolveBandTarget(s, 'auto_high', 'structural', 'structural:high');
    expect(d).toMatchObject({ matchedHeader: null });
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
