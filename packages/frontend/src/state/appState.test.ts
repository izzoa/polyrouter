import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type AgentDto,
  type ChannelDto,
  type ModelDto,
  type TierDto,
  type TierEntryDto,
} from '../data/api';
import { DEFAULT_SESSION, FakeApiClient } from '../test/fakeClient';
import type { ProviderForm } from '../types';
import { createAppStore } from './appState';

const NOW = '2026-07-15T00:00:00.000Z';
/** Let a fire-and-forget optimistic persist settle (macrotask after microtasks). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function mkModel(id: string): ModelDto {
  return {
    id,
    providerId: 'p1',
    externalModelId: `ext-${id}`,
    displayName: null,
    contextWindow: null,
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    isFree: false,
    inputPricePer1m: 1,
    outputPricePer1m: 2,
    effectivePrice: {
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      isFree: false,
      source: 'model',
      estimated: false,
    },
    lastSyncedAt: null,
  };
}
function mkEntry(tierId: string, modelId: string, position: number): TierEntryDto {
  return { id: `e-${modelId}`, tierId, modelId, position, model: null };
}
function mkChannel(id: string, kind: 'smtp' | 'apprise'): ChannelDto {
  return {
    id,
    name: `chan-${id}`,
    kind,
    enabled: true,
    eventsSubscribed: ['budget_alert'],
    hasConfig: true,
    lastTestAt: null,
    lastTestStatus: null,
  };
}
/** A fake seeded with a `default` tier holding m1..m3 and 6 available models. */
function routingFake(): FakeApiClient {
  const tiers: TierDto[] = [
    { id: 't1', key: 'default', displayName: 'Default', description: null, createdAt: NOW },
  ];
  return new FakeApiClient({
    session: DEFAULT_SESSION,
    models: { p1: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(mkModel) },
    tiers,
    tierEntries: { t1: [mkEntry('t1', 'm1', 0), mkEntry('t1', 'm2', 1), mkEntry('t1', 'm3', 2)] },
  });
}

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

  it('createAgent is single-flight — a double-submit creates one agent (A-27)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('na', { name: 'once', harness: 'curl' });
    // Both calls fire before the first resolves; the second must bail on the busy guard.
    await Promise.all([s.createAgent(), s.createAgent()]);
    expect(fake.countOf('createAgent')).toBe(1);
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

  it('edits a provider: prefills, blank credential preserves, explicit clear sends empty, typed rotates', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    await addProvider(s, {
      name: 'Orig',
      kind: 'api',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1',
      credential: 'sk-1',
    });
    const p = s.state.providers[0]!;

    // Open edit → prefilled, edit mode, credential never echoed into the form.
    s.openEditProvider(p);
    expect(s.state.modal).toBe('editProvider');
    expect(s.state.np.editingId).toBe(p.id);
    expect(s.state.np.name).toBe('Orig');
    expect(s.state.np.kind).toBe('api');
    expect(s.state.np.credential).toBe('');
    expect(s.state.np.hadCredential).toBe(true);

    // Rename, blank credential → the patch OMITS credential (preserve).
    s.setState('np', 'name', 'Renamed');
    await s.addProvider();
    let patch = fake.lastArgs('updateProvider')?.[1] as Record<string, unknown>;
    expect(fake.lastArgs('updateProvider')?.[0]).toBe(p.id);
    expect(patch).toMatchObject({ name: 'Renamed' });
    expect('credential' in patch).toBe(false);
    expect(s.state.modal).toBeNull();
    expect(s.state.providers[0]?.name).toBe('Renamed');

    // Explicit clear → credential: ''.
    s.openEditProvider(s.state.providers[0]!);
    s.setState('np', 'clearCredential', true);
    await s.addProvider();
    patch = fake.lastArgs('updateProvider')?.[1] as Record<string, unknown>;
    expect(patch['credential']).toBe('');

    // A typed value rotates it.
    s.openEditProvider(s.state.providers[0]!);
    s.setState('np', 'credential', 'sk-2');
    await s.addProvider();
    patch = fake.lastArgs('updateProvider')?.[1] as Record<string, unknown>;
    expect(patch['credential']).toBe('sk-2');
  });

  it('editing an OAuth-connected row submits a NAME-ONLY patch (add-chatgpt-responses)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    // Connect a ChatGPT (Responses-protocol) row through the wizard.
    s.openModal('newProvider');
    await tick();
    s.setState('np', 'kind', 'sub');
    await s.startOauthConnect('chatgpt');
    s.setState('ow', 'pasted', 'the-code#st-chatgpt');
    await s.completeOauthConnect();
    const row = s.state.providers.find((p) => p.oauthPreset === 'chatgpt')!;
    expect(row.protocol).toBe('openai_responses');

    // Edit: the form records the lock; the PATCH carries the name and NOTHING else —
    // echoing protocol would 400 on the public DTO enum.
    s.openEditProvider(row);
    expect(s.state.np.oauthPreset).toBe('chatgpt');
    s.setState('np', 'name', 'My ChatGPT');
    await s.addProvider();
    const patch = fake.lastArgs('updateProvider')?.[1] as Record<string, unknown>;
    expect(patch).toEqual({ name: 'My ChatGPT' });
    expect(s.state.providers.find((p) => p.id === row.id)?.name).toBe('My ChatGPT');

    // The SO-1 credential rules still apply on the locked form: an explicit clear
    // sends credential:'' (convert/clear), still without kind/protocol/baseUrl.
    s.openEditProvider(s.state.providers.find((p) => p.id === row.id)!);
    s.setState('np', 'clearCredential', true);
    await s.addProvider();
    const clearPatch = fake.lastArgs('updateProvider')?.[1] as Record<string, unknown>;
    expect(clearPatch).toEqual({ name: 'My ChatGPT', credential: '' });

    // A non-OAuth row's edit payload is UNCHANGED (regression guard).
    await addProvider(s, {
      name: 'Plain',
      kind: 'api',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1',
      credential: 'sk-1',
    });
    const plain = s.state.providers.find((p) => p.name === 'Plain')!;
    s.openEditProvider(plain);
    expect(s.state.np.oauthPreset).toBeNull();
    await s.addProvider();
    const fullPatch = fake.lastArgs('updateProvider')?.[1] as Record<string, unknown>;
    expect(fullPatch).toMatchObject({
      name: 'Plain',
      kind: 'api_key',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1',
    });
  });

  it('runs the OAuth connect wizard: start → paste → complete → provider appears', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.openModal('newProvider');
    await tick(); // preset load settles
    expect(s.state.ow.presets.map((p) => p.id)).toContain('claude');
    s.setState('np', 'kind', 'sub');
    await s.startOauthConnect('claude');
    expect(s.state.ow.active?.sessionId).toBe('sess-claude');
    expect(s.state.ow.active?.authorizeUrl).toContain('https://idp.example/authorize');
    // Client-side bare-code guidance — no API call.
    s.setState('ow', 'pasted', 'just-a-bare-code');
    await s.completeOauthConnect();
    expect(s.state.ow.error).toContain('code#state');
    expect(fake.calls).not.toContain('oauthComplete');
    // The real paste completes, appends the provider, and closes the modal.
    s.setState('ow', 'pasted', 'the-code#st-claude');
    await s.completeOauthConnect();
    expect(fake.lastArgs('oauthComplete')?.[1]).toBe('the-code#st-claude');
    expect(s.state.providers.some((p) => p.oauthPreset === 'claude')).toBe(true);
    expect(s.state.modal).toBeNull();
    expect(s.state.ow.pasted).toBe(''); // credential material cleared
  });

  it('a failed OAuth completion keeps the modal open, clears the paste, and shows the error', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    fake.oauthCompleteRejects = new ApiError(422, 'Unprocessable', 'sign-in state mismatch — restart connect');
    const s = createAppStore(fake);
    await s.bootstrap();
    s.openModal('newProvider');
    s.setState('np', 'kind', 'sub');
    await s.startOauthConnect('claude');
    s.setState('ow', 'pasted', 'code#state');
    await s.completeOauthConnect();
    expect(s.state.modal).toBe('newProvider'); // still open
    expect(s.state.ow.error).toContain('state mismatch');
    expect(s.state.ow.pasted).toBe(''); // cleared after every submit attempt
  });

  it('reauthorize opens the wizard bound to the existing provider row', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.openModal('newProvider');
    s.setState('np', 'kind', 'sub');
    await s.startOauthConnect('claude');
    s.setState('ow', 'pasted', 'the-code#st');
    await s.completeOauthConnect();
    const provider = s.state.providers.find((p) => p.oauthPreset === 'claude')!;
    await s.startOauthReauthorize(provider);
    expect(s.state.modal).toBe('newProvider');
    expect(s.state.ow.active?.reauthorizeProviderId).toBe(provider.id);
    expect(fake.lastArgs('oauthReauthorize')?.[0]).toBe(provider.id);
  });

  it('does not dismiss the provider modal while an OAuth exchange is in flight', () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.setState('modal', 'newProvider');
    s.setState('ow', 'busy', true);
    s.closeModal();
    expect(s.state.modal).toBe('newProvider');
    s.setState('ow', 'busy', false);
    s.closeModal();
    expect(s.state.modal).toBeNull();
  });

  it('does not dismiss the provider modal while a save is in flight (busy-dismissal)', () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.setState('modal', 'editProvider');
    s.setState('np', 'busy', true);
    s.closeModal();
    expect(s.state.modal).toBe('editProvider'); // Cancel/Escape/backdrop are refused mid-save
    s.setState('np', 'busy', false);
    s.closeModal();
    expect(s.state.modal).toBeNull();
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

  it('a retry after a downstream failure reuses the provider, not a duplicate (A-26)', async () => {
    // Sync reports zero models → the connect step fails AFTER the provider was created.
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
    expect(fake.countOf('createProvider')).toBe(1);
    await s.obConnectProvider(); // retry with the SAME form
    expect(fake.countOf('createProvider')).toBe(1); // reused the created provider, no duplicate
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

describe('routing config (real CRUD)', () => {
  it('loads tiers, entries, models, rules and auto-layers', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    expect(s.state.routingTiers).toHaveLength(1);
    expect(s.state.tierEntries['t1']).toHaveLength(3);
    expect(s.state.allModels).toHaveLength(6);
    expect(s.state.autoLayers?.structural).toBe(true);
  });

  it('reorders a tier chain and persists the new modelIds', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    s.moveTierEntry('t1', 2, 0);
    await s.commitTierOrder('t1');
    expect(fake.lastArgs('replaceTierEntries')).toEqual(['t1', ['m3', 'm1', 'm2']]);
  });

  it('adds a model (appended modelIds) and caps at 5 with a toast', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    s.addTierModel('t1', 'm4');
    await tick();
    expect(fake.lastArgs('replaceTierEntries')).toEqual(['t1', ['m1', 'm2', 'm3', 'm4']]);
    s.addTierModel('t1', 'm5');
    await tick();
    expect(s.state.tierEntries['t1']).toHaveLength(5);
    s.addTierModel('t1', 'm6');
    expect(s.state.toast).toBe('Max 5 models per tier');
    expect(s.state.tierEntries['t1']).toHaveLength(5);
    await tick();
  });

  it('removes a model and persists the shortened modelIds', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    s.removeTierModel('t1', 'm2');
    await tick();
    expect(fake.lastArgs('replaceTierEntries')).toEqual(['t1', ['m1', 'm3']]);
  });

  it('sets a fallback as primary (position 0)', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    s.setPrimaryTierModel('t1', 'm3');
    await tick();
    expect(fake.lastArgs('replaceTierEntries')).toEqual(['t1', ['m3', 'm1', 'm2']]);
  });

  it('creates and deletes a header rule (value → tier:<key>)', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    s.setState('rf', { value: 'heavy', target: 'heavy' });
    await s.createRule();
    expect(fake.lastArgs('createRule')?.[0]).toMatchObject({
      matchType: 'header',
      headerValue: 'heavy',
      target: 'tier:heavy',
    });
    const created = s.state.rules.find((r) => r.headerValue === 'heavy');
    expect(created).toBeDefined();
    if (!created) return;
    await s.deleteRule(created.id);
    expect(s.state.rules.find((r) => r.id === created.id)).toBeUndefined();
  });

  it('toggles auto-layers: structural off, then cascade-on re-enables structural', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    await s.toggleAutoLayer('structural');
    expect(fake.lastArgs('setAutoLayers')?.[0]).toEqual({ structural: false, cascade: false });
    expect(s.state.autoLayers?.structural).toBe(false);
    await s.toggleAutoLayer('cascade');
    expect(fake.lastArgs('setAutoLayers')?.[0]).toEqual({ structural: true, cascade: true });
    expect(s.state.autoLayers?.structural).toBe(true);
    expect(s.state.autoLayers?.cascade).toBe(true);
  });

  it('leaves an instance-disabled (unavailable) layer inert', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      autoLayers: {
        structural: false,
        cascade: false,
        structuralAvailable: false,
        cascadeAvailable: false,
      },
    });
    const s = createAppStore(fake);
    await s.loadRouting();
    await s.toggleAutoLayer('structural');
    expect(fake.countOf('setAutoLayers')).toBe(0);
    expect(s.state.autoLayers?.structural).toBe(false);
  });
});

