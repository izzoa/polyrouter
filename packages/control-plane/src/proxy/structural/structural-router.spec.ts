import { userPrincipal } from '@polyrouter/shared/server';
import {
  DEFAULT_STRUCTURAL_WEIGHTS,
  DEFAULT_WORKLOAD_THRESHOLDS,
  workloadRevision,
  type NormalizedRequest,
  type RouteRule,
  type RoutingSnapshot,
  type StructuralFeatures,
  type WorkloadVerdict,
} from '@polyrouter/data-plane';
import type { RoutingConfig } from '../routing.config';
import type { StructuralBaselineStore } from './structural-baseline.store';
import { StructuralRouter, type StructuralClassification } from './structural-router';

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
    workload: {
      thresholds: DEFAULT_WORKLOAD_THRESHOLDS,
      revision: workloadRevision(DEFAULT_WORKLOAD_THRESHOLDS),
    },
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

describe('StructuralRouter.evaluate — workload verdict (add-workload-telemetry 3.2)', () => {
  const REV = workloadRevision(DEFAULT_WORKLOAD_THRESHOLDS);
  const imageIr: NormalizedRequest = {
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'image', data: 'abc', mediaType: 'image/png' }] }],
    params: {},
  };

  it('a confident route carries the workload verdict from the same features', async () => {
    const r = new StructuralRouter(cfg(), store());
    const e = await r.evaluate(
      PRINCIPAL,
      'a1',
      complex,
      snapshot([rule('r', 'auto_high', 'tier:premium')]),
    );
    expect(e.kind).toBe('route');
    if (e.kind !== 'route') return;
    // `complex` is ~9k prose + 5k fenced code → share ≈ 0.36 ≥ 0.30 → code.
    expect(e.workload).toMatchObject({ class: 'code', source: 'structural', revision: REV });
    expect(e.workload!.score).toBeGreaterThanOrEqual(0.3);
  });

  it('an ambiguous evaluation carries it too (none when nothing fires)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const e = await r.evaluate(PRINCIPAL, 'a1', middling, snapshot([]));
    expect(e.kind).toBe('ambiguous');
    if (e.kind !== 'ambiguous') return;
    expect(e.workload).toMatchObject({
      class: 'none',
      score: 0,
      source: 'structural',
      revision: REV,
    });
  });

  it('an unroutable confident band carries it (vision from an image request)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const e = await r.evaluate(PRINCIPAL, 'a1', imageIr, snapshot([])); // tiny → low, no auto_low rule
    expect(e.kind).toBe('unroutable');
    if (e.kind !== 'unroutable') return;
    expect(e.workload).toMatchObject({ class: 'vision', score: 1 });
  });

  it('skip (layer disabled) carries no workload verdict', async () => {
    const r = new StructuralRouter(cfg({ autoLayers: new Set() }), store());
    const e = await r.evaluate(PRINCIPAL, 'a1', complex, snapshot([]));
    expect(e).toEqual({ kind: 'skip' });
  });

  it('a thrown workload classifier leaves the structural evaluation byte-identical', async () => {
    class Faulty extends StructuralRouter {
      protected override workloadOf(_f: StructuralFeatures): WorkloadVerdict {
        throw new Error('boom');
      }
    }
    const snap = snapshot([rule('r', 'auto_high', 'tier:premium')]);
    const healthy = await new StructuralRouter(cfg(), store()).evaluate(
      PRINCIPAL,
      'a1',
      complex,
      snap,
    );
    const faulty = await new Faulty(cfg(), store()).evaluate(PRINCIPAL, 'a1', complex, snap);
    expect(faulty.kind).toBe('route');
    expect('workload' in faulty).toBe(false);
    const { workload: _w, ...healthyRest } = healthy as Extract<typeof healthy, { kind: 'route' }>;
    expect(faulty).toEqual(healthyRest); // decision + verdict untouched
  });

  it('configured thresholds are honored (a 40% window is none at codeShare 0.5)', async () => {
    const forty: NormalizedRequest = {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Z'.repeat(600) + '\n```\n' + 'x'.repeat(392) + '\n```' },
          ],
        },
      ],
      params: {},
    };
    const strict = cfg({
      workload: {
        thresholds: { codeShare: 0.5, codeMinChars: 200 },
        revision: 'structural/v1/c1/test',
      },
    });
    const e = await new StructuralRouter(strict, store()).evaluate(
      PRINCIPAL,
      'a1',
      forty,
      snapshot([]),
    );
    expect(e.kind).not.toBe('skip');
    expect((e as { workload?: WorkloadVerdict }).workload).toMatchObject({
      class: 'none',
      revision: 'structural/v1/c1/test',
    });
    const lax = await new StructuralRouter(cfg(), store()).evaluate(
      PRINCIPAL,
      'a1',
      forty,
      snapshot([]),
    );
    expect((lax as { workload?: WorkloadVerdict }).workload?.class).toBe('code');
  });
});

