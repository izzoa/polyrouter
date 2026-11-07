import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type AdminUserDto,
  type AgentDto,
  type BatchJobDto,
  type BudgetDto,
  type CalibrationEvent,
  type ChannelDto,
  type KeyPresetDto,
  type ModelDto,
  type ProviderDto,
  type SemanticLearningStatus,
  type TierDto,
  type TierEntryDto,
} from '../data/api';
import {
  buildRequestRows,
  DEFAULT_CALIBRATION,
  DEFAULT_SEMANTIC_LEARNING_STATUS,
  DEFAULT_SESSION,
  FakeApiClient,
  UNRECORDED_HEALTH,
  type FakeOptions,
} from '../test/fakeClient';
import type { ProviderForm } from '../types';
import { FROM_DIALOG, PROVIDER_KINDS, createAppStore, type AppStore } from './appState';
import { onSubscriptionConnect as onSubscriptionConnectFor } from './fieldChecks';

describe('setup-guide dismissal', () => {
  it('dismisses, persists per browser, and honors the stored flag on the next boot', () => {
    localStorage.removeItem('polyrouter-setup-dismissed');
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    expect(s.state.setupDismissed).toBe(false);
    s.dismissSetupGuide();
    expect(s.state.setupDismissed).toBe(true);
    expect(localStorage.getItem('polyrouter-setup-dismissed')).toBe('1');
    // A fresh store (new page load) starts dismissed.
    const s2 = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    expect(s2.state.setupDismissed).toBe(true);
    localStorage.removeItem('polyrouter-setup-dismissed');
  });
});

describe('PROVIDER_KINDS', () => {
  it("no kind labels its CREDENTIAL input 'Base URL' (the form has a dedicated Base URL field)", () => {
    // Regression: custom/local once carried field:'Base URL', so the API-key input
    // rendered as a second Base URL field in the provider modal.
    for (const k of PROVIDER_KINDS) {
      expect(k.field).not.toBe('Base URL');
      expect(k.ph.startsWith('http')).toBe(false); // placeholders are key-shaped, not URLs
    }
  });
});

const NOW = '2026-07-15T00:00:00.000Z';
/** Let a fire-and-forget optimistic persist settle (macrotask after microtasks). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A ModelDto for a specific provider + external id (add-model-variant-detection
 * onboarding cases); spread it to override `variant`/`baseExternalModelId`. */
function blankModel(providerId: string, id: string, externalModelId: string): ModelDto {
  return { ...mkModel(id), providerId, externalModelId };
}

function mkModel(id: string): ModelDto {
  return {
    id,
    providerId: 'p1',
    externalModelId: `ext-${id}`,
    displayName: null,
    // contextWindow omitted: absent = unknown (honest-model-capabilities)
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
    listedPrice: null,
    variant: null,
    baseExternalModelId: null,
    batchCapable: true,
    batchEffectivePrice: null,
    lastSyncedAt: null,
    unlistedSince: null,
  };
}
/** The model ids of the confirmed baseline for a tier. It stores `{modelId, mode}`
 * since add-batch-mode-routing, so a rollback restores reservations as well as
 * order; these assertions are about ORDER. */
function confirmedIds(
  s: { state: { confirmedEntries: Record<string, { modelId: string }[]> } },
  tierId: string,
): string[] | undefined {
  return s.state.confirmedEntries[tierId]?.map((e) => e.modelId);
}

/** The model ids of the LAST chain replacement sent. The wire carries
 * `{modelId, mode}` since add-batch-mode-routing; these assertions are about ORDER,
 * so they read the ids off it rather than pinning the payload shape. */
function sentIds(f: { lastArgs: (m: string) => unknown[] | undefined }): string[] | undefined {
  const args = f.lastArgs('replaceTierEntries');
  if (args === undefined) return undefined;
  return (args[1] as { modelId: string }[]).map((e) => e.modelId);
}

function mkEntry(
  tierId: string,
  modelId: string,
  position: number,
  mode: 'any' | 'batch' = 'any',
): TierEntryDto {
  return { id: `e-${modelId}`, tierId, modelId, position, mode, model: null };
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
  firstByteTimeoutS: '',
  idleTimeoutS: '',
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
    form: Omit<ProviderForm, 'firstByteTimeoutS' | 'idleTimeoutS'> &
      Partial<Pick<ProviderForm, 'firstByteTimeoutS' | 'idleTimeoutS'>>,
  ): Promise<void> {
    s.openModal('newProvider');
    s.setState('np', { firstByteTimeoutS: '', idleTimeoutS: '', ...form });
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
    // Endpoint/kind/protocol stay pinned; the patience overrides ride along
    // (fix-long-call-timeouts impl-Med-2 — blank = clear-to-inherit null).
    expect(patch).toEqual({ name: 'My ChatGPT', firstByteTimeoutMs: null, idleTimeoutMs: null });
    expect(s.state.providers.find((p) => p.id === row.id)?.name).toBe('My ChatGPT');

    // The SO-1 credential rules still apply on the locked form: an explicit clear
    // sends credential:'' (convert/clear), still without kind/protocol/baseUrl.
    s.openEditProvider(s.state.providers.find((p) => p.id === row.id)!);
    s.setState('np', 'clearCredential', true);
    await s.addProvider();
    const clearPatch = fake.lastArgs('updateProvider')?.[1] as Record<string, unknown>;
    expect(clearPatch).toEqual({
      name: 'My ChatGPT',
      credential: '',
      firstByteTimeoutMs: null,
      idleTimeoutMs: null,
    });

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
    // The guidance reports on the paste field (adopt-design-tokens-v2 task 8.2), which the
    // attempt clears: credential material never survives one.
    expect(s.state.fieldErrors['f-ow-paste']).toContain('code#state');
    expect(s.state.ow.error).toBeNull();
    expect(s.state.ow.pasted).toBe('');
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
    fake.oauthCompleteRejects = new ApiError(
      422,
      'Unprocessable',
      'sign-in state mismatch — restart connect',
    );
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

  // add-provider-health-signals (task 8.6): a reconnect verifies itself — ONE Test,
  // with the card's checking state held from its start until it settles.
  async function connectedStore(fake: FakeApiClient) {
    const s = createAppStore(fake);
    await s.bootstrap();
    s.openModal('newProvider');
    s.setState('np', 'kind', 'sub');
    await s.startOauthConnect('claude');
    s.setState('ow', 'pasted', 'the-code#st');
    await s.completeOauthConnect();
    return s;
  }

  it('a first connect runs no Test', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    await connectedStore(fake);
    expect(fake.calls).not.toContain('testProvider');
  });

  it.each([
    ['succeeds', true],
    ['fails', false],
  ])('a reconnect runs exactly one Test and shows checking until it %s', async (_label, ok) => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = await connectedStore(fake);
    const provider = s.state.providers.find((p) => p.oauthPreset === 'claude')!;
    let settle!: () => void;
    const held = new Promise<void>((r) => {
      settle = r;
    });
    const realTest = fake.testProvider.bind(fake);
    const testSpy = vi.spyOn(fake, 'testProvider').mockImplementation(async (id: string) => {
      await held;
      if (!ok) throw new ApiError(503, 'Unavailable', 'provider unavailable');
      return realTest(id);
    });
    await s.startOauthReauthorize(provider);
    s.setState('ow', 'pasted', 'code#st-re');
    const done = s.completeOauthConnect();
    await tick();
    expect(s.state.reconnectChecking).toContain(provider.id);
    settle();
    await done;
    expect(s.state.reconnectChecking).not.toContain(provider.id);
    expect(testSpy).toHaveBeenCalledTimes(1);
    expect(testSpy).toHaveBeenCalledWith(provider.id);
  });

  it('a Test reloads the list so the card carries the recorded health, not just the status', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      testResult: {
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
      name: 'p',
      kind: 'api',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1',
      credential: 'sk-x',
    });
    const id = s.state.providers[0]!.id;
    const before = fake.callLog.length;
    await s.testProviderById(id);
    const after = fake.callLog.slice(before).map((c) => c.method);
    expect(after).toEqual(['testProvider', 'listProviders']);
    expect(s.state.providers[0]!.health).toMatchObject({
      state: 'error',
      kind: 'auth',
      message: 'authentication failed',
      source: 'test',
    });
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
    expect(sentIds(fake)?.length).toBe(1);

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

  it('assigns the first ROUTABLE model when the catalog lists a batch twin first', async () => {
    // add-model-variant-detection: an aggregator can return the twin first, and
    // assigning it would make this guide's own final `model:"auto"` call fail on
    // the chain the guide just built.
    const twinFirst = (providerId: string) => [
      {
        ...blankModel(providerId, 'm-twin', 'openai/gpt-6-astra:batch'),
        variant: 'batch',
        baseExternalModelId: 'openai/gpt-6-astra',
        batchCapable: true,
        batchEffectivePrice: null,
      },
      blankModel(providerId, 'm-base', 'openai/gpt-6-astra'),
    ];
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      syncResult: { ok: true, status: 'ok', message: 'synced', traceId: 't', synced: 2 },
      syncSeed: twinFirst,
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.obCreateAgent();
    setProv(s);
    await s.obConnectProvider();
    expect(s.state.ob.done2).toBe(true);
    expect(sentIds(fake)).toEqual(['m-base']); // never the twin
  });

  it('stops when a provider exposes only batch-only models', async () => {
    const twinsOnly = (providerId: string) => [
      {
        ...blankModel(providerId, 'm-twin', 'openai/gpt-6-astra:batch'),
        variant: 'batch',
        baseExternalModelId: null,
        batchCapable: true,
        batchEffectivePrice: null,
      },
    ];
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      syncResult: { ok: true, status: 'ok', message: 'synced', traceId: 't', synced: 1 },
      syncSeed: twinsOnly,
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.obCreateAgent();
    setProv(s);
    await s.obConnectProvider();
    expect(s.state.ob.done2).toBe(false);
    expect(s.state.ob.error2).toMatch(/batch-priced/i);
    expect(fake.calls).not.toContain('replaceTierEntries');
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
    expect(sentIds(fake)).toEqual(['m3', 'm1', 'm2']);
  });

  it('adds a model (appended modelIds) and caps at 5 with a toast', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    s.addTierModel('t1', 'm4');
    await tick();
    expect(sentIds(fake)).toEqual(['m1', 'm2', 'm3', 'm4']);
    s.addTierModel('t1', 'm5');
    await tick();
    expect(s.state.tierEntries['t1']).toHaveLength(5);
    s.addTierModel('t1', 'm6');
    expect(s.state.toast).toEqual({ kind: 'failure', text: 'Max 5 models per tier' });
    expect(s.state.tierEntries['t1']).toHaveLength(5);
    await tick();
  });

  it('removes a model and persists the shortened modelIds', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    s.removeTierModel('t1', 'm2');
    await tick();
    expect(sentIds(fake)).toEqual(['m1', 'm3']);
  });

  it('sets a fallback as primary (position 0)', async () => {
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    s.setPrimaryTierModel('t1', 'm3');
    await tick();
    expect(sentIds(fake)).toEqual(['m3', 'm1', 'm2']);
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
    expect(fake.lastArgs('setAutoLayers')?.[0]).toEqual({
      structural: false,
      cascade: false,
      semantic: false,
    });
    expect(s.state.autoLayers?.structural).toBe(false);
    await s.toggleAutoLayer('cascade');
    expect(fake.lastArgs('setAutoLayers')?.[0]).toEqual({
      structural: true,
      cascade: true,
      semantic: false,
    });
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
        semantic: false,
        semanticAvailable: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: DEFAULT_CALIBRATION,
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
    // Blocked on the Apprise field itself (adopt-design-tokens-v2 task 8.2).
    expect(s.state.fieldErrors['f-cf-apprise']).toBe(
      'Changing the kind to Apprise requires at least one URL',
    );
    expect(s.state.cf.error).toBeNull();
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
    expect(confirmedIds(s, 't1')).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
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
    expect(confirmedIds(s, 't1')).toEqual(['m1', 'm2', 'm3']);
  });

  it('serializes auto-layer toggles: a failed earlier PUT never loses the newer toggle (#2)', async () => {
    const fake = routingFake();
    fake.deferAutoLayers = true;
    const s = createAppStore(fake);
    await s.loadRouting();
    await s.toggleAutoLayer('structural'); // desired {structural:false, cascade:false, semantic:false}
    await s.toggleAutoLayer('structural'); // desired {structural:true, cascade:false, semantic:false}
    expect(fake.autoLayersQueue).toHaveLength(1);
    expect(fake.autoLayersQueue[0]?.input).toEqual({
      structural: false,
      cascade: false,
      semantic: false,
    });
    fake.autoLayersQueue[0]?.settle('reject');
    await tick();
    expect(fake.autoLayersQueue).toHaveLength(2);
    expect(fake.autoLayersQueue[1]?.input).toEqual({
      structural: true,
      cascade: false,
      semantic: false,
    });
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
    expect(confirmedIds(s, 't1')).toEqual(['m1', 'm2', 'm3', 'm4']);
    // The stale GET now resolves — it must NOT clobber the just-persisted state.
    fake.gateReads = false;
    fake.openGate();
    await reload;
    expect(confirmedIds(s, 't1')).toEqual(['m1', 'm2', 'm3', 'm4']);
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
    // Only the original stale read stays held; mutation reconciliation can read
    // the new server configuration before refreshing progress.
    fake.gateReads = false;
    await s.saveBudget(); // adds b1, bumps budgetsSeq
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
    expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Tier deleted' });
    fake.tierWriteQueue[0]?.settle('reject');
    await tick();
    expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Tier deleted' }); // no 404/error toast for the retired write
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
    expect(s.state.toast).toEqual({
      kind: 'failure',
      text: 'Copy failed — select the text manually',
    });
  });

  it('a rejected writeText toasts a failure', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });
    s.copy('poly_secret', 'Key copied');
    await tick();
    expect(s.state.toast).toEqual({
      kind: 'failure',
      text: 'Copy failed — select the text manually',
    });
  });

  it('a successful writeText toasts the success message and writes the text', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    s.copy('poly_secret', 'Key copied');
    await tick();
    expect(writeText).toHaveBeenCalledWith('poly_secret');
    expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Key copied' });
  });
});