describe('budgets (real CRUD)', () => {
  it('creates an alert budget with channel wiring', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openBudget();
    s.setState('bf', {
      name: 'daily cap',
      scope: 'global',
      amount: '12.50',
      window: 'day',
      action: 'alert',
      notifyChannelIds: ['chan-1'],
    });
    await s.saveBudget();
    expect(fake.lastArgs('createBudget')?.[0]).toMatchObject({
      scope: 'global',
      action: 'alert',
      amount: 12.5,
      notifyChannelIds: ['chan-1'],
    });
    expect(s.state.budgets.some((b) => b.name === 'daily cap')).toBe(true);
    expect(s.state.modal).toBeNull();
  });

  it('creates a block budget', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openBudget();
    s.setState('bf', { name: 'hard cap', amount: '80', window: 'month', action: 'block' });
    await s.saveBudget();
    expect(fake.lastArgs('createBudget')?.[0]).toMatchObject({ action: 'block', amount: 80 });
  });

  it('surfaces the agent-needs-agentId 422 inline and keeps the modal open', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openBudget();
    s.setState('bf', { name: 'agent cap', scope: 'agent', agentId: '', amount: '5' });
    await s.saveBudget();
    expect(s.state.bf.error).toMatch(/agentId/i);
    expect(s.state.modal).toBe('newLimit');
    expect(s.state.budgets).toHaveLength(0);
  });
});

