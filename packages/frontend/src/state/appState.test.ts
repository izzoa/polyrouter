import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type AgentDto } from '../data/api';
import { DEFAULT_SESSION, FakeApiClient } from '../test/fakeClient';
import type { ProviderForm } from '../types';
import { createAppStore } from './appState';

const LOCAL_FORM: ProviderForm = {
  name: 'Local',
  kind: 'local',
  protocol: 'openai_compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  credential: '',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('auth bootstrap & gate', () => {
  it('me 200 → ready and loads the realized slices', async () => {
    const agent: AgentDto = {
      id: 'a1',
      name: 'openclaw',
      harness: 'openclaw',
      prefix: 'poly_k7Jf',
      lastUsedAt: null,
      createdAt: '2026-07-15T00:00:00.000Z',
    };
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, agents: [agent] });
    const s = createAppStore(fake);
    await s.bootstrap();
    expect(s.state.authView).toBe('ready');
    expect(s.state.session?.email).toBe('admin@localhost');
    expect(s.state.agents).toHaveLength(1);
  });

  it('me 401 → gate and fetches login-config', async () => {
    const fake = new FakeApiClient({ session: null });
    const s = createAppStore(fake);
    await s.bootstrap();
    expect(s.state.authView).toBe('gate');
    expect(s.state.session).toBeNull();
    expect(s.state.loginConfig?.emailPassword).toBe(true);
  });

  it('non-401 fault → error → retry() → ready', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    fake.meFailure = new ApiError(500, 'Internal', 'boom');
    const s = createAppStore(fake);
    await s.bootstrap();
    expect(s.state.authView).toBe('error');
    expect(s.state.authError).toBe('boom');
    fake.meFailure = null;
    await s.retry();
    expect(s.state.authView).toBe('ready');
  });

  it('sign-in → ready', async () => {
    const fake = new FakeApiClient({ session: null });
    const s = createAppStore(fake);
    await s.bootstrap();
    expect(s.state.authView).toBe('gate');
    await s.signIn({ email: 'a@b.c', password: 'pw' });
    expect(s.state.authView).toBe('ready');
    expect(fake.calls).toContain('signInEmail');
  });

  it('sign-up sends name + email + password and lands ready', async () => {
    const fake = new FakeApiClient({ session: null });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.signUp({ name: 'Ada', email: 'ada@x.io', password: 'pw12345678' });
    expect(s.state.authView).toBe('ready');
    expect(fake.lastArgs('signUpEmail')?.[0]).toMatchObject({ name: 'Ada', email: 'ada@x.io' });
  });

  it('sign-out under auto-login stays ready', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    expect(s.state.authView).toBe('ready');
    await s.signOut();
    expect(fake.calls).toContain('signOut');
    // Loopback: me() still returns 200 → the gate never shows.
    expect(s.state.authView).toBe('ready');
  });
});

describe('agents (real CRUD)', () => {
  it('creates an agent, reveals the server key+snippet once, and adds the row', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('na', { name: 'test-agent', harness: 'curl' });
    await s.createAgent();
    expect(s.state.agents.some((a) => a.name === 'test-agent')).toBe(true);
    expect(s.state.modal).toBe('keyReveal');
    expect(s.state.kr.key).toMatch(/^poly_/);
    expect(s.state.kr.snippet).toContain(s.state.kr.key);
  });

  it('clears the raw key on modal dismiss (never persisted)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('na', { name: 'x', harness: 'curl' });
    await s.createAgent();
    expect(s.state.kr.key).not.toBe('');
    s.closeModal();
    expect(s.state.kr.key).toBe('');
    expect(s.state.modal).toBeNull();
  });

  it('clears BOTH reveal and onboarding secrets on sign-out', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('na', { name: 'x', harness: 'curl' });
    await s.createAgent();
    await s.obCreateAgent();
    expect(s.state.kr.key).not.toBe('');
    expect(s.state.ob.key).not.toBe('');
    await s.signOut();
    expect(s.state.kr.key).toBe('');
    expect(s.state.ob.key).toBe('');
  });

  it('rotates and deletes agents', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('na', { name: 'doomed', harness: 'curl' });
    await s.createAgent();
    const agent = s.state.agents.find((a) => a.name === 'doomed');
    expect(agent).toBeDefined();
    if (!agent) return;

    await s.rotateKey(agent);
    expect(s.state.modal).toBe('keyReveal');
    expect(s.state.kr.key).toMatch(/^poly_/);
    s.closeModal();

    const before = s.state.agents.length;
    await s.deleteAgent(agent);
    expect(s.state.agents).toHaveLength(before - 1);
    expect(s.state.agents.find((a) => a.id === agent.id)).toBeUndefined();
  });
});

