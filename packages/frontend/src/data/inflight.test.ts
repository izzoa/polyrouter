import { describe, expect, it } from 'vitest';
import type { InflightRow, InflightSnapshot } from './api';
import {
  emptyInflight,
  foldInflight,
  inflightDisplay,
  reconcile,
  INFLIGHT_GRACE_MS,
} from './inflight';

const row = (id: string, startedAt = 1000): InflightRow => ({
  id,
  startedAt,
  decisionLayer: 'cascade',
  tierAssigned: 'utility',
  modelLabel: 'minimax/minimax-m3',
  providerLabel: 'Openrouter',
  protocol: 'openai',
  status: 'running',
});
const snap = (items: InflightRow[], over: Partial<InflightSnapshot> = {}): InflightSnapshot => ({
  items,
  available: true,
  truncated: false,
  ...over,
});
const ids = (...xs: string[]): ReadonlySet<string> => new Set(xs);
const displayIds = (s: ReturnType<typeof foldInflight>['next'], recent = ids()): string[] =>
  inflightDisplay(s, recent).map((r) => r.id);

describe('inflight fold/display (add-inflight-requests)', () => {
  it('shows live rows newest-first and never double-shows a durable id', () => {
    const { next } = foldInflight(emptyInflight(), snap([row('a', 1000), row('b', 2000)]), ids(), 5000);
    expect(displayIds(next)).toEqual(['b', 'a']); // newest-first
    expect(displayIds(next, ids('a'))).toEqual(['b']); // 'a' has a durable row → dropped
  });

  it('a degraded (unavailable) poll retains cached rows and never settles', () => {
    const s1 = foldInflight(emptyInflight(), snap([row('a')]), ids(), 1000).next;
    const s2 = foldInflight(s1, snap([], { available: false }), ids(), 2000);
    expect(s2.refresh).toBe(false); // no false settle
    expect(displayIds(s2.next)).toEqual(['a']); // retained
  });

  it('a truncated poll never infers settlement for an absent row', () => {
    const s1 = foldInflight(emptyInflight(), snap([row('a', 1000), row('b', 2000)]), ids(), 1000).next;
    const s2 = foldInflight(s1, snap([row('b', 2000)], { truncated: true }), ids(), 2000);
    expect(s2.refresh).toBe(false); // 'a' absent under a cap is NOT a settle
  });

  it('an authoritative omission is a settle: it bridges the gap and triggers a refresh', () => {
    const s1 = foldInflight(emptyInflight(), snap([row('a', 1000), row('b', 2000)]), ids(), 1000).next;
    const s2 = foldInflight(s1, snap([row('b', 2000)]), ids(), 5000);
    expect(s2.refresh).toBe(true); // settle observed → durable refresh
    expect(displayIds(s2.next)).toEqual(['b', 'a']); // 'a' still visible (bridged)
  });

  it('the bridged row drops the moment its durable row appears (never double-shown)', () => {
    const s1 = foldInflight(emptyInflight(), snap([row('a', 1000), row('b', 2000)]), ids(), 1000).next;
    const s2 = foldInflight(s1, snap([row('b', 2000)]), ids(), 5000).next;
    const s3 = reconcile(s2, ids('a')); // durable 'a' loaded
    expect(displayIds(s3, ids('a'))).toEqual(['b']);
  });

  it('a bridged row is dropped once its grace expires', () => {
    const s1 = foldInflight(emptyInflight(), snap([row('a', 1000), row('b', 2000)]), ids(), 1000).next;
    const s2 = foldInflight(s1, snap([row('b', 2000)]), ids(), 5000).next;
    const past = 5000 + INFLIGHT_GRACE_MS + 1;
    const s3 = foldInflight(s2, snap([row('b', 2000)]), ids(), past).next;
    expect(displayIds(s3)).toEqual(['b']); // 'a' expired out of the bridge
  });
});
