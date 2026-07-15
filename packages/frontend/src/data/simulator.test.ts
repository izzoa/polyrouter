import { describe, expect, it } from 'vitest';
import type { RoutedRequest } from '../types';
import { CATALOG, fmtCost } from './catalog';
import { generateRequest, mintKey, seedRequests } from './simulator';

// Large enough that missing any scenario branch (min probability 8%) has
// probability < 1e-14 — deterministic in practice without seeding the RNG.
const sample = Array.from({ length: 400 }, () => generateRequest(Date.now()));

// The six decision scenarios ported from the prototype, keyed by their reason strings.
const SCENARIO_REASONS = [
  'auto → L1 low complexity → default',
  'explicit model id',
  'x-polyrouter-tier: background',
  'auto → L1 → default (fallback #2)',
  'auto → L3 cascade escalation',
  'L1 → default; primary 429 → fallback #2',
];

describe('request simulator (dashboard-prototype)', () => {
  it('generates catalog-valid requests carrying their own price snapshot', () => {
    for (const r of sample) {
      const c = CATALOG[r.model];
      expect(c).toBeDefined();
      if (!c) continue;
      expect(r.provider).toBe(c.p);
      // cost must derive from the request's snapshotted unit prices…
      expect(r.inPrice).toBe(c.inP);
      expect(r.outPrice).toBe(c.outP);
      expect(r.cost).toBeCloseTo((r.tin / 1e6) * r.inPrice + (r.tout / 1e6) * r.outPrice, 10);
      expect(['explicit', 'header', 'structural', 'escalated']).toContain(r.layer);
      expect(r.steps.length).toBeGreaterThan(0);
      expect(r.ttfb).toBeLessThanOrEqual(r.ms);
    }
  });

  it('produces all six prototype scenarios', () => {
    const reasons = new Set(sample.map((r) => r.reason));
    for (const reason of SCENARIO_REASONS) {
      expect(reasons).toContain(reason);
    }
  });

  it('keeps each scenario branch coherent', () => {
    for (const r of sample) {
      if (r.escalated) {
        expect(r.layer).toBe('escalated');
        expect(r.tier).toBe('heavy');
        expect(r.steps.some((s) => s.title.includes('Cascade'))).toBe(true);
      }
      if (r.status === 'fallback') {
        expect(r.steps.some((s) => s.s === 'err')).toBe(true);
      }
      if (r.layer === 'explicit') {
        expect(r.routeMs).toBe(0);
        expect(r.feat).toBeNull();
      }
      if (r.layer === 'header') {
        expect(r.routeMs).toBe(0);
        expect(r.feat).toBeNull();
        expect(r.tier).toBe('background');
      }
      if (r.layer === 'structural' || r.layer === 'escalated') {
        expect(r.feat).not.toBeNull();
      }
    }
  });

  it('renders costs from request fields alone — models outside the catalog cannot crash rows', () => {
    const base = sample[0];
    expect(base).toBeDefined();
    if (!base) return;
    const custom: RoutedRequest = {
      ...base,
      model: 'my-custom-model',
      provider: 'mylab-endpoint',
      tag: null,
      inPrice: 1,
      outPrice: 2,
      cost: 0.1234,
    };
    expect(fmtCost(custom)).toBe('$0.1234');
    expect(fmtCost({ ...custom, tag: 'local' })).toBe('free');
    expect(fmtCost({ ...custom, tag: 'sub' })).toBe('$0.00');
  });

  it('seeds requests strictly back in time with unique ids', () => {
    const reqs = seedRequests(26);
    expect(reqs).toHaveLength(26);
    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1];
      const cur = reqs[i];
      expect(prev && cur && cur.ts < prev.ts).toBe(true);
    }
    expect(new Set(reqs.map((r) => r.id)).size).toBe(26);
  });

  it('mints poly_-prefixed keys of the prototype shape', () => {
    const k = mintKey();
    expect(k).toMatch(/^poly_[a-zA-Z0-9]{32}$/);
    // the random suffix uses an ambiguity-free alphabet (the poly_ prefix itself has o/l)
    expect(k.slice(5)).not.toMatch(/[01lIoO]/);
  });
});