describe('providers (create → test → sync, kind mapping, pricing)', () => {
  async function addProvider(
    s: ReturnType<typeof createAppStore>,
    form: ProviderForm,
  ): Promise<void> {
    s.openModal('newProvider');
    s.setState('np', { ...form });
    await s.addProvider();
  }

  it('maps UI kind api → api_key and branches Test/Sync on result.ok', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    await addProvider(s, {
      name: 'My API',
      kind: 'api',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1',
      credential: 'sk-secret',
    });
    expect(s.state.providers).toHaveLength(1);
    const created = s.state.providers[0];
    expect(created).toBeDefined();
    if (!created) return;
    expect(created.kind).toBe('api_key');
    expect(fake.lastArgs('createProvider')?.[0]).toMatchObject({ kind: 'api_key' });

    await s.testProviderById(created.id);
    expect(s.state.providers[0]?.status).toBe('ok');

    await s.syncProvider(created.id);
    expect(fake.calls).toContain('syncModels');
    expect(s.state.models[created.id]?.length ?? 0).toBeGreaterThan(0);
  });

  it('marks the provider error and loads no models when sync !ok', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      syncResult: {
        ok: false,
        status: 'error',
        kind: 'auth',
        message: 'authentication failed',
        traceId: 't',
      },
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    await addProvider(s, {
      name: 'Bad',
      kind: 'api',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1',
      credential: 'sk',
    });
    const created = s.state.providers[0];
    if (!created) return;
    await s.syncProvider(created.id);
    expect(s.state.providers[0]?.status).toBe('error');
    expect(s.state.models[created.id]).toBeUndefined();
  });

  it('edits custom/local model prices (paired and free)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    await addProvider(s, LOCAL_FORM);
    const prov = s.state.providers[0];
    expect(prov?.kind).toBe('local');
    if (!prov) return;
    await s.syncProvider(prov.id);
    const model = s.state.models[prov.id]?.[0];
    expect(model).toBeDefined();
    if (!model) return;

    await s.setModelPrice(prov.id, model.id, { inputPricePer1m: 1.5, outputPricePer1m: 2.5 });
    const priced = s.state.models[prov.id]?.find((m) => m.id === model.id);
    expect(priced?.inputPricePer1m).toBe(1.5);
    expect(priced?.outputPricePer1m).toBe(2.5);
    expect(priced?.isFree).toBe(false);

    await s.setModelPrice(prov.id, model.id, { isFree: true });
    const free = s.state.models[prov.id]?.find((m) => m.id === model.id);
    expect(free?.isFree).toBe(true);
    expect(fake.countOf('updateModelPricing')).toBe(2);
  });
});