describe('E12.4 — the setup guide does not wipe an existing default-tier chain', () => {
  it('appends the new model, preserving the existing chain (not a single-element replace)', async () => {
    const tiers: TierDto[] = [
      {
        id: 'tier-default',
        key: 'default',
        displayName: 'Default',
        description: null,
        createdAt: NOW,
      },
    ];
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      tiers,
      tierEntries: {
        'tier-default': [
          mkEntry('tier-default', 'keep-1', 0),
          mkEntry('tier-default', 'keep-2', 1),
        ],
      },
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('ob', 'prov', { ...LOCAL_FORM });
    await s.obConnectProvider();

    expect(s.state.ob.done2).toBe(true);
    const sent = sentIds(fake) ?? [];
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
    const sent = sentIds(fake) ?? [];
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

describe('auto-performance range race (add-auto-performance-view r3-High-1)', () => {
  it('a slow older-range response never overwrites the newer range data', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const resolvers: ((v: Awaited<ReturnType<FakeApiClient['autoPerformance']>>) => void)[] = [];
    const base = fake.autoPerfResult;
    fake.autoPerformance = (range, bucket) => {
      void range;
      void bucket;
      return new Promise((resolve) => resolvers.push(resolve));
    };
    const s = createAppStore(fake);
    const first = s.loadAutoPerf(); // 7d request, held open
    // Range change clears stale data AND issues the 30d request itself
    // (fix-auto-perf-stale-card: the section no longer refires on `loaded`).
    s.setAutoPerfRange('30d');
    expect(s.state.autoPerf.loaded).toBe(false);
    expect(resolvers.length).toBe(2);
    // The newer (30d) request resolves first…
    resolvers[1]!({ ...base, evaluated: 999 });
    await tick();
    expect(s.state.autoPerf.data?.evaluated).toBe(999);
    expect(s.state.autoPerf.range).toBe('30d');
    // …then the stale 7d response lands and must be DROPPED.
    resolvers[0]!({ ...base, evaluated: 1 });
    await first;
    expect(s.state.autoPerf.data?.evaluated).toBe(999);
    expect(s.state.autoPerf.loaded).toBe(true);
  });

  it('switching ranges clears stale data so the loading state shows', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.loadAutoPerf();
    expect(s.state.autoPerf.data).not.toBeNull();
    s.setAutoPerfRange('24h');
    expect(s.state.autoPerf.data).toBeNull();
    expect(s.state.autoPerf.loaded).toBe(false);
    expect(s.state.autoPerf.error).toBeNull();
  });
});

describe('auto-performance retry (redesign-auto-routing-pipeline 4.2)', () => {
  type AutoPerfResult = Awaited<ReturnType<FakeApiClient['autoPerformance']>>;

  /** Hold every aggregation request open; the test settles each one by hand. */
  function holdAutoPerf(fake: FakeApiClient) {
    const pending: { resolve: (v: AutoPerfResult) => void; reject: (e: unknown) => void }[] = [];
    fake.autoPerformance = () =>
      new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return pending;
  }

  it('a failed load, then a retry, commits the new data — showing Loading, not the stale figures, meanwhile', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const base = fake.autoPerfResult;
    const s = createAppStore(fake);
    s.setAutoPerfRange('30d');
    await tick();
    expect(s.state.autoPerf.data?.evaluated).toBe(base.evaluated);

    // A later refetch fails: the loader keeps the old data beside the error.
    fake.analyticsFailure = new ApiError(504, 'Gateway Timeout', 'timeout');
    await s.loadAutoPerf();
    expect(s.state.autoPerf.error).not.toBeNull();
    expect(s.state.autoPerf.data).not.toBeNull();

    fake.analyticsFailure = null;
    const pending = holdAutoPerf(fake);
    const retry = s.retryAutoPerf();
    // In flight: no error, and no figure from the earlier load presented as current.
    expect(s.state.autoPerf.error).toBeNull();
    expect(s.state.autoPerf.data).toBeNull();
    expect(s.state.autoPerf.loaded).toBe(false);
    // …for the range that was selected, not a reset one.
    expect(s.state.autoPerf.range).toBe('30d');
    expect(pending).toHaveLength(1);

    pending[0]!.resolve({ ...base, evaluated: 777 });
    await retry;
    expect(s.state.autoPerf.data?.evaluated).toBe(777);
    expect(s.state.autoPerf.error).toBeNull();
    expect(s.state.autoPerf.loaded).toBe(true);
    expect(s.state.autoPerf.range).toBe('30d');
  });

  it('a retry that fails again shows the failure again', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    fake.analyticsFailure = new ApiError(504, 'Gateway Timeout', 'timeout');
    const s = createAppStore(fake);
    await s.loadAutoPerf();
    expect(s.state.autoPerf.error).not.toBeNull();
    await s.retryAutoPerf();
    expect(fake.calls.filter((c) => c === 'autoPerformance')).toHaveLength(2);
    expect(s.state.autoPerf.error).not.toBeNull();
    expect(s.state.autoPerf.data).toBeNull();
    expect(s.state.autoPerf.loaded).toBe(true);
  });

  it('an older in-flight response landing after the retry never overwrites it', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const base = fake.autoPerfResult;
    const pending = holdAutoPerf(fake);
    const s = createAppStore(fake);
    const first = s.loadAutoPerf(); // held open
    const retry = s.retryAutoPerf(); // the newer request
    expect(pending).toHaveLength(2);

    pending[1]!.resolve({ ...base, evaluated: 999 });
    await retry;
    expect(s.state.autoPerf.data?.evaluated).toBe(999);

    // The superseded request lands last — as data, and as a failure — and is dropped.
    pending[0]!.resolve({ ...base, evaluated: 1 });
    await first;
    expect(s.state.autoPerf.data?.evaluated).toBe(999);

    const second = s.loadAutoPerf();
    const retry2 = s.retryAutoPerf();
    pending[3]!.resolve({ ...base, evaluated: 500 });
    await retry2;
    pending[2]!.reject(new ApiError(500, 'Internal', 'late failure'));
    await second;
    expect(s.state.autoPerf.data?.evaluated).toBe(500);
    expect(s.state.autoPerf.error).toBeNull();
  });
});

describe('identity-scoped cache isolation (add-auto-threshold-calibration r3-High-1)', () => {
  it('sign-out clears calibration history, auto-layers, and auto-perf caches', async () => {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      calibrationEvents: [
        {
          id: 'e1',
          trigger: 'calibrator',
          oldHigh: 0.6,
          oldLow: 0.25,
          newHigh: 0.58,
          newLow: 0.25,
          anchorHigh: 0.6,
          anchorLow: 0.25,
          windowFrom: null,
          windowTo: null,
          edge: 'high',
          edgeSamples: 57,
          edgeFailures: 43,
          reason: 'r',
          createdAt: '2026-07-19T04:00:00.000Z',
        },
      ],
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.loadCalHistory();
    await s.loadAutoPerf();
    expect(s.state.calHistory.rows).toHaveLength(1);
    expect(s.state.autoPerf.data).not.toBeNull();
    await s.signOut();
    // Tenant A's metadata never survives into the next account's session.
    expect(s.state.calHistory).toEqual({ rows: [], loaded: false, error: null });
    expect(s.state.autoPerf.data).toBeNull();
    expect(s.state.autoLayers).toBeNull();
  });

  it('an in-flight history response from the previous account is discarded', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    let release: (v: never[]) => void = () => {};
    fake.calibrationHistory = () => new Promise((resolve) => (release = resolve));
    const s = createAppStore(fake);
    const inflight = s.loadCalHistory(); // captured under account A
    await s.signOut(); // identity generation bumps
    release([]); // A's response lands late
    await inflight;
    expect(s.state.calHistory.loaded).toBe(false); // never committed
  });
});