describe('notification channels (real CRUD + test-send)', () => {
  it('creates an SMTP channel from the form', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openChannel();
    s.setState('cf', {
      name: 'homelab email',
      kind: 'smtp',
      smtpHost: 'smtp.fastmail.com',
      smtpPort: '587',
      smtpFrom: 'alerts@my.box',
      smtpTo: 'admin@my.box',
      events: ['budget_alert'],
    });
    await s.saveChannel();
    expect(fake.lastArgs('createChannel')?.[0]).toMatchObject({
      name: 'homelab email',
      kind: 'smtp',
    });
    expect(s.state.channels.some((c) => c.name === 'homelab email')).toBe(true);
    expect(s.state.modal).toBeNull();
  });

  it('renders a failed test-send result inline via channelTests', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openChannel();
    s.setState('cf', {
      name: 'ntfy',
      kind: 'apprise',
      appriseUrls: 'ntfy://homelab/polyrouter',
      events: ['budget_alert'],
    });
    await s.saveChannel();
    const created = s.state.channels[0];
    expect(created).toBeDefined();
    if (!created) return;
    fake.channelTestResult = { ok: false, error: 'apprise_unreachable' };
    await s.testChannelById(created.id);
    expect(s.state.channelTests[created.id]).toEqual({ ok: false, error: 'apprise_unreachable' });
  });

  it('toggles a channel enabled flag through the API', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openChannel();
    s.setState('cf', {
      name: 'c',
      kind: 'apprise',
      appriseUrls: 'ntfy://x/y',
      events: ['budget_alert'],
    });
    await s.saveChannel();
    const c = s.state.channels[0];
    expect(c?.enabled).toBe(true);
    if (!c) return;
    await s.toggleChannelEnabled(c);
    expect(s.state.channels[0]?.enabled).toBe(false);
  });

  it('requires a full new config on a kind change, then PATCHes kind + config (#3)', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      channels: [mkChannel('c1', 'smtp')],
    });
    const s = createAppStore(fake);
    await s.loadChannels();
    s.openChannel(s.state.channels[0]);
    // Change kind smtp → apprise with a BLANK config: blocked inline, no PATCH.
    s.setState('cf', 'kind', 'apprise');
    await s.saveChannel();
    expect(s.state.cf.error).toBeTruthy();
    expect(fake.countOf('updateChannel')).toBe(0);
    // Provide the new apprise config: PATCH now carries kind + config.
    s.setState('cf', 'appriseUrls', 'ntfy://homelab/x');
    await s.saveChannel();
    expect(fake.lastArgs('updateChannel')?.[1]).toMatchObject({
      kind: 'apprise',
      config: { urls: ['ntfy://homelab/x'] },
    });
    expect(s.state.channels[0]?.kind).toBe('apprise');
  });

  it('reconciles a saved channel directly without re-listing (#5)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openChannel();
    s.setState('cf', {
      name: 'direct',
      kind: 'apprise',
      appriseUrls: 'ntfy://x/y',
      events: ['budget_alert'],
    });
    await s.saveChannel();
    expect(s.state.channels.some((c) => c.name === 'direct')).toBe(true);
    // No GET /notification-channels re-list — a swallowed refresh can't mask success.
    expect(fake.countOf('listChannels')).toBe(0);
  });
});

