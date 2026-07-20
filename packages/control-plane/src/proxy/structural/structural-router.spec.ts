import { userPrincipal } from '@polyrouter/shared/server';
import {
  DEFAULT_STRUCTURAL_WEIGHTS,
  type NormalizedRequest,
  type RouteRule,
  type RoutingSnapshot,
} from '@polyrouter/data-plane';
import type { RoutingConfig } from '../routing.config';
import type { StructuralBaselineStore } from './structural-baseline.store';
import { StructuralRouter } from './structural-router';

const PRINCIPAL = userPrincipal('u1');

function cfg(over?: Partial<RoutingConfig>): RoutingConfig {
  return {
    autoLayers: new Set(['structural']),
    structural: {
      high: 0.6,
      low: 0.25,
      baselineAlpha: 0.2,
      weights: DEFAULT_STRUCTURAL_WEIGHTS,
      reasoningAdjust: 0.1,
    },
    cascade: { enabled: false, qualityThreshold: 0.5, cheapTimeoutMs: 30_000 },
    ...over,
  };
}

function store(over?: Partial<StructuralBaselineStore>): StructuralBaselineStore {
  return {
    read: () => null,
    observe: () => undefined,
    ...over,
  } as unknown as StructuralBaselineStore;
}

function rule(
  id: string,
  matchType: string,
  target: string,
  priority = 0,
  createdAt = new Date(0),
): RouteRule {
  return { id, matchType, headerName: '', headerValue: null, target, priority, createdAt };
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

function ir(text: string, tools = 0, hasSchema = false): NormalizedRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    tools: Array.from({ length: tools }, (_, i) => ({
      name: `t${i}`,
      parameters: hasSchema ? { type: 'object' } : {},
    })),
    params: {},
  };
}

const complex = ir('Z'.repeat(9_000) + '\n```\n' + 'x'.repeat(5_000) + '\n```', 8, true); // → high
const trivial = ir('hi'); // → low
const middling = ir('Z'.repeat(9_000), 1, true); // size .3 + schema .1 + tools ~.025 → ambiguous

describe('StructuralRouter.decide', () => {
  it('routes a complex auto request to auto_high with the tier chain (decision_layer structural)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const d = await r.decide(
      PRINCIPAL,
      'a1',
      complex,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(d).not.toBeNull();
    expect(d!.decisionLayer).toBe('structural');
    expect(d!.tierKey).toBe('premium');
    expect(d!.chain).toHaveLength(1);
    expect(d!.chain[0]!.modelId).toBe('m-prem');
    expect(d!.routingReason).toContain('structural:high');
  });

  it('routes a trivial auto request to auto_low', async () => {
    const r = new StructuralRouter(cfg(), store());
    const d = await r.decide(
      PRINCIPAL,
      'a1',
      trivial,
      snapshot([rule('r', 'auto_low', 'tier:cheap')]),
    );
    expect(d!.tierKey).toBe('cheap');
    expect(d!.decisionLayer).toBe('structural');
  });

  it('resolves a model: target to a single-member chain (no fallback)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const d = await r.decide(
      PRINCIPAL,
      'a1',
      complex,
      snapshot([rule('r', 'auto_high', 'model:m-prem')]),
    );
    expect(d!.chain).toHaveLength(1);
    expect(d!.tierKey).toBeNull();
    expect(d!.modelId).toBe('m-prem');
  });

  it('returns null for an ambiguous band', async () => {
    const r = new StructuralRouter(cfg(), store());
    expect(
      await r.decide(PRINCIPAL, 'a1', middling, snapshot([rule('r', 'auto_high', 'tier:premium')])),
    ).toBeNull();
  });

  it('returns null when no band rule is configured', async () => {
    const r = new StructuralRouter(cfg(), store());
    expect(await r.decide(PRINCIPAL, 'a1', complex, snapshot([]))).toBeNull();
  });

  it('returns null when the band target is unresolvable', async () => {
    const r = new StructuralRouter(cfg(), store());
    expect(
      await r.decide(PRINCIPAL, 'a1', complex, snapshot([rule('r', 'auto_high', 'tier:ghost')])),
    ).toBeNull();
  });

  it('selects a band rule deterministically regardless of snapshot order', async () => {
    const r = new StructuralRouter(cfg(), store());
    // Same priority; the older rule (createdAt 0) wins → premium, in either input order.
    const older = rule('r-old', 'auto_high', 'tier:premium', 0, new Date(0));
    const newer = rule('r-new', 'auto_high', 'tier:cheap', 0, new Date(1_000));
    const a = await r.decide(PRINCIPAL, 'a1', complex, snapshot([newer, older]));
    const b = await r.decide(PRINCIPAL, 'a1', complex, snapshot([older, newer]));
    expect(a!.tierKey).toBe('premium');
    expect(b!.tierKey).toBe('premium');
  });

  it('still yields a decision when the baseline store throws (raw features)', async () => {
    const throwing = store({
      read: () => {
        throw new Error('redis down');
      },
    });
    const r = new StructuralRouter(cfg(), throwing);
    const d = await r.decide(
      PRINCIPAL,
      'a1',
      complex,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(d!.decisionLayer).toBe('structural');
  });

  it('returns null when the structural layer is disabled', async () => {
    const r = new StructuralRouter(cfg({ autoLayers: new Set() }), store());
    expect(r.enabled).toBe(false);
    expect(
      await r.decide(PRINCIPAL, 'a1', complex, snapshot([rule('r', 'auto_high', 'tier:premium')])),
    ).toBeNull();
  });

  it('never leaks raw prompt text into the routing reason (invariant 8)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const sentinel = 'SUPER_SECRET_SENTINEL_STRING';
    const withSecret = ir(
      'Z'.repeat(9_000) + sentinel + '\n```\n' + 'x'.repeat(5_000) + '\n```',
      8,
      true,
    );
    const d = await r.decide(
      PRINCIPAL,
      'a1',
      withSecret,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(d!.routingReason).not.toContain(sentinel);
  });
});

