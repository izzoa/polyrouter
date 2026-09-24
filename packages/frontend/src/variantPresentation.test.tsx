// add-model-variant-detection, frontend presentation (tasks 6.2/6.3).
//
// The rule under test is an honesty rule in two directions: a batch twin must not
// look selectable (it cannot serve), and it must not vanish either (the provider
// lists it, and its rate is real information). Both halves are asserted here.
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { groupModelsByProvider, nonRoutableNote } from './pages/Routing';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient, UNRECORDED_HEALTH } from './test/fakeClient';
import type { ModelDto, ProviderDto } from './data/api';

const NOW = '2026-09-04T00:00:00.000Z';

const mkModel = (over: Partial<ModelDto> & Pick<ModelDto, 'id' | 'externalModelId'>): ModelDto => ({
  providerId: 'p-or',
  displayName: null,
  // contextWindow omitted: absent = unknown (honest-model-capabilities)
  supportsTools: false,
  supportsVision: false,
  supportsReasoning: false,
  isFree: false,
  inputPricePer1m: null,
  outputPricePer1m: null,
  effectivePrice: null,
  listedPrice: null,
  variant: null,
  baseExternalModelId: null,
  batchCapable: true,
  batchEffectivePrice: null,
  lastSyncedAt: NOW,
  unlistedSince: null,
  ...over,
});

const TWIN = mkModel({
  id: 'm-twin',
  externalModelId: 'openai/gpt-6-astra:batch',
  variant: 'batch',
  baseExternalModelId: 'openai/gpt-6-astra',
  batchCapable: true,
  batchEffectivePrice: null,
  effectivePrice: {
    inputPricePer1m: 5,
    outputPricePer1m: 25,
    isFree: false,
    source: 'listed',
    estimated: true,
  },
});
const BASE = mkModel({
  id: 'm-base',
  externalModelId: 'openai/gpt-6-astra',
  effectivePrice: {
    inputPricePer1m: 10,
    outputPricePer1m: 50,
    isFree: false,
    source: 'listed',
    estimated: true,
  },
});
const ORPHAN = mkModel({
  id: 'm-orphan',
  externalModelId: 'anthropic/claude-opus-5:batch',
  variant: 'batch',
  baseExternalModelId: null,
  batchCapable: true,
  batchEffectivePrice: null,
});
const FREE = mkModel({ id: 'm-free', externalModelId: 'meta/llama:free', variant: 'free' });

const PROVIDER: ProviderDto = {
  id: 'p-or',
  name: 'OpenRouter',
  kind: 'api_key',
  protocol: 'openai_compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}

async function mountProviders(models: ModelDto[]): Promise<Harness> {
  globalThis.history.replaceState(null, '', '/#/providers');
  const fake = new FakeApiClient({
    session: DEFAULT_SESSION,
    providers: [PROVIDER],
    models: { 'p-or': models },
  });
  const store = createAppStore(fake);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  await store.loadModels('p-or');
  await flush();
  return { host, store, dispose };
}

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h?.host.remove();
  h = null;
});

describe('Providers page — a batch twin is a price, not a model', () => {
  it('folds the twin into its base row as a batch rate, with no row of its own', async () => {
    h = await mountProviders([TWIN, BASE, FREE]);
    const toggle = [...h.host.querySelectorAll('button')].find((b) =>
      /^Models$/.test(b.textContent ?? ''),
    );
    toggle?.click();
    await flush();
    const text = h.host.textContent ?? '';

    // The twin's rate is shown ON the base model's row...
    const rate = h.host.querySelector('[data-batch-rate="openai/gpt-6-astra"]');
    expect(rate).not.toBeNull();
    expect(rate?.textContent).toMatch(/batch/i);
    expect(rate?.textContent).toMatch(/not routable/i);
    // ...and the base model is still listed as a normal model.
    expect(text).toContain('openai/gpt-6-astra');
    // A routable variant is untouched.
    expect(text).toContain('meta/llama:free');
  });

  it('keeps an orphan twin visible but marked unusable, never hidden', async () => {
    h = await mountProviders([ORPHAN]);
    const toggle = [...h.host.querySelectorAll('button')].find((b) =>
      /^Models$/.test(b.textContent ?? ''),
    );
    toggle?.click();
    await flush();
    const row = h.host.querySelector('[data-orphan-batch="anthropic/claude-opus-5:batch"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toMatch(/batch-only/i);
    // Hiding a model the provider lists would be the same dishonesty from the
    // other direction.
    expect(h.host.textContent).toContain('anthropic/claude-opus-5:batch');
  });
});

describe('routing target pickers exclude what cannot serve', () => {
  it('drops batch twins from the picker groups and keeps routable variants', () => {
    const groups = groupModelsByProvider(
      [TWIN, BASE, FREE, ORPHAN],
      [{ id: 'p-or', name: 'OpenRouter' }],
    );
    const ids = groups.flatMap((g) => g.models.map((m) => m.externalModelId));
    expect(ids).toContain('openai/gpt-6-astra');
    expect(ids).toContain('meta/llama:free');
    expect(ids).not.toContain('openai/gpt-6-astra:batch');
    expect(ids).not.toContain('anthropic/claude-opus-5:batch');
  });
});

describe('a stored target that became non-routable is surfaced, not just hidden', () => {
  it('names the base model as the correction when there is one', () => {
    expect(nonRoutableNote(TWIN)).toContain('openai/gpt-6-astra');
    expect(nonRoutableNote(TWIN)).toMatch(/batch-only/i);
  });

  it('tells the user to remove an orphan rather than pointing at a model that is absent', () => {
    expect(nonRoutableNote(ORPHAN)).toMatch(/remove/i);
  });

  it('says nothing about a routable model', () => {
    expect(nonRoutableNote(BASE)).toBeNull();
    expect(nonRoutableNote(FREE)).toBeNull();
    expect(nonRoutableNote(null)).toBeNull();
  });
});