describe('config write serialization & single-flight guards (#20 review)', () => {
  it('serializes tier writes: a failed earlier PUT never loses a newer edit (#1/#2)', async () => {
    const fake = routingFake();
    fake.deferTierWrites = true;
    const s = createAppStore(fake);
    await s.loadRouting();
    // Two rapid edits; only the first PUT ([..m4]) is in flight (single-flight).
    s.addTierModel('t1', 'm4');
    s.addTierModel('t1', 'm5');
    await tick();
    expect(fake.tierWriteQueue).toHaveLength(1);
    expect(fake.tierWriteQueue[0]?.input.modelIds).toEqual(['m1', 'm2', 'm3', 'm4']);
    // The earlier write FAILS out of order; the newer desired must still be sent + win.
    fake.tierWriteQueue[0]?.settle('reject');
    await tick();
    expect(fake.tierWriteQueue).toHaveLength(2);
    expect(fake.tierWriteQueue[1]?.input.modelIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    fake.tierWriteQueue[1]?.settle('resolve');
    await tick();
    expect(s.state.tierEntries['t1']?.map((e) => e.modelId)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);
    expect(s.state.confirmedEntries['t1']).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('rolls a failed reorder back to the CONFIRMED order, not the mid-drag order (#1)', async () => {
    const fake = routingFake();
    fake.deferTierWrites = true;
    const s = createAppStore(fake);
    await s.loadRouting();
    s.moveTierEntry('t1', 2, 0); // optimistic mid-drag order [m3, m1, m2]
    await s.commitTierOrder('t1');
    expect(s.state.tierEntries['t1']?.map((e) => e.modelId)).toEqual(['m3', 'm1', 'm2']);
    fake.tierWriteQueue[0]?.settle('reject');
    await tick();
    // Rollback restores the server-confirmed order, NOT the failed optimistic one.
    expect(s.state.tierEntries['t1']?.map((e) => e.modelId)).toEqual(['m1', 'm2', 'm3']);
    expect(s.state.confirmedEntries['t1']).toEqual(['m1', 'm2', 'm3']);
  });

  it('serializes auto-layer toggles: a failed earlier PUT never loses the newer toggle (#2)', async () => {
    const fake = routingFake();
    fake.deferAutoLayers = true;
    const s = createAppStore(fake);
    await s.loadRouting();
    await s.toggleAutoLayer('structural'); // desired {structural:false, cascade:false}
    await s.toggleAutoLayer('structural'); // desired {structural:true, cascade:false}
    expect(fake.autoLayersQueue).toHaveLength(1);
    expect(fake.autoLayersQueue[0]?.input).toEqual({ structural: false, cascade: false });
    fake.autoLayersQueue[0]?.settle('reject');
    await tick();
    expect(fake.autoLayersQueue).toHaveLength(2);
    expect(fake.autoLayersQueue[1]?.input).toEqual({ structural: true, cascade: false });
    fake.autoLayersQueue[1]?.settle('resolve');
    await tick();
    expect(s.state.autoLayers?.structural).toBe(true);
    expect(s.state.autoLayers?.cascade).toBe(false);
  });

  it('prevents double-submit of a budget (#6)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openBudget();
    s.setState('bf', { name: 'x', scope: 'global', amount: '5', window: 'day', action: 'alert' });
    await Promise.all([s.saveBudget(), s.saveBudget()]);
    expect(fake.countOf('createBudget')).toBe(1);
  });

  it('prevents double-submit of a channel (#6)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    s.openChannel();
    s.setState('cf', {
      name: 'c',
      kind: 'apprise',
      appriseUrls: 'ntfy://x/y',
      events: ['budget_alert'],
    });
    await Promise.all([s.saveChannel(), s.saveChannel()]);
    expect(fake.countOf('createChannel')).toBe(1);
  });

  it('prevents double-fire of a channel test-send (#6)', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      channels: [mkChannel('c1', 'smtp')],
    });
    const s = createAppStore(fake);
    await s.loadChannels();
    const id = s.state.channels[0]?.id ?? 'c1';
    await Promise.all([s.testChannelById(id), s.testChannelById(id)]);
    expect(fake.countOf('testChannel')).toBe(1);
  });
});