describe('workload-target actions (add-workload-routing)', () => {
  const codeRule = {
    id: 'r-code',
    matchType: 'auto_workload',
    workloadClass: 'code',
    headerName: 'x-polyrouter-tier',
    headerValue: null,
    target: 'tier:coding',
    priority: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
  };
  const bandRule = {
    ...codeRule,
    id: 'r-high',
    matchType: 'auto_high',
    workloadClass: null,
    target: 'tier:premium',
  };
  const idle = (over: Partial<Record<string, boolean>> = {}) => ({
    code: false,
    research: false,
    vision: false,
    structured: false,
    writing: false,
    ...over,
  });

  it('setWorkloadTarget PATCHes the effective rule of THAT class — never a second rule, never a band rule', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [codeRule, bandRule] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [codeRule, bandRule]);
    await s.setWorkloadTarget('code', 'tier:cheap');
    expect(fake.calls).toContain('updateRule');
    expect(fake.calls.filter((c) => c === 'createRule')).toHaveLength(0);
    const wl = s.state.rules.filter((r) => r.matchType === 'auto_workload');
    expect(wl).toHaveLength(1);
    expect(wl[0]).toMatchObject({ workloadClass: 'code', target: 'tier:cheap' });
    expect(s.state.rules.find((r) => r.id === 'r-high')!.target).toBe('tier:premium'); // untouched
    expect(s.state.wt).toEqual({
      busy: idle(),
      errors: {
        ...idle(),
        ...{ code: null, research: null, vision: null, structured: null, writing: null },
      },
      unverified: false,
    });
  });

  it('setWorkloadTarget creates an auto_workload rule carrying the class when unset; display commits via the reconcile', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [] });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.setWorkloadTarget('vision', 'tier:cheap');
    expect(fake.calls).toContain('createRule');
    expect(fake.calls).toContain('listRules');
    const created = s.state.rules.find((r) => r.matchType === 'auto_workload');
    expect(created).toMatchObject({
      workloadClass: 'vision',
      target: 'tier:cheap',
      headerValue: null,
    });
  });

  it('a failed write reconciles and reports a ROW error for that class only — no optimistic lie', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [codeRule] });
    fake.updateRule = () => Promise.reject(new ApiError(422, 'Unprocessable', 'bad target'));
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [codeRule]);
    await s.setWorkloadTarget('code', 'tier:cheap');
    expect(s.state.rules[0]!.target).toBe('tier:coding'); // unchanged truth
    expect(s.state.wt.errors.code).toMatch(/bad target/);
    expect(s.state.wt.errors.vision).toBeNull();
    expect(s.state.wt.unverified).toBe(false);
  });

  it('write ok + reconcile failed → unverified disables workload actions until a retry heals it', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [codeRule] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [codeRule]);
    let failList = true;
    const realList = fake.listRules.bind(fake);
    fake.listRules = () =>
      failList ? Promise.reject(new ApiError(500, 'Internal', 'list down')) : realList();
    await s.setWorkloadTarget('code', 'tier:cheap');
    expect(s.state.wt.unverified).toBe(true);
    await s.setWorkloadTarget('vision', 'tier:cheap'); // every class is disabled while unverified
    expect(fake.calls.filter((c) => c === 'createRule')).toHaveLength(0);
    failList = false;
    await s.retryRulesReconcile();
    expect(s.state.wt.unverified).toBe(false);
    expect(s.state.rules[0]!.target).toBe('tier:cheap');
  });

  it('clearWorkload deletes every snapshot rule of the class and reconciles; cleanWorkloadShadowed keeps only the effective one', async () => {
    const shadowed = { ...codeRule, id: 'r-code-2', priority: -1 };
    const vision = { ...codeRule, id: 'r-vis', workloadClass: 'vision' };
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      rules: [codeRule, shadowed, vision],
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [codeRule, shadowed, vision]);
    await s.cleanWorkloadShadowed('code');
    expect(s.state.rules.filter((r) => r.workloadClass === 'code').map((r) => r.id)).toEqual([
      'r-code',
    ]);
    await s.clearWorkload('code');
    expect(s.state.rules.filter((r) => r.workloadClass === 'code')).toHaveLength(0);
    expect(s.state.rules.filter((r) => r.workloadClass === 'vision')).toHaveLength(1); // other class untouched
  });

  it('`unverified` is monotonic across concurrent classes: a definitive rejection + failed reconcile never clears a sibling’s landed-but-unverified write (clink r5 M2)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [] });
    // Every reconcile fails for the duration of the race.
    fake.listRules = () => Promise.reject(new ApiError(500, 'Internal', 'list down'));
    // code: the write LANDS immediately; vision: the write is HELD, then definitively rejected.
    let releaseVision: () => void = () => undefined;
    const visionHeld = new Promise<void>((r) => (releaseVision = r));
    const realCreate = fake.createRule.bind(fake);
    fake.createRule = async (input) => {
      if (input.workloadClass === 'vision') {
        await visionHeld;
        throw new ApiError(422, 'Unprocessable', 'bad target');
      }
      return realCreate(input);
    };
    const s = createAppStore(fake);
    await s.bootstrap();
    const vision = s.setWorkloadTarget('vision', 'tier:cheap'); // starts first, finishes LAST
    await s.setWorkloadTarget('code', 'tier:cheap'); // lands; reconcile fails → unverified TRUE
    expect(s.state.wt.unverified).toBe(true);
    releaseVision();
    await vision; // definitive 422 + failed reconcile — must NOT write `false`
    expect(s.state.wt.unverified).toBe(true);
    expect(s.state.wt.errors.vision).toMatch(/bad target/);
    expect(s.state.wt.errors.code).toBeNull();
  });

  it('per-class single-flight: a second write on the same class is blocked; another class proceeds', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [] });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const realCreate = fake.createRule.bind(fake);
    let first = true;
    fake.createRule = async (input) => {
      if (first) {
        first = false;
        await held;
      }
      return realCreate(input);
    };
    const s = createAppStore(fake);
    await s.bootstrap();
    const a = s.setWorkloadTarget('code', 'tier:cheap'); // held in flight
    const dupe = s.setWorkloadTarget('code', 'tier:premium'); // same class → blocked
    await s.setWorkloadTarget('vision', 'tier:cheap'); // other class → allowed
    release();
    await Promise.all([a, dupe]);
    const wl = s.state.rules.filter((r) => r.matchType === 'auto_workload');
    expect(wl.map((r) => r.workloadClass).sort()).toEqual(['code', 'vision']);
    expect(wl.find((r) => r.workloadClass === 'code')!.target).toBe('tier:cheap');
  });
});

describe('band-target actions with a class SCOPE (add-workload-scoped-bands)', () => {
  const mk = (over: Partial<Record<string, unknown>>) => ({
    id: 'r',
    matchType: 'auto_high',
    workloadClass: null,
    headerName: 'x-polyrouter-tier',
    headerValue: null,
    target: 'tier:premium',
    priority: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  });
  const generic = mk({ id: 'g' });
  const codeHigh = mk({ id: 'ch', workloadClass: 'code', target: 'tier:cheap' });
  const codeHighDupe = mk({ id: 'ch2', workloadClass: 'code', target: 'tier:cheap', priority: -1 });
  const visionHigh = mk({ id: 'vh', workloadClass: 'vision', target: 'tier:cheap' });

  it('a scoped set creates the band rule WITH the class and never retargets the generic rule', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [generic] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [generic]);
    await s.setBandTarget('auto_high', 'tier:cheap', 'code');
    expect(fake.calls).toContain('createRule');
    expect(fake.calls.filter((c) => c === 'updateRule')).toHaveLength(0);
    const created = s.state.rules.find((r) => r.workloadClass === 'code');
    expect(created).toMatchObject({ matchType: 'auto_high', target: 'tier:cheap' });
    expect(s.state.rules.find((r) => r.id === 'g')!.target).toBe('tier:premium'); // generic untouched
    // a second scoped set retargets the scoped effective rule — still no second rule for the class
    await s.setBandTarget('auto_high', 'tier:premium', 'code');
    expect(
      s.state.rules.filter((r) => r.matchType === 'auto_high' && r.workloadClass === 'code'),
    ).toHaveLength(1);
    // a GENERIC set retargets only the generic rule
    await s.setBandTarget('auto_high', 'tier:cheap');
    expect(s.state.rules.find((r) => r.id === 'g')!.target).toBe('tier:cheap');
    expect(s.state.rules.find((r) => r.workloadClass === 'code')!.target).toBe('tier:premium');
  });

  it('clear and cleanup are (band, scope) operations — other scopes and the generic rules survive', async () => {
    const rules = [generic, codeHigh, codeHighDupe, visionHigh];
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', rules);
    await s.cleanShadowed('auto_high', 'code');
    expect(s.state.rules.map((r) => r.id).sort()).toEqual(['ch', 'g', 'vh']); // only the code duplicate went
    await s.clearBand('auto_high', 'code');
    expect(s.state.rules.map((r) => r.id).sort()).toEqual(['g', 'vh']); // generic + vision survive
    await s.clearBand('auto_high'); // generic clear leaves the vision scope
    expect(s.state.rules.map((r) => r.id)).toEqual(['vh']);
  });
});