describe('onboarding (failure-aware walk)', () => {
  const setProv = (s: ReturnType<typeof createAppStore>): void =>
    s.setState('ob', 'prov', { ...LOCAL_FORM });

  it('walks agent → provider/sync/assign → verify to completion', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();

    await s.obCreateAgent();
    expect(s.state.ob.key).toMatch(/^poly_/);
    expect(s.state.ob.done1).toBe(true);

    s.obGo(2);
    setProv(s);
    await s.obConnectProvider();
    expect(s.state.ob.done2).toBe(true);
    expect(s.state.ob.assignedModel).toBeTruthy();
    const putArgs = fake.lastArgs('replaceTierEntries');
    expect(putArgs?.[0]).toBe('tier-default');
    expect(Array.isArray(putArgs?.[1])).toBe(true);
    expect((putArgs?.[1] as string[]).length).toBe(1);

    s.obGo(3);
    await s.obVerify();
    expect(s.state.ob.verifyReply).toContain('routing works');
    const proxyArgs = fake.lastArgs('proxyTest');
    expect(proxyArgs?.[0]).toMatch(/^poly_/);
    expect(proxyArgs?.[1]).toMatchObject({ model: 'auto' });

    s.obFinish();
    expect(s.state.page).toBe('overview');
    expect(s.state.ob.key).toBe('');
  });

  it('stops before assigning when sync reports zero models', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      syncResult: { ok: true, status: 'ok', message: 'synced', traceId: 't', synced: 0 },
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.obCreateAgent();
    setProv(s);
    await s.obConnectProvider();
    expect(s.state.ob.done2).toBe(false);
    expect(s.state.ob.error2).toMatch(/no models/i);
    expect(fake.calls).not.toContain('replaceTierEntries');
  });

  it('stops when there is no default tier', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, tiers: [] });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.obCreateAgent();
    setProv(s);
    await s.obConnectProvider();
    expect(s.state.ob.done2).toBe(false);
    expect(s.state.ob.error2).toMatch(/default tier/i);
    expect(fake.calls).not.toContain('replaceTierEntries');
  });

  it('surfaces a verify failure without a reply', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      proxyFailure: new ApiError(502, 'Bad Gateway', 'upstream down'),
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.obCreateAgent();
    s.obGo(3);
    await s.obVerify();
    expect(s.state.ob.error3).toContain('upstream down');
    expect(s.state.ob.verifyReply).toBeNull();
  });
});

describe('simulated slices (deferred pages)', () => {
  const sim = () => createAppStore(new FakeApiClient());

  it('reorders a tier chain and recomputes the primary', () => {
    const s = sim();
    const before = [...(s.state.tiers[0]?.chain ?? [])];
    s.reorderChain(0, 2, 0);
    const after = s.state.tiers[0]?.chain ?? [];
    expect(after[0]).toBe(before[2]);
    expect(after).toHaveLength(before.length);
  });

  it('enforces the 5-model cap with a toast', () => {
    const s = sim();
    expect(s.addToChain(0, 'kimi-k2')).toBe(true);
    expect(s.addToChain(0, 'gemini-3-flash')).toBe(true);
    expect(s.state.tiers[0]?.chain).toHaveLength(5);
    expect(s.addToChain(0, 'gpt-5.2')).toBe(false);
    expect(s.state.tiers[0]?.chain).toHaveLength(5);
    expect(s.state.toast).toBe('Max 5 models per tier');
  });

  it('removes models and header rules', () => {
    const s = sim();
    s.removeFromChain(0, 'deepseek-v3.2');
    expect(s.state.tiers[0]?.chain).not.toContain('deepseek-v3.2');
    s.removeRule(1);
    expect(s.state.rules.map((r) => r.id)).not.toContain(1);
  });

  it('toggles L1/L3 but keeps L2 locked as cloud-tier', () => {
    const s = sim();
    s.toggleLayer('structural');
    expect(s.state.autoLayers.structural).toBe(false);
    s.toggleLayer('semantic');
    expect(s.state.autoLayers.semantic).toBe(false);
    expect(s.state.toast).toBe('Layer 2 is a cloud-tier graduation');
  });

  it('creates budgets from the modal state', () => {
    const s = sim();
    s.setState('nl', { scope: 'Global', amount: '42.50', window: 'week', action: 'block' });
    s.createLimit();
    const limit = s.state.limits.at(-1);
    expect(limit?.threshold).toBe(42.5);
    expect(limit?.action).toBe('block');
    expect(limit?.note).toContain('hard stop');
  });
});