describe('stale-loader-overwrite guards (#20 verify pass)', () => {
  it('discards a routing GET that lands after a successful PUT (#1)', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    // Start a reload that is held open mid-flight (it snapshots the OLD config).
    fake.gateReads = true;
    const reload = s.loadRouting();
    await tick();
    // A PUT succeeds during the load — confirmed/visible advance to [..m4].
    s.addTierModel('t1', 'm4');
    await tick();
    expect(s.state.confirmedEntries['t1']).toEqual(['m1', 'm2', 'm3', 'm4']);
    // The stale GET now resolves — it must NOT clobber the just-persisted state.
    fake.gateReads = false;
    fake.openGate();
    await reload;
    expect(s.state.confirmedEntries['t1']).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(s.state.tierEntries['t1']?.map((e) => e.modelId)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('discards a channels GET that lands after a save (#3)', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      channels: [mkChannel('c1', 'smtp')],
    });
    const s = createAppStore(fake);
    await s.loadChannels();
    fake.gateReads = true;
    const reload = s.loadChannels(); // snapshots [c1]
    await tick();
    s.openChannel();
    s.setState('cf', {
      name: 'c2',
      kind: 'apprise',
      appriseUrls: 'ntfy://x/y',
      events: ['budget_alert'],
    });
    await s.saveChannel(); // adds c2, bumps channelsSeq
    expect(s.state.channels.some((c) => c.name === 'c2')).toBe(true);
    fake.gateReads = false;
    fake.openGate();
    await reload;
    // The stale GET (snapshot [c1]) must not drop the just-created c2.
    expect(s.state.channels.some((c) => c.name === 'c2')).toBe(true);
  });

  it('discards a budgets GET that lands after a budget create, keeping channels fresh (#3)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.loadLimits();
    fake.gateReads = true;
    const reload = s.loadLimits(); // snapshots empty budgets
    await tick();
    s.openBudget();
    s.setState('bf', { name: 'b1', scope: 'global', amount: '5', window: 'day', action: 'alert' });
    await s.saveBudget(); // adds b1, bumps budgetsSeq
    fake.gateReads = false;
    fake.openGate();
    await reload;
    expect(s.state.budgets.some((b) => b.name === 'b1')).toBe(true);
  });

  it('retires a deleted tier’s in-flight write without resurrecting it (#2)', async () => {
    const fake = routingFake();
    fake.deferTierWrites = true;
    const s = createAppStore(fake);
    await s.loadRouting();
    s.addTierModel('t1', 'm4'); // PUT queued, deferred
    await tick();
    expect(fake.tierWriteQueue).toHaveLength(1);
    await s.deleteTier('t1');
    expect(s.state.routingTiers.find((t) => t.id === 't1')).toBeUndefined();
    expect(s.state.tierEntries['t1']).toBeUndefined();
    // The late PUT response must not recreate the tier's snapshot.
    fake.tierWriteQueue[0]?.settle('resolve');
    await tick();
    expect(s.state.tierEntries['t1']).toBeUndefined();
    expect(s.state.confirmedEntries['t1']).toBeUndefined();
  });

  it('a deleted tier’s failed late write raises no misleading toast (#2)', async () => {
    const fake = routingFake();
    fake.deferTierWrites = true;
    const s = createAppStore(fake);
    await s.loadRouting();
    s.addTierModel('t1', 'm4');
    await tick();
    await s.deleteTier('t1');
    expect(s.state.toast).toBe('Tier deleted');
    fake.tierWriteQueue[0]?.settle('reject');
    await tick();
    expect(s.state.toast).toBe('Tier deleted'); // no 404/error toast for the retired write
    expect(s.state.tierEntries['t1']).toBeUndefined();
  });

  it('coalesces rapid channel enable-toggle clicks (#5)', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      channels: [mkChannel('c1', 'smtp')],
    });
    const s = createAppStore(fake);
    await s.loadChannels();
    const c = s.state.channels[0];
    expect(c).toBeDefined();
    if (!c) return;
    await Promise.all([s.toggleChannelEnabled(c), s.toggleChannelEnabled(c)]);
    expect(fake.countOf('updateChannel')).toBe(1);
    expect(s.state.channels[0]?.enabled).toBe(false);
  });

  it('refuses to dismiss a budget/channel modal while a save is in flight (#4)', () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    s.openChannel();
    s.setState('cf', 'busy', true); // simulate an in-flight save
    s.closeModal();
    expect(s.state.modal).toBe('channel'); // not dismissed
    s.setState('cf', 'busy', false);
    s.closeModal();
    expect(s.state.modal).toBeNull();
  });
});