describe('band-target actions (add-band-target-ui)', () => {
  const highRule = {
    id: 'r-high',
    matchType: 'auto_high',
    workloadClass: null,
    headerName: 'x-polyrouter-tier',
    headerValue: null,
    target: 'tier:premium',
    priority: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
  };

  it('setBandTarget PATCHes the effective rule when one exists — never a second rule', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [highRule] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [highRule]); // the Routing page's loaded snapshot
    await s.setBandTarget('auto_high', 'tier:cheap');
    expect(fake.calls).toContain('updateRule');
    expect(fake.calls.filter((c) => c === 'createRule')).toHaveLength(0);
    expect(s.state.rules.filter((r) => r.matchType === 'auto_high')).toHaveLength(1);
    expect(s.state.rules[0]!.target).toBe('tier:cheap');
    expect(s.state.bt).toEqual({
      busy: { auto_high: false, auto_low: false },
      errors: { auto_high: null, auto_low: null },
      errorScope: { auto_high: null, auto_low: null },
      unverified: false,
    });
  });

  it('setBandTarget creates when unset, and the display commits only via the reconcile', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [] });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.setBandTarget('auto_low', 'tier:cheap');
    expect(fake.calls).toContain('createRule');
    expect(fake.calls).toContain('listRules'); // the authoritative re-list ran
    expect(s.state.rules.some((r) => r.matchType === 'auto_low')).toBe(true);
  });

  it('a failed write reconciles and reports a row error — no optimistic lie', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [highRule] });
    fake.updateRule = () => Promise.reject(new ApiError(422, 'Unprocessable', 'bad target'));
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [highRule]);
    await s.setBandTarget('auto_high', 'tier:cheap');
    expect(s.state.rules[0]!.target).toBe('tier:premium'); // unchanged truth
    expect(s.state.bt.errors.auto_high).toMatch(/bad target/);
    expect(s.state.bt.errorScope.auto_high).toBeNull(); // a GENERIC write's error
    expect(s.state.bt.unverified).toBe(false); // reconcile succeeded — state IS verified
  });

  it('a failed SCOPED write reports its error under its scope — the generic row stays clean (add-workload-scoped-bands)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [highRule] });
    fake.createRule = () => Promise.reject(new ApiError(422, 'Unprocessable', 'bad scoped target'));
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [highRule]);
    await s.setBandTarget('auto_high', 'tier:cheap', 'code'); // no code rule yet → create → rejected
    expect(s.state.bt.errors.auto_high).toMatch(/bad scoped target/);
    expect(s.state.bt.errorScope.auto_high).toBe('code'); // attributed to the code row
    expect(s.state.rules).toHaveLength(1); // nothing landed; the generic rule is untouched
    // A later successful GENERIC write clears both the message and its scope.
    await s.setBandTarget('auto_high', 'tier:cheap');
    expect(s.state.bt.errors.auto_high).toBeNull();
    expect(s.state.bt.errorScope.auto_high).toBeNull();
  });

  it('write ok + reconcile failed → the visible unverified state disables actions until retry', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [highRule] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [highRule]);
    let failList = true;
    const realList = fake.listRules.bind(fake);
    fake.listRules = () =>
      failList ? Promise.reject(new ApiError(500, 'Internal', 'list down')) : realList();
    await s.setBandTarget('auto_high', 'tier:cheap');
    expect(s.state.bt.unverified).toBe(true); // routing may have changed; we cannot confirm
    // Snapshot-dependent actions are disabled while unverified.
    await s.setBandTarget('auto_high', 'tier:premium');
    expect(fake.calls.filter((c) => c === 'updateRule')).toHaveLength(1);
    // Retry heals.
    failList = false;
    await s.retryRulesReconcile();
    expect(s.state.bt.unverified).toBe(false);
    expect(s.state.rules[0]!.target).toBe('tier:cheap'); // the landed write, now confirmed
  });

  it('`unverified` is monotonic across the two bands: a definitive rejection + failed reconcile never clears the other band’s landed-but-unverified write (fix-band-unverified-monotonic)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [] });
    // Every reconcile fails for the duration of the race.
    fake.listRules = () => Promise.reject(new ApiError(500, 'Internal', 'list down'));
    // auto_high: the write LANDS immediately; auto_low: HELD, then definitively rejected.
    let releaseLow: () => void = () => undefined;
    const lowHeld = new Promise<void>((r) => (releaseLow = r));
    const realCreate = fake.createRule.bind(fake);
    fake.createRule = async (input) => {
      if (input.matchType === 'auto_low') {
        await lowHeld;
        throw new ApiError(422, 'Unprocessable', 'bad target');
      }
      return realCreate(input);
    };
    const s = createAppStore(fake);
    await s.bootstrap();
    const low = s.setBandTarget('auto_low', 'tier:cheap'); // starts first, finishes LAST
    await s.setBandTarget('auto_high', 'tier:premium'); // lands; reconcile fails → unverified TRUE
    expect(s.state.bt.unverified).toBe(true);
    releaseLow();
    await low; // definitive 422 + failed reconcile — must NOT write `false`
    expect(s.state.bt.unverified).toBe(true);
    expect(s.state.bt.errors.auto_low).toMatch(/bad target/);
    expect(s.state.bt.errors.auto_high).toBeNull();
    // Snapshot-dependent actions stay disabled until an authoritative re-list commits:
    // the follow-up must issue NO rule mutation — from this stale EMPTY snapshot an
    // unblocked retry would CREATE (a duplicate), so count every mutation kind, not
    // just updates (codex: update-only counting could not detect the duplicate path).
    const mutations = () =>
      fake.calls.filter((c) => c === 'createRule' || c === 'updateRule' || c === 'deleteRule')
        .length;
    const before = mutations();
    expect(fake.calls.filter((c) => c === 'createRule')).toHaveLength(1); // the high write only
    await s.setBandTarget('auto_high', 'tier:cheap');
    expect(mutations()).toBe(before);
    expect(fake.calls.filter((c) => c === 'updateRule')).toHaveLength(0);
  });

  it('clearBand deletes every snapshot rule of the band and reconciles', async () => {
    const shadowed = { ...highRule, id: 'r-high-2', priority: -1 };
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [highRule, shadowed] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [highRule, shadowed]);
    await s.clearBand('auto_high');
    expect(fake.calls.filter((c) => c === 'deleteRule')).toHaveLength(2);
    expect(s.state.rules.filter((r) => r.matchType === 'auto_high')).toHaveLength(0);
  });

  it('cleanShadowed removes only the non-effective rules', async () => {
    const winner = { ...highRule, id: 'r-win', priority: 9 };
    const shadowed = { ...highRule, id: 'r-shadow', priority: 0 };
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [winner, shadowed] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [winner, shadowed]);
    await s.cleanShadowed('auto_high');
    const remaining = s.state.rules.filter((r) => r.matchType === 'auto_high');
    expect(remaining.map((r) => r.id)).toEqual(['r-win']);
  });

  it('latest-wins: an older reconcile never overwrites a newer one (header-during-band)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [] });
    const s = createAppStore(fake);
    await s.bootstrap();
    // Hold the FIRST list open; let the second complete with newer truth.
    const realList = fake.listRules.bind(fake);
    let release: () => void = () => {};
    let first = true;
    fake.listRules = () => {
      if (first) {
        first = false;
        return new Promise((resolve) => {
          release = () => {
            void realList().then(resolve);
          };
        });
      }
      return realList();
    };
    const bandOp = s.setBandTarget('auto_low', 'tier:cheap'); // starts reconcile #1 (held)
    await new Promise((r) => setTimeout(r, 0));
    await s.retryRulesReconcile(); // reconcile #2 — newest, commits
    const after = s.state.rules.length;
    release(); // stale #1 lands late — must be DROPPED
    await bandOp;
    expect(s.state.rules.length).toBe(after);
  });

  it('a superseded reconcile never reports success — unverified only clears on a COMMIT (r3-High-1)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [highRule] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [highRule]);
    // The band mutation writes OK, but its reconcile is held; a NEWER
    // reconcile then FAILS — the band op must defer to that newest outcome
    // and stay unverified, not report its own stale success.
    const realList = fake.listRules.bind(fake);
    let call = 0;
    let releaseFirst: () => void = () => {};
    fake.listRules = () => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => void realList().then(resolve);
        });
      }
      return Promise.reject(new ApiError(500, 'Internal', 'list down'));
    };
    const op = s.setBandTarget('auto_high', 'tier:cheap'); // write ok; reconcile #1 held
    await new Promise((r) => setTimeout(r, 0));
    await s.retryRulesReconcile(); // reconcile #2 — newest, FAILS
    releaseFirst(); // stale #1 resolves late; superseded → must not verify
    await op;
    expect(s.state.bt.unverified).toBe(true);
  });

  it('a successful full loadRouting verifies and cannot be overwritten by a stale reconcile (r3-High-2)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [highRule] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [highRule]);
    s.setState('bt', 'unverified', true);
    await s.loadRouting();
    expect(s.state.bt.unverified).toBe(false); // authoritative full read verified
    expect(s.state.rules.some((r) => r.id === 'r-high')).toBe(true);
  });

  it('a header-rule create during band state converges via the shared reconcile discipline', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [] });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.setBandTarget('auto_low', 'tier:cheap');
    // A header rule created through the header action lands in the SAME
    // converged rules state (its reconcile re-lists everything).
    s.setState('rf', { value: 'heavy', target: 'cheap', busy: false, error: null });
    await s.createRule();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.state.rules.some((r) => r.matchType === 'header')).toBe(true);
    expect(s.state.rules.some((r) => r.matchType === 'auto_low')).toBe(true);
  });

  it('clearBand aborts on a failed delete — the remainder stays visible and errored', async () => {
    const shadowed = { ...highRule, id: 'r-high-2', priority: -1 };
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [highRule, shadowed] });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.setState('rules', [highRule, shadowed]);
    let deletes = 0;
    const realDelete = fake.deleteRule.bind(fake);
    fake.deleteRule = (id: string) => {
      deletes += 1;
      if (deletes === 2) return Promise.reject(new ApiError(500, 'Internal', 'delete failed'));
      return realDelete(id);
    };
    await s.clearBand('auto_high');
    expect(s.state.bt.errors.auto_high).toMatch(/delete failed/);
    expect(s.state.rules.filter((r) => r.matchType === 'auto_high')).toHaveLength(1); // truthful remainder
  });

  it('busy is PER BAND: the same band is single-flight while the other stays free', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION, rules: [] });
    const s = createAppStore(fake);
    await s.bootstrap();
    let releaseCreate: () => void = () => {};
    const realCreate = fake.createRule.bind(fake);
    let held = false;
    fake.createRule = (input) => {
      if (!held && input.matchType === 'auto_high') {
        held = true;
        return new Promise((resolve) => {
          releaseCreate = () => void realCreate(input).then(resolve);
        });
      }
      return realCreate(input);
    };
    const first = s.setBandTarget('auto_high', 'tier:cheap'); // held in flight
    await new Promise((r) => setTimeout(r, 0));
    const dupe = s.setBandTarget('auto_high', 'tier:premium'); // same band → blocked
    await dupe;
    await s.setBandTarget('auto_low', 'tier:cheap'); // other band → allowed
    expect(s.state.rules.some((r) => r.matchType === 'auto_low')).toBe(true);
    releaseCreate();
    await first;
    const highs = s.state.rules.filter((r) => r.matchType === 'auto_high');
    expect(highs).toHaveLength(1); // the blocked duplicate never wrote
    expect(highs[0]!.target).toBe('tier:cheap');
  });
});

describe('pricing-catalog slice (add-pricing-refresh-ui)', () => {
  it('loads status, refreshes with a +N toast, and re-fetches — single-flight', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.loadPricingStatus();
    expect(s.state.pc.status?.lastRefresh).toBeNull(); // never refreshed
    await s.runPricingRefresh();
    expect(fake.calls.filter((c) => c === 'pricingRefresh')).toHaveLength(1);
    expect(s.state.pc.status?.lastRefresh?.added).toBe(124); // re-fetched truth
    expect(s.state.pc.busy).toBe(false);
    expect(s.state.toast).toEqual({ kind: 'confirm', text: '+124 price versions' });
  });

  it('a failed refresh reports inline and leaves the status untouched', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    fake.pricingRefresh = () => Promise.reject(new ApiError(502, 'BadGateway', 'source down'));
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.loadPricingStatus();
    await s.runPricingRefresh();
    expect(s.state.pc.refreshError).toMatch(/source down/); // refresh error, NOT the load error
    expect(s.state.pc.status?.lastRefresh).toBeNull(); // unchanged truth
    expect(s.state.pc.busy).toBe(false);
  });

  it('an identity change orphans a pending refresh — no toast, no writes (r1-Med-5)', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    let release: () => void = () => {};
    const real = fake.pricingRefresh.bind(fake);
    fake.pricingRefresh = () =>
      new Promise((resolve) => {
        release = () => void real().then(resolve);
      });
    const s = createAppStore(fake);
    await s.bootstrap();
    await s.loadPricingStatus();
    const pending = s.runPricingRefresh(); // held in flight
    await s.signOut(); // identity bump + pc reset
    release();
    await pending;
    expect(s.state.pc).toEqual({
      status: null,
      loaded: false,
      loadError: null,
      refreshError: null,
      busy: false,
    });
    expect(s.state.toast?.text).not.toBe('+124 price versions');
  });
});

