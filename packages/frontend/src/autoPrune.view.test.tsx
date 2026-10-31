/**
 * The auto-prune switch and what a Sync says about it (add-auto-prune-unlisted-models).
 *
 * The switch lives in the edit-provider modal only — a provider that does not exist yet
 * has nothing to prune — and the PATCH carries it only when it changed, so an unrelated
 * edit never rewrites it. A Sync that deleted retired models says how many; one that
 * deleted none stays silent about it.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient, UNRECORDED_HEALTH } from './test/fakeClient';
import type { ActionResult, ProviderDto } from './data/api';

const NOW = '2026-10-31T12:00:00.000Z';

const mkProvider = (over: Partial<ProviderDto> = {}): ProviderDto => ({
  id: 'p1',
  name: 'CLIProxyAPI',
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
  autoPruneUnlisted: true,
  createdAt: NOW,
  ...UNRECORDED_HEALTH,
  ...over,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
}

async function mount(provider: ProviderDto, syncResult?: ActionResult): Promise<Harness> {
  globalThis.history.replaceState(null, '', '/#/providers');
  const fake = new FakeApiClient({
    session: DEFAULT_SESSION,
    providers: [provider],
    ...(syncResult !== undefined ? { syncResult } : {}),
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
  return { host, store, fake };
}

const box = (host: HTMLElement): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>('#f-np-autoprune');

const openEdit = async (h: Harness): Promise<void> => {
  h.store.openEditProvider(h.store.state.providers[0]!);
  await flush();
};

const saveEdit = async (h: Harness): Promise<void> => {
  [...h.host.querySelectorAll('button')]
    .find((b) => /^Save changes$/.test(b.textContent ?? ''))
    ?.click();
  await flush();
};

const patches = (fake: FakeApiClient): Record<string, unknown>[] =>
  fake.callLog
    .filter((c) => c.method === 'updateProvider')
    .map((c) => c.args[1] as Record<string, unknown>);

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the edit-provider modal carries the auto-prune switch', () => {
  it('reflects the stored value, and turning it off sends exactly that', async () => {
    const h = await mount(mkProvider({ autoPruneUnlisted: true }));
    await openEdit(h);
    const checkbox = box(h.host);
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);
    // The wording states the rule and its exception, in words.
    expect(h.host.textContent).toMatch(/Remove retired models automatically/);
    expect(h.host.textContent).toMatch(/not listed for 7 days/);
    expect(h.host.textContent).toMatch(/unless a tier or rule uses them/);

    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await saveEdit(h);

    expect(patches(h.fake)).toHaveLength(1);
    expect(patches(h.fake)[0]).toMatchObject({ autoPruneUnlisted: false });
    // …and reopening shows the saved value.
    await openEdit(h);
    expect(box(h.host)!.checked).toBe(false);
  });

  it('shows a provider that has it off as off, and turning it back on sends true', async () => {
    const h = await mount(mkProvider({ autoPruneUnlisted: false }));
    await openEdit(h);
    expect(box(h.host)!.checked).toBe(false);
    box(h.host)!.checked = true;
    box(h.host)!.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await saveEdit(h);
    expect(patches(h.fake)[0]).toMatchObject({ autoPruneUnlisted: true });
  });

  it('an edit that leaves the switch alone does not send it', async () => {
    const h = await mount(mkProvider({ autoPruneUnlisted: false }));
    await openEdit(h);
    const name = h.host.querySelector<HTMLInputElement>('#f-np-name');
    expect(name).not.toBeNull();
    name!.value = 'Renamed';
    name!.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    await saveEdit(h);
    expect(patches(h.fake)).toHaveLength(1);
    expect(patches(h.fake)[0]).toMatchObject({ name: 'Renamed' });
    expect('autoPruneUnlisted' in patches(h.fake)[0]!).toBe(false);
  });

  it('reads a provider the server sent without the field as on', async () => {
    const dto = mkProvider();
    delete (dto as { autoPruneUnlisted?: boolean }).autoPruneUnlisted;
    const h = await mount(dto);
    await openEdit(h);
    expect(box(h.host)!.checked).toBe(true);
  });

  it('is not offered when adding a provider — nothing exists yet to prune', async () => {
    const h = await mount(mkProvider());
    h.store.openModal('newProvider');
    await flush();
    expect(h.host.querySelector('#f-np-name')).not.toBeNull(); // the modal is open
    expect(box(h.host)).toBeNull();
  });
});

describe('what a Sync says about pruning', () => {
  const sync = async (h: Harness): Promise<string | null> => {
    await h.store.syncProvider('p1');
    await flush();
    return h.store.state.toast;
  };

  it('names how many retired models a Sync removed', async () => {
    const h = await mount(mkProvider(), {
      ok: true,
      status: 'ok',
      message: 'catalog synced',
      traceId: 't',
      synced: 731,
      pruned: 12,
    });
    const toast = await sync(h);
    expect(toast).toBe('Synced 731 models, removed 12 retired models');
  });

  it('reads a single pruned model in the singular', async () => {
    const h = await mount(mkProvider(), {
      ok: true,
      status: 'ok',
      message: 'catalog synced',
      traceId: 't',
      synced: 5,
      pruned: 1,
    });
    expect(await sync(h)).toBe('Synced 5 models, removed 1 retired model');
  });

  it('says nothing about pruning when none were removed', async () => {
    for (const pruned of [0, undefined]) {
      const h = await mount(mkProvider(), {
        ok: true,
        status: 'ok',
        message: 'catalog synced',
        traceId: 't',
        synced: 731,
        ...(pruned !== undefined ? { pruned } : {}),
      });
      const toast = await sync(h);
      expect(toast).toBe('Synced 731 models');
      expect(toast).not.toMatch(/removed|retired|prun/i);
      document.body.innerHTML = '';
    }
  });
});