describe('E12.1 — a mid-session 401 re-gates to login', () => {
  it('a loader 401 after ready re-probes and flips authView to gate', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    expect(s.state.authView).toBe('ready');
    // Session expires: the next loader 401s, and the re-probe me() 401s too.
    fake.session = null;
    vi.spyOn(fake, 'listProviders').mockRejectedValueOnce(
      new ApiError(401, 'Unauthorized', 'Unauthorized'),
    );
    await s.loadProviders();
    await tick(); // let the fire-and-forget bootstrap() re-probe settle
    expect(s.state.authView).toBe('gate');
    expect(s.state.session).toBeNull();
  });

  it('a non-401 loader error stays ready (no spurious re-gate)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    vi.spyOn(fake, 'listProviders').mockRejectedValueOnce(new ApiError(500, 'Internal', 'boom'));
    await s.loadProviders();
    await tick();
    expect(s.state.authView).toBe('ready');
    expect(s.state.providersError).toBe('boom');
  });
});

describe('E12.2 — copy() only claims success when the clipboard write succeeded', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a missing clipboard API toasts a failure, not "Key copied"', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    vi.stubGlobal('navigator', {}); // non-secure origin: navigator.clipboard is undefined
    s.copy('poly_secret', 'Key copied');
    await tick();
    expect(s.state.toast).toBe('Copy failed — select the text manually');
  });

  it('a rejected writeText toasts a failure', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });
    s.copy('poly_secret', 'Key copied');
    await tick();
    expect(s.state.toast).toBe('Copy failed — select the text manually');
  });

  it('a successful writeText toasts the success message and writes the text', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    s.copy('poly_secret', 'Key copied');
    await tick();
    expect(writeText).toHaveBeenCalledWith('poly_secret');
    expect(s.state.toast).toBe('Key copied');
  });
});