describe('decision telemetry: the evaluation union (add-auto-decision-telemetry)', () => {
  it('route / ambiguous / unroutable all carry the FULL verdict; skip carries none', async () => {
    const r = new StructuralRouter(cfg(), store());
    const routed = await r.evaluate(
      PRINCIPAL,
      'a1',
      complex,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(routed.kind).toBe('route');
    if (routed.kind === 'route') {
      expect(routed.verdict.band).toBe('high');
      expect(routed.verdict.declared).toBe(false);
      expect(routed.verdict.reason).toContain('structural:high');
    }

    const amb = await r.evaluate(PRINCIPAL, 'a1', middling, snapshot([]));
    expect(amb.kind).toBe('ambiguous');
    if (amb.kind === 'ambiguous') expect(amb.verdict.band).toBe('ambiguous');

    // Confident HIGH with no auto_high target — classified, then unroutable.
    const unroutableHigh = await r.evaluate(
      PRINCIPAL,
      'a1',
      complex,
      snapshot([rule('r', 'auto_low', 'tier:cheap')]),
    );
    expect(unroutableHigh.kind).toBe('unroutable');
    if (unroutableHigh.kind === 'unroutable') expect(unroutableHigh.verdict.band).toBe('high');

    // Confident LOW with no auto_low target.
    const unroutableLow = await r.evaluate(
      PRINCIPAL,
      'a1',
      trivial,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(unroutableLow.kind).toBe('unroutable');
    if (unroutableLow.kind === 'unroutable') expect(unroutableLow.verdict.band).toBe('low');

    // Layer off → verdict-free skip (degradation never fabricates telemetry).
    const off = new StructuralRouter(cfg({ autoLayers: new Set() }), store());
    expect((await off.evaluate(PRINCIPAL, 'a1', complex, snapshot([]))).kind).toBe('skip');
  });

  it('a declared-maximal verdict carries declared=true (band-source provenance)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const e = await r.evaluate(
      PRINCIPAL,
      'a1',
      { ...ir('hi'), reasoning: { protocol: 'openai', effort: 'high' } },
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(e.kind).toBe('route');
    if (e.kind === 'route') expect(e.verdict.declared).toBe(true);
  });
});

describe('declared reasoning hints (add-auto-hint-features)', () => {
  const declaredHigh: NormalizedRequest = {
    ...ir('hi'),
    reasoning: { protocol: 'openai', effort: 'high' },
  };
  const scoreOf = (reason: string): number => {
    const m = /score=([0-9.]+)/.exec(reason);
    if (!m) throw new Error(`no score in: ${reason}`);
    return Number(m[1]);
  };

  it('the previously-impossible motivating case: a two-character request with effort high bands HIGH', async () => {
    const r = new StructuralRouter(cfg(), store());
    const d = await r.decide(
      PRINCIPAL,
      'a1',
      declaredHigh,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(d).not.toBeNull();
    expect(d!.tierKey).toBe('premium');
    expect(d!.routingReason).toContain('declared=max');
  });

  it('a declared-maximal band with NO auto_high target falls through to default (null)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const d = await r.decide(
      PRINCIPAL,
      'a1',
      declaredHigh,
      snapshot([rule('r', 'auto_low', 'tier:cheap')]),
    );
    expect(d).toBeNull(); // only the router resolves targets — no target, no override
  });

  it('cascade bypass at the router: declared none on an ambiguous-ambient request routes auto_low, never triggering L3', async () => {
    const r = new StructuralRouter(
      cfg({ cascade: { enabled: true, qualityThreshold: 0.5, cheapTimeoutMs: 30_000 } }),
      store(),
    );
    const ambientAmbiguous: NormalizedRequest = {
      ...ir('Z'.repeat(8_000)), // ambient .30 → ambiguous (the cascade trigger)
      reasoning: { protocol: 'openai', effort: 'none' }, // −R → .20 → low
    };
    const e = await r.evaluate(
      PRINCIPAL,
      'a1',
      ambientAmbiguous,
      snapshot([rule('r', 'auto_low', 'tier:cheap')]),
    );
    expect(e.kind).toBe('route'); // a ROUTE, not 'ambiguous' — the cascade plan is never constructed
    if (e.kind === 'route') expect(e.decision.tierKey).toBe('cheap');
  });

  it('minimal scores strictly below its hintless twin at the router (both low-banded)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const twin = ir('Z'.repeat(4_000)); // ambient .30 × .5 = .15 → low
    const minimal: NormalizedRequest = {
      ...twin,
      reasoning: { protocol: 'openai', effort: 'minimal' },
    };
    const snap = snapshot([rule('r', 'auto_low', 'tier:cheap')]);
    const dTwin = await r.decide(PRINCIPAL, 'a1', twin, snap);
    const dMin = await r.decide(PRINCIPAL, 'a1', minimal, snap);
    expect(dTwin).not.toBeNull();
    expect(dMin).not.toBeNull();
    const twinScore = scoreOf(dTwin!.routingReason);
    expect(twinScore).toBeCloseTo(0.15, 2); // legacy ambient math, untouched
    expect(scoreOf(dMin!.routingReason)).toBeLessThan(twinScore);
    expect(dMin!.routingReason).toContain('think=0.25');
  });
});