describe('StructuralRouter.classify / resolveBand split (add-workload-routing 2.2)', () => {
  it('classify returns both verdicts without consulting any rule (no snapshot involved)', async () => {
    const r = new StructuralRouter(cfg(), store());
    const c = await r.classify(PRINCIPAL, 'a1', complex);
    expect(c.kind).toBe('classified');
    if (c.kind !== 'classified') return;
    expect(c.verdict.band).toBe('high');
    expect(c.workload).toMatchObject({ class: 'code', source: 'structural' });
  });

  it('resolveBand over a classification reproduces evaluate: route / ambiguous / unroutable', async () => {
    const r = new StructuralRouter(cfg(), store());
    const withHigh = snapshot([rule('r', 'auto_high', 'tier:premium')]);
    for (const [ir, snap] of [
      [complex, withHigh],
      [middling, withHigh],
      [complex, snapshot([])],
    ] as const) {
      const c = await r.classify(PRINCIPAL, 'a1', ir);
      const split = r.resolveBand(snap, c);
      const whole = await r.evaluate(PRINCIPAL, 'a1', ir, snap);
      expect(split).toEqual(whole);
    }
    expect(r.resolveBand(withHigh, await r.classify(PRINCIPAL, 'a1', complex)).kind).toBe('route');
    expect(r.resolveBand(withHigh, await r.classify(PRINCIPAL, 'a1', middling)).kind).toBe(
      'ambiguous',
    );
    expect(r.resolveBand(snapshot([]), await r.classify(PRINCIPAL, 'a1', complex)).kind).toBe(
      'unroutable',
    );
  });

  it('skip classifications stay skip; a disabled layer classifies skip', async () => {
    const r = new StructuralRouter(cfg({ autoLayers: new Set() }), store());
    const c = await r.classify(PRINCIPAL, 'a1', complex);
    expect(c).toEqual({ kind: 'skip' });
    expect(r.resolveBand(snapshot([]), c)).toEqual({ kind: 'skip' });
  });

  it("resolveBand is non-throwing: an injected target-lookup fault returns skip (today's degrade)", async () => {
    class Faulty extends StructuralRouter {
      protected override bandTargetOf(): never {
        throw new Error('lookup boom');
      }
    }
    const r = new Faulty(cfg(), store());
    const c = await r.classify(PRINCIPAL, 'a1', complex);
    expect(c.kind).toBe('classified');
    expect(r.resolveBand(snapshot([rule('r', 'auto_high', 'tier:premium')]), c)).toEqual({
      kind: 'skip',
    });
    // An ambiguous classification never touches the lookup and is unaffected.
    const amb = await r.classify(PRINCIPAL, 'a1', middling);
    expect(r.resolveBand(snapshot([]), amb).kind).toBe('ambiguous');
    const typed: StructuralClassification = c;
    expect(typed.kind).toBe('classified');
  });
});