describe('E12.4 — the setup guide does not wipe an existing default-tier chain', () => {
  it('appends the new model, preserving the existing chain (not a single-element replace)', async () => {
    const tiers: TierDto[] = [
      { id: 'tier-default', key: 'default', displayName: 'Default', description: null, createdAt: NOW },
    ];
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      tiers,
      tierEntries: {
        'tier-default': [mkEntry('tier-default', 'keep-1', 0), mkEntry('tier-default', 'keep-2', 1)],
      },
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('ob', 'prov', { ...LOCAL_FORM });
    await s.obConnectProvider();

    expect(s.state.ob.done2).toBe(true);
    const args = fake.lastArgs('replaceTierEntries');
    const sent = args?.[1] as string[];
    // The existing chain is preserved and the new model is appended (not wiped to 1).
    expect(sent.slice(0, 2)).toEqual(['keep-1', 'keep-2']);
    expect(sent.length).toBe(3);
    expect(sent.length).not.toBe(1);
  });

  it('a fresh (empty) default tier still gets the single assigned model', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION }); // default tier, no entries
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('ob', 'prov', { ...LOCAL_FORM });
    await s.obConnectProvider();
    const sent = fake.lastArgs('replaceTierEntries')?.[1] as string[];
    expect(sent.length).toBe(1);
  });

  it('is single-flight — a call while busy2 is set is a no-op (no duplicate provider)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('ob', 'prov', { ...LOCAL_FORM });
    s.setState('ob', 'busy2', true); // a submit is already in flight
    await s.obConnectProvider();
    expect(fake.calls).not.toContain('createProvider');
  });

  it('a full (5-entry) default tier surfaces an error instead of a phantom assignment', async () => {
    const full = ['a', 'b', 'c', 'd', 'e'].map((m, i) => mkEntry('tier-default', m, i));
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      tierEntries: { 'tier-default': full },
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('ob', 'prov', { ...LOCAL_FORM });
    await s.obConnectProvider();
    // No phantom "assigned" success; the existing chain is untouched (no write).
    expect(s.state.ob.done2).toBe(false);
    expect(s.state.ob.error2).toMatch(/already has 5 models/i);
    expect(fake.calls).not.toContain('replaceTierEntries');
  });
});