describe('Routing-page tab state (redesign-auto-routing-pipeline)', () => {
  it('starts on Tiers & headers and remembers an explicit choice', () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    expect(s.state.routingSection).toBe('tiers');
    s.setRoutingSection('auto');
    expect(s.state.routingSection).toBe('auto');
    s.setRoutingSection('tiers');
    expect(s.state.routingSection).toBe('tiers');
  });

  it('a reverted drag repaints the chain from server truth and writes nothing', async () => {
    // The chains unmount on a tab switch while the page — and its loaded routing —
    // lives on, so nothing reloads to correct a half-dragged order. `revert` does.
    const fake = routingFake();
    const s = createAppStore(fake);
    await s.loadRouting();
    const ids = (): string[] => (s.state.tierEntries['t1'] ?? []).map((e) => e.modelId);

    // No server response during the hold: server truth is the confirmed baseline.
    s.beginTierDrag('t1');
    s.moveTierEntry('t1', 0, 2); // the drag's local, unwritten move
    expect(ids()).toEqual(['m2', 'm3', 'm1']);
    s.endTierDrag('t1', 'revert');
    expect(ids()).toEqual(['m1', 'm2', 'm3']);

    // A refresh that lands during the hold is deferred — and is the truth to repaint.
    fake.tierEntries['t1'] = [mkEntry('t1', 'm3', 0), mkEntry('t1', 'm1', 1)];
    s.beginTierDrag('t1');
    s.moveTierEntry('t1', 0, 1);
    await s.loadRouting();
    expect(ids()).toEqual(['m2', 'm1', 'm3']); // held: the visible chain is untouched
    s.endTierDrag('t1', 'revert');
    expect(ids()).toEqual(['m3', 'm1']);
    expect(fake.calls).not.toContain('replaceTierEntries');

    // `abandon` keeps its contract: it discards without repainting.
    s.beginTierDrag('t1');
    s.moveTierEntry('t1', 0, 1);
    s.endTierDrag('t1', 'abandon');
    expect(ids()).toEqual(['m1', 'm3']);
  });
});

describe('card loaders survive section churn (section-routing-rail D8)', () => {
  // Self-calibration and Semantic learning fetch on FIRST MOUNT. Sectioning the
  // rail made that mount repeatable: flipping to Tuning, away, and back starts a
  // second GET while the first is still open. Without a guard the loser decides.
  const mkCalEvent = (id: string): CalibrationEvent => ({
    id,
    trigger: 'calibrator',
    oldHigh: 0.6,
    oldLow: 0.25,
    newHigh: 0.62,
    newLow: 0.24,
    anchorHigh: 0.6,
    anchorLow: 0.25,
    windowFrom: null,
    windowTo: null,
    edge: 'high',
    edgeSamples: 40,
    edgeFailures: 2,
    reason: 'edge drift',
    createdAt: NOW,
  });

  it('a REJECTED older calibration-history load leaves the newer rows in place', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const pending: { resolve: (v: CalibrationEvent[]) => void; reject: (e: unknown) => void }[] =
      [];
    fake.calibrationHistory = () =>
      new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const s = createAppStore(fake);
    const first = s.loadCalHistory(); // Tuning opened…
    const second = s.loadCalHistory(); // …closed and reopened
    expect(pending.length).toBe(2);
    pending[1]!.resolve([mkCalEvent('e2')]);
    await second;
    expect(s.state.calHistory.rows.map((r) => r.id)).toEqual(['e2']);
    // The superseded request now fails. Its error must be dropped — otherwise the
    // card swaps good rows for "couldn't load" on a purely cosmetic tab flip.
    pending[0]!.reject(new Error('aborted'));
    await first;
    expect(s.state.calHistory.error).toBeNull();
    expect(s.state.calHistory.rows.map((r) => r.id)).toEqual(['e2']);
    expect(s.state.calHistory.loaded).toBe(true);
  });

  it('a REJECTED older learning-status load leaves the newer status in place', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const pending: {
      resolve: (v: SemanticLearningStatus) => void;
      reject: (e: unknown) => void;
    }[] = [];
    fake.semanticLearningStatus = () =>
      new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const s = createAppStore(fake);
    const first = s.loadSemanticLearning();
    const second = s.loadSemanticLearning();
    expect(pending.length).toBe(2);
    pending[1]!.resolve({ ...DEFAULT_SEMANTIC_LEARNING_STATUS, generation: 7 });
    await second;
    expect(s.state.semLearn.status?.generation).toBe(7);
    pending[0]!.reject(new Error('aborted'));
    await first;
    expect(s.state.semLearn.error).toBeNull();
    expect(s.state.semLearn.status?.generation).toBe(7);
    expect(s.state.semLearn.loaded).toBe(true);
  });

  it('a status GET that lands AFTER a revert does not restore the learned state', async () => {
    // The counter is a GENERATION over every `semLearn` writer, not just the
    // loader: the revert's response is authoritative, so a GET opened before it
    // must not resurrect `source: learned` afterwards.
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const resolvers: ((v: SemanticLearningStatus) => void)[] = [];
    fake.semanticLearningStatus = () => new Promise((resolve) => resolvers.push(resolve));
    fake.semanticLearningRevert = () =>
      Promise.resolve({ ...DEFAULT_SEMANTIC_LEARNING_STATUS, epoch: 1, source: 'bundled' });
    const s = createAppStore(fake);
    const inFlight = s.loadSemanticLearning(); // started when Tuning opened
    await s.revertSemanticLearning(); // the user reverts while it is still open
    expect(s.state.semLearn.status?.source).toBe('bundled');
    resolvers[0]!({
      ...DEFAULT_SEMANTIC_LEARNING_STATUS,
      source: 'learned',
      generation: 3,
      freshHigh: 12,
    });
    await inFlight;
    expect(s.state.semLearn.status?.source).toBe('bundled');
    expect(s.state.semLearn.status?.freshHigh).toBe(0);
    expect(s.state.semLearn.status?.epoch).toBe(1);
  });
});

// ── adopt-red-destructive-actions task 3.2 ──────────────────────────────────────────────────

describe("the inspector's retained record (add-docked-inspector task 3.1, design D7)", () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** A signed-in store on Requests, page 1 loaded (25 of the fake's 30 rows). */
  async function onRequests(): Promise<{ s: AppStore; fake: FakeApiClient }> {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.bootstrap();
    s.go('requests');
    await s.loadRequests(true);
    expect(s.state.requestList).toHaveLength(25);
    return { s, fake };
  }
  /** The fake's copy of `id` rewritten with a new routing reason — what a later read returns. */
  function reword(fake: FakeApiClient, id: string, reason: string): void {
    fake.requestRows = fake.requestRows.map((r) =>
      r.id === id ? { ...r, routingReason: reason } : r,
    );
  }

  it('captures the loaded row on select: the request list first, then the Overview card', async () => {
    const { s } = await onRequests();
    s.select('req-003');
    expect(s.state.selId).toBe('req-003');
    expect(s.state.selRecord).toEqual(s.state.requestList[3]);

    await s.loadRecentRequests();
    s.setState('requestList', []);
    s.select('req-002'); // only the Overview card's six rows hold it now
    expect(s.state.selRecord?.id).toBe('req-002');
    expect(s.state.selRecord).toEqual(s.state.recentRequests[2]);
  });

  it('an id found in neither list captures no record, never the previous one', async () => {
    const { s } = await onRequests();
    s.select('req-003');
    s.select('no-such-request');
    expect(s.state.selId).toBe('no-such-request');
    expect(s.state.selRecord, 'the previous record was kept for another id').toBeNull();
    // The SAME id, no longer loaded, keeps its record: re-selecting does not close it.
    s.select('req-004');
    s.setState({ requestList: [], recentRequests: [] });
    s.select('req-004');
    expect(s.state.selRecord?.id).toBe('req-004');
  });

  it('captures on every step, from the selection or from a given row, and nothing at a bound', async () => {
    const { s } = await onRequests();
    s.select('req-003');
    expect(s.stepSelection('next')).toBe('req-004');
    expect(s.state.selId).toBe('req-004');
    expect(s.state.selRecord).toEqual(s.state.requestList[4]);
    expect(s.stepSelection('previous', 'req-010'), 'from the focused row, not the selection').toBe(
      'req-009',
    );
    expect(s.state.selRecord?.id).toBe('req-009');
    s.select('req-024'); // the last loaded row
    expect(s.stepSelection('next')).toBeNull();
    expect(s.state.selRecord?.id, 'a bound changed the selection').toBe('req-024');
  });

  it('a later load replaces it with the newer same-id row: the refresh, a filter reset, load-more and the Overview reload', async () => {
    const { s, fake } = await onRequests();
    s.select('req-003');
    reword(fake, 'req-003', 'refreshed');
    await s.refreshRequestsPage();
    expect(s.state.selRecord?.routingReason, 'the background refresh').toBe('refreshed');

    reword(fake, 'req-003', 'refiltered');
    s.setFilter('auto'); // `structural`: still listed under Auto
    await settle();
    expect(s.state.selRecord?.routingReason, 'the reset after a filter change').toBe('refiltered');
    s.setFilter('all');
    await settle();

    // Load more: the record is on page 2 only.
    await s.loadRequests(false);
    s.select('req-027');
    await s.loadRequests(true); // back to page 1, which does not hold it
    expect(s.state.selRecord?.id).toBe('req-027');
    reword(fake, 'req-027', 'appended');
    await s.loadRequests(false);
    expect(s.state.selRecord?.routingReason, 'load-more').toBe('appended');

    await s.loadRecentRequests();
    s.select('req-001');
    reword(fake, 'req-001', 'recent');
    await s.loadRecentRequests();
    expect(s.state.selRecord?.routingReason, 'the Overview reload').toBe('recent');
  });

  it('absence never clears it: a refresh that drops the row, a filter that excludes it, a failed read', async () => {
    const { s, fake } = await onRequests();
    s.select('req-020');
    const kept = { ...s.state.selRecord };
    // Ten newer requests push it off page 1.
    fake.requestRows = [
      ...buildRequestRows(10).map((r) => ({ ...r, id: `new-${r.id}` })),
      ...fake.requestRows,
    ];
    await s.refreshRequestsPage();
    expect(s.state.requestList.some((r) => r.id === 'req-020')).toBe(false);
    expect(s.state.selRecord, 'newer rows closed the record').toEqual(kept);

    s.select('req-003'); // `structural`
    s.setFilter('explicit');
    await settle();
    expect(s.state.requestList.some((r) => r.id === 'req-003')).toBe(false);
    expect(s.state.selRecord?.id, 'a filter closed the record').toBe('req-003');

    fake.analyticsFailure = new ApiError(500, 'Internal', 'requests down');
    await s.refreshRequestsPage();
    expect(s.state.requestList).toEqual([]);
    expect(s.state.selRecord?.id, 'a failed read closed the record').toBe('req-003');

    // And a load never OPENS one.
    fake.analyticsFailure = null;
    s.select(null);
    await s.refreshRequestsPage();
    expect(s.state.selRecord).toBeNull();
  });

  for (const how of ['select(null)', 'a page change', 'an identity change'] as const) {
    it(`is cleared with the selection and the payload text by ${how}`, async () => {
      const { s } = await onRequests();
      s.select('req-005');
      await s.loadSelectedBodies('req-005');
      expect(s.state.selBodies.rows, 'the payload did not load').not.toBeNull();
      expect(s.state.selRecord?.id).toBe('req-005');
      if (how === 'select(null)') s.select(null);
      else if (how === 'a page change') s.go('overview');
      else await s.signOut();
      expect(s.state.selId).toBeNull();
      expect(s.state.selRecord).toBeNull();
      expect(s.state.selBodies, 'the cached payload text survived').toEqual({
        rows: null,
        loading: false,
        error: null,
      });
    });
  }
});

