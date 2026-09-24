/**
 * Models the provider no longer lists (add-live-subscription-models, task 5.5).
 *
 * The flag is information, not an alarm: routing still dispatches an unlisted model,
 * so the dashboard must SAY it (in words, never colour alone) wherever the model is
 * chosen or routed to — the Providers models list, the model picker, tier chains and
 * rule targets — and offer a Remove that states its consequences before it acts.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { offeredFirstGroups } from './components/ModelPicker';
import { unlistedText } from './data/unlisted';
import { unlistedNote } from './pages/Routing';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient, UNRECORDED_HEALTH } from './test/fakeClient';
import { ApiError, type ModelDto, type ProviderDto, type TierDto } from './data/api';

const NOW = '2026-09-24T12:00:00.000Z';
const RETIRED_AT = '2026-09-22T09:00:00.000Z';

const mkModel = (id: string, over: Partial<ModelDto> = {}): ModelDto => ({
  id,
  providerId: 'p-gpt',
  externalModelId: id,
  displayName: null,
  isFree: false,
  inputPricePer1m: null,
  outputPricePer1m: null,
  effectivePrice: null,
  listedPrice: null,
  variant: null,
  baseExternalModelId: null,
  batchCapable: false,
  batchEffectivePrice: null,
  lastSyncedAt: NOW,
  unlistedSince: null,
  ...over,
});

const RETIRED = mkModel('gpt-5.4-mini', { unlistedSince: RETIRED_AT });
const OFFERED_A = mkModel('gpt-6-luna');
const OFFERED_B = mkModel('gpt-6-sol');

const PROVIDER: ProviderDto = {
  id: 'p-gpt',
  name: 'OpenAI',
  kind: 'subscription',
  protocol: 'openai_responses',
  baseUrl: 'https://chatgpt.com/',
  status: 'ok',
  maxTokensSpelling: 'auto',
  hasCredential: true,
  oauthPreset: 'chatgpt',
  credentialExpiresAt: null,
  credentialError: null,
  firstByteTimeoutMs: null,
  idleTimeoutMs: null,
  createdAt: NOW,
  ...UNRECORDED_HEALTH,
};

const TIER: TierDto = {
  id: 't1',
  key: 'default',
  displayName: null,
  description: null,
  createdAt: NOW,
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
}

async function mount(
  models: ModelDto[],
  opts: {
    tierModels?: string[];
    ruleTargets?: string[];
    route?: 'providers' | 'routing';
    matchType?: string;
  } = {},
): Promise<Harness> {
  globalThis.history.replaceState(null, '', '/#/providers');
  const fake = new FakeApiClient({
    session: DEFAULT_SESSION,
    providers: [PROVIDER],
    models: { 'p-gpt': models },
    tiers: [TIER],
    tierEntries: {
      t1: (opts.tierModels ?? []).map((modelId, position) => ({
        id: `e-${modelId}`,
        tierId: 't1',
        modelId,
        position,
        mode: 'any' as const,
        model: { id: modelId, providerId: 'p-gpt', externalModelId: modelId, displayName: null },
      })),
    },
    rules: (opts.ruleTargets ?? []).map((target, i) => ({
      id: `r${String(i)}`,
      matchType: opts.matchType ?? 'header',
      headerName: 'x-polyrouter-tier',
      headerValue: (opts.matchType ?? 'header') === 'header' ? `v${String(i)}` : null,
      workloadClass: null,
      target,
      priority: 0,
      createdAt: NOW,
    })),
  });
  const store = createAppStore(fake);
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  if (opts.route === 'routing') {
    store.go('routing');
    await flush();
    await flush();
  } else {
    await store.loadModels('p-gpt');
    await flush();
    const toggle = [...host.querySelectorAll('button')].find((b) =>
      /^Models$/.test(b.textContent ?? ''),
    );
    toggle?.click();
    await flush();
  }
  return { host, store, fake };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Providers page — a model the provider stopped listing', () => {
  it('reads "no longer offered" in words, sorts after offered models, and alone offers Remove', async () => {
    const h = await mount([RETIRED, OFFERED_A, OFFERED_B]);
    const row = h.host.querySelector('[data-unlisted="gpt-5.4-mini"]');
    expect(row).not.toBeNull();
    const line = row!.querySelector('[data-unlisted-line]')!;
    expect(line.textContent).toMatch(/No longer offered by the provider/);
    // The calendar date rides in the accessible name, not only a relative time.
    expect(line.getAttribute('aria-label')).toContain(new Date(RETIRED_AT).toLocaleDateString());
    // Offered models first, in the server's order; the retired one last.
    const text = h.host.textContent ?? '';
    expect(text.indexOf('gpt-6-luna')).toBeLessThan(text.indexOf('gpt-5.4-mini'));
    expect(text.indexOf('gpt-6-sol')).toBeLessThan(text.indexOf('gpt-5.4-mini'));
    // Remove exists ONLY on the unlisted row.
    const removes = [...h.host.querySelectorAll('button')].filter((b) =>
      /^Remove$/.test(b.textContent ?? ''),
    );
    expect(removes).toHaveLength(1);
    expect(removes[0]!.getAttribute('aria-label')).toBe('Remove gpt-5.4-mini');
  });

  it('Remove states how many tier entries and rules it affects, and only then deletes', async () => {
    const h = await mount([RETIRED, OFFERED_A], {
      tierModels: ['gpt-6-luna', 'gpt-5.4-mini'],
      ruleTargets: ['model:gpt-5.4-mini', 'tier:default'],
    });
    const confirm = vi.fn<(message: string) => boolean>().mockReturnValueOnce(false);
    vi.stubGlobal('confirm', confirm);
    const remove = (): void =>
      [...h.host.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Remove gpt-5.4-mini')!
        .click();
    remove();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatch(
      /1 tier entry will be dropped and 1 rule will lose its target/,
    );
    // Declined: nothing sent, the row stays.
    expect(h.fake.callLog.some((c) => c.method === 'removeModel')).toBe(false);
    expect(h.host.querySelector('[data-unlisted="gpt-5.4-mini"]')).not.toBeNull();

    confirm.mockReturnValueOnce(true);
    remove();
    await flush();
    expect(h.fake.callLog.filter((c) => c.method === 'removeModel')).toHaveLength(1);
    expect(h.host.querySelector('[data-unlisted="gpt-5.4-mini"]')).toBeNull();
    expect(h.host.textContent).toContain('gpt-6-luna');
  });

  it('a refused removal says why and leaves the list unchanged', async () => {
    const h = await mount([RETIRED, OFFERED_A]);
    h.fake.removeModelRejects = new ApiError(
      409,
      'conflict',
      'the provider still lists this model',
    );
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    [...h.host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Remove gpt-5.4-mini')!
      .click();
    await flush();
    expect(h.host.querySelector('[data-unlisted="gpt-5.4-mini"]')).not.toBeNull();
    expect(h.host.textContent).toMatch(/Couldn’t remove gpt-5\.4-mini/);
  });
});

describe('Providers page — an unlisted batch twin says so on the rate line', () => {
  it('marks the twin folded into its base row', async () => {
    const base = mkModel('vendor/model');
    const twin = mkModel('vendor/model:batch', {
      variant: 'batch',
      baseExternalModelId: 'vendor/model',
      unlistedSince: RETIRED_AT,
    });
    const h = await mount([base, twin]);
    const mark = h.host.querySelector('[data-unlisted-twin="vendor/model:batch"]');
    expect(mark?.textContent).toMatch(/no longer offered/);
    expect(mark?.textContent).toContain(new Date(RETIRED_AT).toLocaleDateString()); // sr-only date
  });
});

describe('Routing page — anything routed to an unlisted model says so', () => {
  it('warns on the tier-chain entry and on a model: rule, naming the provider', async () => {
    const h = await mount([RETIRED, OFFERED_A], {
      route: 'routing',
      tierModels: ['gpt-6-luna', 'gpt-5.4-mini'],
      ruleTargets: ['model:gpt-5.4-mini'],
    });
    const entry = h.host.querySelector('[data-unlisted-entry="gpt-5.4-mini"]');
    expect(entry?.textContent).toBe(
      'gpt-5.4-mini is no longer listed by OpenAI — requests to it may fail',
    );
    // The offered member carries no such note.
    expect(h.host.querySelector('[data-unlisted-entry="gpt-6-luna"]')).toBeNull();
  });

  it('warns on a header rule that targets the model', async () => {
    const h = await mount([RETIRED, OFFERED_A], {
      route: 'routing',
      ruleTargets: ['model:gpt-5.4-mini', 'model:gpt-6-luna'],
    });
    h.store.setState('routingSection', 'rules');
    await flush();
    expect(h.host.querySelector('[data-unlisted-rule="r0"]')?.textContent).toBe(
      'gpt-5.4-mini is no longer listed by OpenAI — requests to it may fail',
    );
    expect(h.host.querySelector('[data-unlisted-rule="r1"]')).toBeNull(); // offered target
  });

  it('warns on a band target that is the model (the shared target summary)', async () => {
    const h = await mount([RETIRED, OFFERED_A], {
      route: 'routing',
      ruleTargets: ['model:gpt-5.4-mini'],
      matchType: 'auto_high',
    });
    const note = h.host.querySelector('[data-unlisted-target="gpt-5.4-mini"]');
    expect(note?.textContent).toMatch(/no longer listed by OpenAI — requests to it may fail/);
  });

  it('the note is "may", names the provider, and is silent for an offered model', () => {
    expect(unlistedNote(RETIRED, 'OpenAI')).toMatch(/may fail/);
    expect(unlistedNote(RETIRED, undefined)).toContain('its provider');
    expect(unlistedNote(OFFERED_A, 'OpenAI')).toBeNull();
    expect(unlistedNote(undefined, 'OpenAI')).toBeNull();
  });
});

describe('model picker — unlisted models last, still selectable', () => {
  it('partitions each group stably: offered first in their order, then unlisted', () => {
    const groups = offeredFirstGroups([
      { label: 'OpenAI', models: [RETIRED, OFFERED_A, OFFERED_B] },
    ]);
    expect(groups[0]!.models.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-6-sol', 'gpt-5.4-mini']);
  });

  it('formats the line with a relative time and the accessible name with the date', () => {
    const { line, label } = unlistedText(RETIRED_AT, Date.parse(RETIRED_AT) + 2 * 3_600_000);
    expect(line).toBe('No longer offered by the provider · noticed 2h ago');
    expect(label).toContain(new Date(RETIRED_AT).toLocaleDateString());
  });
});
