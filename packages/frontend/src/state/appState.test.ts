import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRequest } from '../data/simulator';
import { filterRequests } from '../pages/Requests';
import { createAppStore } from './appState';

describe('app state actions (dashboard-prototype)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reorders a tier chain and recomputes the primary', () => {
    const s = createAppStore();
    const before = [...(s.state.tiers[0]?.chain ?? [])];
    s.reorderChain(0, 2, 0);
    const after = s.state.tiers[0]?.chain ?? [];
    expect(after[0]).toBe(before[2]);
    expect(after).toHaveLength(before.length);
  });

  it('enforces the 5-model cap with a toast', () => {
    const s = createAppStore();
    expect(s.addToChain(0, 'kimi-k2')).toBe(true);
    expect(s.addToChain(0, 'gemini-3-flash')).toBe(true);
    expect(s.state.tiers[0]?.chain).toHaveLength(5);
    expect(s.addToChain(0, 'gpt-5.2')).toBe(false);
    expect(s.state.tiers[0]?.chain).toHaveLength(5);
    expect(s.state.toast).toBe('Max 5 models per tier');
  });

  it('removes models and header rules', () => {
    const s = createAppStore();
    s.removeFromChain(0, 'deepseek-v3.2');
    expect(s.state.tiers[0]?.chain).not.toContain('deepseek-v3.2');
    s.removeRule(1);
    expect(s.state.rules.map((r) => r.id)).not.toContain(1);
  });

  it('toggles L1/L3 but keeps L2 locked as cloud-tier', () => {
    const s = createAppStore();
    s.toggleLayer('structural');
    expect(s.state.autoLayers.structural).toBe(false);
    s.toggleLayer('semantic');
    expect(s.state.autoLayers.semantic).toBe(false);
    expect(s.state.toast).toBe('Layer 2 is a cloud-tier graduation');
  });

  it('creates an agent with a shown-once key and grows the table', () => {
    const s = createAppStore();
    const count = s.state.agents.length;
    s.setState('na', { name: 'test-agent', harness: 'curl' });
    s.createAgent();
    expect(s.state.agents).toHaveLength(count + 1);
    expect(s.state.modal).toBe('keyReveal');
    expect(s.state.kr.key).toMatch(/^poly_/);
    expect(s.state.agents.at(-1)?.prefix).toBe(s.state.kr.key.slice(0, 9));
  });

  it('gates add-provider on a successful test connection', () => {
    const s = createAppStore();
    const count = s.state.providers.length;
    s.pickProviderKind('custom');
    s.addProvider();
    expect(s.state.providers).toHaveLength(count);
    s.setState('np', 'test', 'ok');
    s.addProvider();
    expect(s.state.providers).toHaveLength(count + 1);
  });

  it('invalidates an in-flight connection test when the form changes', () => {
    vi.useFakeTimers();
    const s = createAppStore();
    s.openModal('newProvider');

    // stale timeout must not bless a different kind picked mid-test
    s.pickProviderKind('custom');
    s.testProvider();
    s.pickProviderKind('api');
    vi.advanceTimersByTime(1000);
    expect(s.state.np.test).toBe('idle');

    // an untouched test completes normally
    s.testProvider();
    vi.advanceTimersByTime(900);
    expect(s.state.np.test).toBe('ok');

    // editing the credential/value after a successful test forces a re-test
    s.setNpValue('sk-edited');
    expect(s.state.np.test).toBe('idle');

    // closing the modal invalidates whatever was still pending
    s.testProvider();
    s.closeModal();
    vi.advanceTimersByTime(1000);
    expect(s.state.np.test).toBe('idle');
  });

  it('creates budgets from the modal state', () => {
    const s = createAppStore();
    s.setState('nl', { scope: 'Global', amount: '42.50', window: 'week', action: 'block' });
    s.createLimit();
    const limit = s.state.limits.at(-1);
    expect(limit?.threshold).toBe(42.5);
    expect(limit?.action).toBe('block');
    expect(limit?.note).toContain('hard stop');
  });

  it('live feed prepends requests, caps the list, and updates stats', () => {
    const s = createAppStore();
    const reqsBefore = s.state.stats.reqs;
    for (let i = 0; i < 50; i++) s.pushLiveRequest();
    expect(s.state.requests.length).toBeLessThanOrEqual(40);
    expect(s.state.stats.reqs).toBe(reqsBefore + 50);
  });

  it('filters requests by decision layer and status — non-vacuously', () => {
    // A generated corpus large enough that every filter bucket is populated.
    const corpus = Array.from({ length: 400 }, () => generateRequest(Date.now()));
    const auto = filterRequests(corpus, 'auto');
    const explicit = filterRequests(corpus, 'explicit');
    const fallback = filterRequests(corpus, 'fallback');
    const escalated = filterRequests(corpus, 'escalated');
    for (const bucket of [auto, explicit, fallback, escalated]) {
      expect(bucket.length).toBeGreaterThan(0);
    }
    expect(auto.every((r) => r.layer === 'structural' || r.layer === 'escalated')).toBe(true);
    expect(explicit.every((r) => r.layer === 'explicit' || r.layer === 'header')).toBe(true);
    expect(fallback.every((r) => r.status === 'fallback')).toBe(true);
    expect(escalated.every((r) => r.escalated)).toBe(true);
    expect(auto.length + explicit.length).toBe(corpus.length);
    expect(filterRequests(corpus, 'all')).toHaveLength(corpus.length);
  });

  it('walks the onboarding steps to completion', () => {
    const s = createAppStore();
    expect(s.state.ob.step).toBe(1);
    s.obCreateAgent();
    expect(s.state.ob.key).toMatch(/^poly_/);
    expect(s.state.ob.done1).toBe(true);
    s.obGo(2);
    s.obPickProvider('local');
    expect(s.state.ob.done2).toBe(true);
    s.obGo(3);
    s.obFinish();
    expect(s.state.page).toBe('overview');
  });
});