describe('destructive methods report to the shared dialog (adopt-red-destructive-actions 3.2, D6)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const D_AGENT: AgentDto = {
    id: 'a1',
    name: 'ci-bot',
    harness: 'curl',
    prefix: 'poly_abcd',
    lastUsedAt: null,
    createdAt: NOW,
  };
  const D_PROVIDER: ProviderDto = {
    id: 'p1',
    name: 'homelab-vllm',
    kind: 'custom',
    protocol: 'openai_compatible',
    baseUrl: 'https://1.1.1.1/v1',
    status: 'ok',
    maxTokensSpelling: 'auto',
    hasCredential: true,
    oauthPreset: null,
    credentialExpiresAt: null,
    credentialError: null,
    firstByteTimeoutMs: null,
    idleTimeoutMs: null,
    createdAt: NOW,
    ...UNRECORDED_HEALTH,
  };
  const D_BUDGET: BudgetDto = {
    id: 'b1',
    name: 'Monthly cap',
    scope: 'global',
    agentId: null,
    amount: 25,
    window: 'month',
    action: 'alert',
    enabled: true,
    notifyChannelIds: [],
    meteringBasis: 'cash',
    createdAt: NOW,
  };
  const D_USERS: AdminUserDto[] = [
    {
      id: 'u1',
      email: 'admin@localhost',
      name: 'Admin',
      role: 'admin',
      disabled: false,
      createdAt: NOW,
    },
    {
      id: 'u2',
      email: 'bob@example.com',
      name: 'Bob',
      role: null,
      disabled: false,
      createdAt: NOW,
    },
  ];
  const D_JOB: BatchJobDto = {
    id: 'j1',
    upstreamBatchId: 'up-j1',
    status: 'in_progress',
    terminal: false,
    endpoint: '/v1/chat/completions',
    agentId: 'a1',
    providerId: 'p1',
    providerLabel: 'homelab-vllm',
    modelId: 'm1',
    modelLabel: 'qwen3-coder',
    tierAssigned: 'nightly',
    counts: { total: 50, completed: 12, failed: 0 },
    submittedAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
    reservedCeilingMicros: 25_000,
    settledCostMicros: null,
    resultsExpireAt: null,
    errorKind: null,
  };
  const UNLISTED: ModelDto = { ...mkModel('m9'), displayName: 'Old Model', unlistedSince: NOW };

  async function store(
    opts: Partial<FakeOptions> = {},
  ): Promise<{ s: AppStore; fake: FakeApiClient }> {
    const fake = new FakeApiClient({
      session: DEFAULT_SESSION,
      agents: [D_AGENT],
      providers: [D_PROVIDER],
      models: { p1: [mkModel('m1'), UNLISTED] },
      budgets: [D_BUDGET],
      channels: [mkChannel('c1', 'smtp')],
      adminUsers: D_USERS,
      batchJobs: [D_JOB],
      bodyCaptureStatus: {
        mode: 'all',
        retentionDays: 30,
        droppedCount: 0,
        lastPurgeAt: null,
        lastPurgeCount: 0,
        available: true,
        agents: [],
      },
      ...opts,
    });
    const s = createAppStore(fake);
    await s.bootstrap();
    return { s, fake };
  }

  /** The three page and card error channels a dialog failure must leave alone, set to values
   * nothing else writes, so "unwritten" is observable rather than "happens to be null". */
  function markErrors(s: AppStore): void {
    s.setState('ua', 'error', 'ua-untouched');
    s.setState('bc', 'error', 'bc-untouched');
    s.setState('selBodies', 'error', 'sel-untouched');
  }
  function expectReportedNowhereElse(s: AppStore): void {
    expect(s.state.toast, 'a dialog failure was toasted').toBeNull();
    expect(s.state.ua.error, 'ua.error was written').toBe('ua-untouched');
    expect(s.state.bc.error, 'bc.error was written').toBe('bc-untouched');
    expect(s.state.selBodies.error, 'selBodies.error was written').toBe('sel-untouched');
  }
  const boom = (reason: string): ApiError => new ApiError(409, 'Conflict', reason);

  describe('deleteAgent', () => {
    it('rejects on failure, toasts nothing, and keeps the agent', async () => {
      const { s, fake } = await store();
      await s.loadAgents();
      vi.spyOn(fake, 'deleteAgent').mockRejectedValueOnce(boom('agent is in use'));
      markErrors(s);
      await expect(s.deleteAgent(s.state.agents[0]!, FROM_DIALOG)).rejects.toThrow(
        'agent is in use',
      );
      expectReportedNowhereElse(s);
      expect(s.state.agents.map((a) => a.id)).toEqual(['a1']);
    });

    it('keeps its success toast and its list update', async () => {
      const { s } = await store();
      await s.loadAgents();
      await s.deleteAgent(s.state.agents[0]!, FROM_DIALOG);
      expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Agent ci-bot deleted' });
      expect(s.state.agents).toEqual([]);
    });

    it('still toasts a failure and resolves when called from elsewhere', async () => {
      const { s, fake } = await store();
      await s.loadAgents();
      vi.spyOn(fake, 'deleteAgent').mockRejectedValueOnce(boom('agent is in use'));
      await s.deleteAgent(s.state.agents[0]!);
      expect(s.state.toast).toEqual({ kind: 'failure', text: 'agent is in use' });
    });
  });

  describe('deleteProvider', () => {
    it('rejects on failure, toasts nothing, and keeps the provider', async () => {
      const { s, fake } = await store();
      await s.loadProviders();
      vi.spyOn(fake, 'deleteProvider').mockRejectedValueOnce(boom('provider has traffic'));
      markErrors(s);
      await expect(s.deleteProvider('p1', FROM_DIALOG)).rejects.toThrow('provider has traffic');
      expectReportedNowhereElse(s);
      expect(s.state.providers.map((p) => p.id)).toEqual(['p1']);
    });

    it('keeps its success toast and its list update', async () => {
      const { s } = await store();
      await s.loadProviders();
      await s.deleteProvider('p1', FROM_DIALOG);
      expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Provider deleted' });
      expect(s.state.providers).toEqual([]);
    });
  });

  describe('deleteBudget', () => {
    it('rejects on failure once the list is restored, toasting nothing', async () => {
      const { s, fake } = await store();
      await s.loadLimits();
      vi.spyOn(fake, 'deleteBudget').mockRejectedValueOnce(boom('budget is locked'));
      markErrors(s);
      await expect(s.deleteBudget('b1', FROM_DIALOG)).rejects.toThrow('budget is locked');
      expectReportedNowhereElse(s);
      expect(s.state.budgets.map((b) => b.id)).toEqual(['b1']);
    });

    it('keeps its success toast and its list update', async () => {
      const { s } = await store();
      await s.loadLimits();
      await s.deleteBudget('b1', FROM_DIALOG);
      expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Budget deleted' });
      expect(s.state.budgets).toEqual([]);
    });
  });

  describe('deleteChannel', () => {
    it('rejects on failure, toasts nothing, and keeps the channel', async () => {
      const { s, fake } = await store();
      await s.loadChannels();
      vi.spyOn(fake, 'deleteChannel').mockRejectedValueOnce(boom('channel is in use'));
      markErrors(s);
      await expect(s.deleteChannel('c1', FROM_DIALOG)).rejects.toThrow('channel is in use');
      expectReportedNowhereElse(s);
      expect(s.state.channels.map((c) => c.id)).toEqual(['c1']);
    });

    it('keeps its success toast and its list update', async () => {
      const { s } = await store();
      await s.loadChannels();
      await s.deleteChannel('c1', FROM_DIALOG);
      expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Channel deleted' });
      expect(s.state.channels).toEqual([]);
    });
  });

  describe('uaDeleteUser', () => {
    it('rejects on failure, writes no ua.error, and keeps the user', async () => {
      const { s, fake } = await store();
      await s.loadUserAdmin();
      vi.spyOn(fake, 'adminDeleteUser').mockRejectedValueOnce(boom('user owns the last admin'));
      markErrors(s);
      await expect(s.uaDeleteUser('u2', FROM_DIALOG)).rejects.toThrow('user owns the last admin');
      expectReportedNowhereElse(s);
      expect(s.state.ua.users.map((u) => u.id)).toEqual(['u1', 'u2']);
    });

    // The Users page reports its outcomes inline and never toasted one, so "keeps its success
    // toast" is keeping none; the list update is the reload.
    it('keeps its list update on success, and adds no toast', async () => {
      const { s } = await store();
      await s.loadUserAdmin();
      await s.uaDeleteUser('u2', FROM_DIALOG);
      expect(s.state.ua.users.map((u) => u.id)).toEqual(['u1']);
      expect(s.state.toast).toBeNull();
    });

    it('still writes ua.error and resolves when called from elsewhere', async () => {
      const { s, fake } = await store();
      await s.loadUserAdmin();
      vi.spyOn(fake, 'adminDeleteUser').mockRejectedValueOnce(boom('user owns the last admin'));
      await s.uaDeleteUser('u2');
      expect(s.state.ua.error).toBe('user owns the last admin');
    });
  });

  describe('uaSetDisabled(…, true)', () => {
    it('rejects on failure, writes no ua.error, and leaves the user enabled', async () => {
      const { s, fake } = await store();
      await s.loadUserAdmin();
      vi.spyOn(fake, 'adminSetDisabled').mockRejectedValueOnce(boom('cannot disable an owner'));
      markErrors(s);
      await expect(s.uaSetDisabled('u2', true, FROM_DIALOG)).rejects.toThrow(
        'cannot disable an owner',
      );
      expectReportedNowhereElse(s);
      expect(s.state.ua.users.find((u) => u.id === 'u2')?.disabled).toBe(false);
    });

    it('keeps its list update on success, and adds no toast', async () => {
      const { s } = await store();
      await s.loadUserAdmin();
      await s.uaSetDisabled('u2', true, FROM_DIALOG);
      expect(s.state.ua.users.find((u) => u.id === 'u2')?.disabled).toBe(true);
      expect(s.state.toast).toBeNull();
    });

    it('disabling your own account closes the dialog before the session is torn down (D8)', async () => {
      const { s } = await store();
      s.confirmDestructive({
        title: 'Disable your own account?',
        body: 'You will be signed out.',
        commitLabel: 'Disable my account',
        busyLabel: 'Disabling…',
        run: () => Promise.resolve(),
        fallbackFocus: () => null,
      });
      expect(s.state.destructive).not.toBeNull();
      const openWhenTornDown: (boolean | null)[] = [];
      const assign = vi
        .spyOn(globalThis.location, 'assign')
        .mockImplementation(() => openWhenTornDown.push(s.state.destructive !== null));
      await s.uaSetDisabled('u1', true, FROM_DIALOG);
      expect(assign).toHaveBeenCalledWith('/');
      expect(openWhenTornDown, 'the dialog was still open at the teardown').toEqual([false]);
    });

    it('disabling your own account, on failure, rejects and leaves the dialog to report it', async () => {
      const { s, fake } = await store();
      vi.spyOn(fake, 'adminSetDisabled').mockRejectedValueOnce(boom('you are the last admin'));
      const assign = vi.spyOn(globalThis.location, 'assign').mockImplementation(() => undefined);
      s.confirmDestructive({
        title: 'Disable your own account?',
        body: 'You will be signed out.',
        commitLabel: 'Disable my account',
        busyLabel: 'Disabling…',
        run: () => Promise.resolve(),
        fallbackFocus: () => null,
      });
      markErrors(s);
      await expect(s.uaSetDisabled('u1', true, FROM_DIALOG)).rejects.toThrow(
        'you are the last admin',
      );
      expectReportedNowhereElse(s);
      expect(assign).not.toHaveBeenCalled();
      expect(s.state.destructive, 'a failed self-disable closed the dialog').not.toBeNull();
    });
  });

  describe('setBodyCaptureMode("off") and purgeBodies, the capture pair', () => {
    it('setBodyCaptureMode: an API rejection rejects with its reason, no bc.error, no toast', async () => {
      const { s, fake } = await store();
      await s.loadBodyCapture();
      vi.spyOn(fake, 'bodyCaptureUpdate').mockRejectedValueOnce(
        boom('capture settings are locked'),
      );
      markErrors(s);
      await expect(s.setBodyCaptureMode('off', FROM_DIALOG)).rejects.toThrow(
        'capture settings are locked',
      );
      expectReportedNowhereElse(s);
      expect(s.state.bc.status?.mode).toBe('all');
      expect(s.state.bc.busy, 'the busy flag was left set').toBe(false);
    });

    it('setBodyCaptureMode: keeps its success toast and the status reload', async () => {
      const { s } = await store();
      await s.loadBodyCapture();
      await s.setBodyCaptureMode('off', FROM_DIALOG);
      expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Body capture off' });
      expect(s.state.bc.status?.mode).toBe('off');
      expect(s.state.bc.busy).toBe(false);
    });

    it('purgeBodies: an API rejection rejects with its reason, no bc.error, no toast', async () => {
      const { s, fake } = await store();
      await s.loadBodyCapture();
      vi.spyOn(fake, 'bodyCapturePurge').mockRejectedValueOnce(boom('purge already running'));
      markErrors(s);
      await expect(s.purgeBodies(FROM_DIALOG)).rejects.toThrow('purge already running');
      expectReportedNowhereElse(s);
      expect(s.state.bc.status?.lastPurgeAt).toBeNull();
      expect(s.state.bc.busy).toBe(false);
    });

    it('purgeBodies: keeps its success toast and the status reload', async () => {
      const { s, fake } = await store();
      await s.loadBodyCapture();
      const stored = fake.storedBodies.size;
      await s.purgeBodies(FROM_DIALOG);
      expect(s.state.toast).toEqual({
        kind: 'confirm',
        text: `Purged ${String(stored)} stored bod${stored === 1 ? 'y' : 'ies'}`,
      });
      expect(s.state.bc.status?.lastPurgeAt).not.toBeNull();
    });

    it('while another capture change is in flight, each rejects and sends nothing', async () => {
      const { s, fake } = await store();
      await s.loadBodyCapture();
      // The card's retention change, held in flight: `bc.busy` is set by the card's runner.
      let release: () => void = () => undefined;
      const update = fake.bodyCaptureUpdate.bind(fake);
      vi.spyOn(fake, 'bodyCaptureUpdate').mockImplementationOnce(
        (patch) =>
          new Promise((resolve) => {
            release = () => resolve(update(patch));
          }),
      );
      const held = s.setBodyCaptureRetention(7);
      expect(s.state.bc.busy).toBe(true);
      const updates = fake.countOf('bodyCaptureUpdate');
      const purges = fake.countOf('bodyCapturePurge');
      markErrors(s);

      await expect(s.setBodyCaptureMode('off', FROM_DIALOG)).rejects.toThrow(
        'Another body-capture change is still saving',
      );
      await expect(s.purgeBodies(FROM_DIALOG)).rejects.toThrow(
        'Another body-capture change is still saving',
      );
      expect(fake.countOf('bodyCaptureUpdate'), 'a mode change was sent while busy').toBe(updates);
      expect(fake.countOf('bodyCapturePurge'), 'a purge was sent while busy').toBe(purges);
      expectReportedNowhereElse(s);
      expect(s.state.bc.busy, 'the dialog path released the card’s busy flag').toBe(true);

      release();
      await held;
      expect(s.state.bc.busy).toBe(false);
    });

    it('the card’s own setBodyCaptureMode still writes bc.error on a failure, and resolves', async () => {
      const { s, fake } = await store();
      await s.loadBodyCapture();
      vi.spyOn(fake, 'bodyCaptureUpdate').mockRejectedValueOnce(
        boom('capture settings are locked'),
      );
      await expect(s.setBodyCaptureMode('errors_only')).resolves.toBeUndefined();
      expect(s.state.bc.error).toBe('capture settings are locked');
      expect(s.state.toast).toBeNull();
    });
  });

  describe('deleteSelectedBodies', () => {
    async function withPayload(): Promise<{ s: AppStore; fake: FakeApiClient; id: string }> {
      const { s, fake } = await store();
      await s.loadRequests(true);
      const id = s.state.requestList.find((r) => r.hasBodies)?.id;
      expect(id, 'the fixture has no row with stored bodies').toBeDefined();
      s.select(id!);
      await s.loadSelectedBodies(id!);
      expect(s.state.selBodies.rows).not.toBeNull();
      return { s, fake, id: id! };
    }

    it('rejects on failure, writes no selBodies.error, and keeps the payload', async () => {
      const { s, fake, id } = await withPayload();
      vi.spyOn(fake, 'deleteRequestBodies').mockRejectedValueOnce(boom('payload is being read'));
      markErrors(s);
      await expect(s.deleteSelectedBodies(id, FROM_DIALOG)).rejects.toThrow(
        'payload is being read',
      );
      expectReportedNowhereElse(s);
      expect(s.state.selBodies.rows).not.toBeNull();
      expect(s.state.requestList.find((r) => r.id === id)?.hasBodies).toBe(true);
    });

    it('keeps its success toast and its state update', async () => {
      const { s, id } = await withPayload();
      await s.deleteSelectedBodies(id, FROM_DIALOG);
      expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Payloads deleted' });
      expect(s.state.selBodies.rows).toBeNull();
      expect(s.state.requestList.find((r) => r.id === id)?.hasBodies).toBe(false);
    });

    // add-docked-inspector task 3.1 (design D7): a payload delete is the store's one in-place
    // row write, and no load follows it. The inspector renders its retained record, so the
    // record is patched in the same write, or the Payload section would outlive its bodies.
    it('on success the retained record no longer has bodies either', async () => {
      const { s, id } = await withPayload();
      expect(s.state.selRecord?.id).toBe(id);
      expect(s.state.selRecord?.hasBodies).toBe(true);
      await s.deleteSelectedBodies(id, FROM_DIALOG);
      expect(s.state.selRecord?.id, 'the record stays open').toBe(id);
      expect(s.state.selRecord?.hasBodies, 'the record kept its deleted bodies').toBe(false);
    });

    it('on failure the retained record keeps its bodies', async () => {
      const { s, fake, id } = await withPayload();
      vi.spyOn(fake, 'deleteRequestBodies').mockRejectedValueOnce(boom('payload is being read'));
      await expect(s.deleteSelectedBodies(id, FROM_DIALOG)).rejects.toThrow();
      expect(s.state.selRecord?.hasBodies).toBe(true);
    });

    it('with the row filtered out of both lists first, the success still patches the record', async () => {
      const { s, id } = await withPayload();
      // The list and the Overview card no longer hold the row — the record alone does.
      s.setState({ requestList: [], recentRequests: [] });
      expect(s.state.selRecord?.id).toBe(id);
      await s.deleteSelectedBodies(id, FROM_DIALOG);
      expect(s.state.selRecord?.hasBodies, 'only a listed row was patched').toBe(false);
    });

    it('a delete resolving after an account change patches no record', async () => {
      const { s, fake, id } = await withPayload();
      let release: () => void = () => {};
      vi.spyOn(fake, 'deleteRequestBodies').mockImplementationOnce(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const pending = s.deleteSelectedBodies(id, FROM_DIALOG);
      await s.signOut();
      release();
      await pending;
      expect(s.state.selRecord, 'the previous account’s record came back').toBeNull();
    });
  });

  describe('cancelBatch', () => {
    it('rejects on failure and reports it nowhere else', async () => {
      const { s, fake } = await store();
      vi.spyOn(fake, 'cancelBatch').mockRejectedValueOnce(boom('the provider refused'));
      markErrors(s);
      await expect(s.cancelBatch('j1')).rejects.toThrow('the provider refused');
      expectReportedNowhereElse(s);
      expect(fake.batchJobs[0]?.status).toBe('in_progress');
    });

    // Batches never toasted a cancel; the state update is the refreshed batch partition.
    it('keeps its state update on success: the batch read is refreshed', async () => {
      const { s, fake } = await store();
      const reads = fake.countOf('batches');
      await s.cancelBatch('j1');
      expect(fake.batchJobs[0]?.status).toBe('cancelling');
      expect(fake.countOf('batches')).toBe(reads + 1);
      expect(s.state.toast).toBeNull();
    });
  });

  describe('removeUnlistedModel, its removal step', () => {
    it('from the dialog, rejects on failure, toasts nothing, and keeps the model', async () => {
      const { s, fake } = await store();
      await s.loadModels('p1');
      const confirm = vi.fn(() => true);
      vi.stubGlobal('confirm', confirm);
      fake.removeModelRejects = boom('the model is still routed');
      markErrors(s);
      try {
        await expect(s.removeUnlistedModel('p1', UNLISTED, FROM_DIALOG)).rejects.toThrow(
          'the model is still routed',
        );
      } finally {
        vi.unstubAllGlobals();
      }
      expectReportedNowhereElse(s);
      expect(s.state.models['p1']?.map((m) => m.id)).toEqual(['m1', 'm9']);
      // Only the removal step: the impact count and the prompt belong to the trigger's call.
      expect(confirm).not.toHaveBeenCalled();
      expect(fake.countOf('listTiers')).toBe(0);
    });

    it('from the dialog, keeps its success toast and its list update', async () => {
      const { s } = await store();
      await s.loadModels('p1');
      await s.removeUnlistedModel('p1', UNLISTED, FROM_DIALOG);
      expect(s.state.toast).toEqual({ kind: 'confirm', text: 'Old Model removed' });
      expect(s.state.models['p1']?.map((m) => m.id)).toEqual(['m1']);
    });

    // adopt-red-destructive-actions task 4.2: the trigger's call no longer prompts natively.
    it('from the trigger, counts the impact and opens the shared confirmation, removing nothing', async () => {
      const { s, fake } = await store();
      await s.loadModels('p1');
      const confirm = vi.fn(() => true);
      vi.stubGlobal('confirm', confirm);
      const fallbackFocus = (): HTMLElement | null => null;
      try {
        await s.removeUnlistedModel('p1', UNLISTED, { fallbackFocus });
      } finally {
        vi.unstubAllGlobals();
      }
      expect(confirm, 'the native prompt is gone').not.toHaveBeenCalled();
      expect(fake.countOf('listTiers')).toBe(1);
      expect(fake.countOf('removeModel'), 'opening the dialog removed it').toBe(0);
      const request = s.state.destructive;
      expect(request?.title).toBe('Remove Old Model?');
      expect(request?.body).toBe(
        'The provider no longer lists it. 0 tier entries will be dropped and 0 rules will lose its target.',
      );
      expect(request?.commitLabel).toBe('Remove model');
      expect(request?.busyLabel).toBe('Removing…');
      expect(request?.fallbackFocus).toBe(fallbackFocus);
      // Its commit is the removal step: it rejects with the reason, and toasts nothing.
      fake.removeModelRejects = boom('the model is still routed');
      await expect(request!.run()).rejects.toThrow('the model is still routed');
      expect(s.state.toast).toBeNull();
      expect(s.state.models['p1']?.map((m) => m.id)).toEqual(['m1', 'm9']);
    });

    it('from the trigger, holds the one slot through its count: a second press opens nothing', async () => {
      const { s, fake } = await store();
      await s.loadModels('p1');
      const first = s.removeUnlistedModel('p1', UNLISTED);
      // Pressed again while the impact count is still in flight.
      const second = s.removeUnlistedModel('p1', UNLISTED);
      // And another destructive site opened meanwhile.
      s.confirmDestructive({
        title: 'Delete agent "ci-bot"?',
        body: 'New requests with its key will be refused.',
        commitLabel: 'Delete agent',
        busyLabel: 'Deleting…',
        run: () => Promise.resolve(),
        fallbackFocus: () => null,
      });
      expect(s.state.destructive, 'a request opened while the count held the slot').toBeNull();
      await Promise.all([first, second]);
      expect(fake.countOf('listTiers'), 'the second press counted again').toBe(1);
      expect(s.state.destructive?.title).toBe('Remove Old Model?');
    });

    it('from the trigger, still names the consequence when the count cannot be read', async () => {
      const { s, fake } = await store();
      await s.loadModels('p1');
      vi.spyOn(fake, 'listTiers').mockRejectedValueOnce(boom('tiers unavailable'));
      await s.removeUnlistedModel('p1', UNLISTED);
      expect(s.state.destructive?.body).toBe(
        'The provider no longer lists it. Any tier entries using it are dropped, and rules targeting it lose their target.',
      );
    });
  });
});