describe('StructuralRouter.evaluate (the #14 cascade trigger)', () => {
  it('returns route for a confident band with a target', async () => {
    const r = new StructuralRouter(cfg(), store());
    const e = await r.evaluate(
      PRINCIPAL,
      'a1',
      complex,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(e.kind).toBe('route');
    if (e.kind === 'route') expect(e.decision.tierKey).toBe('premium');
  });

  it('returns ambiguous for a middling request (the cascade trigger)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const e = await r.evaluate(
      PRINCIPAL,
      'a1',
      middling,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(e.kind).toBe('ambiguous');
  });

  it('returns skip when disabled; a confident band with no target is UNROUTABLE, verdict intact (add-auto-decision-telemetry)', async () => {
    expect(
      (
        await new StructuralRouter(cfg({ autoLayers: new Set() }), store()).evaluate(
          PRINCIPAL,
          'a1',
          complex,
          snapshot([rule('r', 'auto_high', 'tier:premium')]),
        )
      ).kind,
    ).toBe('skip');
    // Previously collapsed into 'skip' — the classified verdict now survives.
    const e = await new StructuralRouter(cfg(), store()).evaluate(
      PRINCIPAL,
      'a1',
      complex,
      snapshot([]),
    );
    expect(e.kind).toBe('unroutable');
    if (e.kind === 'unroutable') expect(e.verdict.band).toBe('high');
  });
});
