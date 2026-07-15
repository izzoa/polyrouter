import {
  DEFAULT_STRUCTURAL_WEIGHTS,
  type NormalizedResponse,
  type RouteRule,
  type RoutingSnapshot,
} from '@polyrouter/data-plane';
import type { RoutingConfig } from '../routing.config';
import { CascadeRouter } from './cascade-router';

function cfg(over?: Partial<RoutingConfig['cascade']>): RoutingConfig {
  return {
    autoLayers: new Set(['structural', 'cascade']),
    structural: { high: 0.6, low: 0.25, baselineAlpha: 0.2, weights: DEFAULT_STRUCTURAL_WEIGHTS },
    cascade: { enabled: true, qualityThreshold: 0.5, cheapTimeoutMs: 30_000, ...over },
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
    expect(r.shouldEscalate(resp([{ type: 'text', text: 'a real answer' }]))).toEqual({
      score: 1,
      escalate: false,
    });
    expect(r.shouldEscalate(resp([]))).toEqual({ score: 0, escalate: true }); // empty
    expect(r.shouldEscalate(resp([{ type: 'text', text: 'x' }], 'error'))).toEqual({
      score: 0,
      escalate: true,
    });
  });
});