describe('key-subscription connect (add-key-subscription-presets task 9.2)', () => {
  const KEY = 'fixture-secret-key-0123456789';
  const preset = (over: Partial<KeyPresetDto> = {}): KeyPresetDto => ({
    id: 'zai-coding-plan',
    displayName: 'Z.ai GLM Coding Plan',
    regions: [
      { id: 'intl', label: 'International', host: 'api.z.ai', imitationRequired: false },
      { id: 'cn', label: 'China', host: 'open.bigmodel.cn', imitationRequired: false },
    ],
    keyHint: null,
    termsRisk: 'high',
    riskCopy: 'copy',
    termsUrl: 'https://docs.z.ai/legal-agreement/subscription-terms',
    requiresAcknowledgement: true,
    ...over,
  });
  async function open(presets: KeyPresetDto[], opts: { oauth?: boolean } = {}) {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    fake.keyPresets = presets;
    if (opts.oauth === false) fake.oauthPresets = [];
    const s = createAppStore(fake);
    await s.bootstrap();
    s.openModal('newProvider');
    await tick(); // the preset lists settle
    s.setState('np', 'kind', 'sub');
    return { fake, s };
  }
  const connects = (fake: FakeApiClient): Record<string, unknown>[] =>
    fake.callLog.filter((c) => c.method === 'keyPresetConnect').map((c) => c.args[0] as never);

  it('loads the list beside the OAuth presets, and an empty list is the failure fallback', async () => {
    const { s } = await open([preset()]);
    expect(s.state.kp.presets.map((p) => p.id)).toEqual(['zai-coding-plan']);
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    vi.spyOn(fake, 'listKeyPresets').mockRejectedValue(new ApiError(500, 'Error', 'boom'));
    const failing = createAppStore(fake);
    await failing.bootstrap();
    failing.openModal('newProvider');
    await tick();
    expect(failing.state.kp.presets).toEqual([]);
  });

  it('clears the key on success', async () => {
    const { s } = await open([preset()]);
    s.chooseKeyPreset('zai-coding-plan');
    s.setState('kp', { region: 'intl', key: KEY, ack: true });
    await s.connectKeyPreset();
    expect(s.state.kp.key).toBe('');
    expect(s.state.modal).toBeNull();
    expect(JSON.stringify(s.state)).not.toContain(KEY);
  });

  it('clears the key on a failure, keeping the form for another try', async () => {
    const { fake, s } = await open([preset()]);
    fake.keyPresetConnectRejects = new ApiError(422, 'Unprocessable', 'refused');
    s.chooseKeyPreset('zai-coding-plan');
    s.setState('kp', { region: 'intl', key: KEY, ack: true });
    await s.connectKeyPreset();
    expect(s.state.kp.key).toBe('');
    expect(s.state.kp.error).toBe('refused');
    expect(s.state.kp.preset).toBe('zai-coding-plan');
    expect(s.state.modal).toBe('newProvider');
    expect(JSON.stringify(s.state)).not.toContain(KEY);
  });

  it('clears the key on a client-side rejection, without a request', async () => {
    const { fake, s } = await open([preset()]);
    s.chooseKeyPreset('zai-coding-plan');
    // A several-region preset with no region chosen is rejected on the field.
    s.setState('kp', { key: KEY, ack: true });
    await s.connectKeyPreset();
    expect(s.state.fieldErrors['f-kp-region']).toBe('Choose a region');
    expect(s.state.kp.key).toBe('');
    expect(connects(fake)).toHaveLength(0);
  });

  it('does not connect a high-risk preset until acknowledged', async () => {
    const { fake, s } = await open([preset()]);
    s.chooseKeyPreset('zai-coding-plan');
    s.setState('kp', { region: 'intl', key: KEY });
    await s.connectKeyPreset();
    expect(connects(fake)).toHaveLength(0);
    expect(s.state.kp.key).toBe(KEY); // nothing was attempted, so nothing was cleared
  });

  it('shows the connect path with key presets only', async () => {
    const { s } = await open([preset()], { oauth: false });
    expect(s.state.ow.presets).toEqual([]);
    expect(onSubscriptionConnectFor(s.state)).toBe(true);
    const none = await open([], { oauth: false });
    expect(onSubscriptionConnectFor(none.s.state)).toBe(false);
  });

  it('never persists the slice: no browser storage write carries the key', async () => {
    const writes: string[] = [];
    // Records every write and drops it: the store tolerates storage that refuses writes.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => {
      writes.push(`${k}=${v}`);
    });
    const { s } = await open([preset()]);
    s.chooseKeyPreset('zai-coding-plan');
    s.setState('kp', { region: 'intl', key: KEY, ack: true });
    await s.connectKeyPreset();
    expect(writes.join('\n')).not.toContain(KEY);
    expect(writes.join('\n')).not.toContain('zai-coding-plan');
    spy.mockRestore();
  });

  it('a single listed region is the choice: its id is sent with no region check', async () => {
    const one = preset({
      regions: [{ id: 'intl', label: 'International', host: 'api.z.ai', imitationRequired: false }],
    });
    const { fake, s } = await open([one]);
    s.chooseKeyPreset('zai-coding-plan');
    expect(s.state.kp.region).toBe('intl');
    s.setState('kp', { key: KEY, ack: true });
    await s.connectKeyPreset();
    expect(s.state.fieldErrors['f-kp-region']).toBeUndefined();
    expect(connects(fake)).toEqual([
      {
        preset: 'zai-coding-plan',
        region: 'intl',
        credential: KEY,
        acknowledgeTermsRisk: true,
      },
    ]);
    expect(s.state.toast?.text).toContain('connected — sync models to start routing');
  });

  it('an imitation-required connect says to turn imitation on in Edit', async () => {
    const needs = preset({
      regions: [{ id: 'intl', label: 'International', host: 'api.z.ai', imitationRequired: true }],
    });
    const { s } = await open([needs]);
    s.chooseKeyPreset('zai-coding-plan');
    s.setState('kp', { key: KEY, ack: true });
    await s.connectKeyPreset();
    expect(s.state.toast?.text).toContain('turn on identity imitation in its Edit dialog');
    expect(s.state.toast?.text).not.toContain('sync models');
  });

  it('sends only a trimmed, non-empty name and the acknowledgement only where required', async () => {
    const low = preset({ termsRisk: 'low', requiresAcknowledgement: false });
    const { fake, s } = await open([low]);
    s.chooseKeyPreset('zai-coding-plan');
    s.setState('kp', { region: 'cn', key: `  ${KEY}  `, name: '   ' });
    await s.connectKeyPreset();
    expect(connects(fake)).toEqual([{ preset: 'zai-coding-plan', region: 'cn', credential: KEY }]);
  });

  it('closing the modal discards the form and its key', async () => {
    const { s } = await open([preset()]);
    s.chooseKeyPreset('zai-coding-plan');
    s.setState('kp', { region: 'intl', key: KEY });
    s.closeModal();
    expect(s.state.kp.key).toBe('');
    expect(s.state.kp.preset).toBeNull();
    expect(s.state.kp.presets).toHaveLength(1); // the offered list stays loaded
  });
});
