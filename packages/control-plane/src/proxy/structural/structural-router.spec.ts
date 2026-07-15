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
    structural: { high: 0.6, low: 0.25, baselineAlpha: 0.2, weights: DEFAULT_STRUCTURAL_WEIGHTS },
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

  it('returns skip when disabled, and when a confident band has no target', async () => {
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
    expect(
      (await new StructuralRouter(cfg(), store()).evaluate(PRINCIPAL, 'a1', complex, snapshot([])))
        .kind,
    ).toBe('skip');
  });
});
