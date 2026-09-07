/**
 * Entry mode on the Routing page (add-batch-mode-routing, phase 5).
 *
 * Two properties carry this feature, and both are easy to lose:
 *
 * A mode must survive every LOCAL path. The wire carries ids on legacy clients and
 * the optimistic queue used to carry ids too, so a drag, an add, or a remove could
 * clear a tenant's reservations before any request was sent.
 *
 * Unreserving must always be reachable. The control is gated on the provider being
 * batch-capable — but a provider can lose its seam under a stored reservation, and
 * a chain replacement resubmits every entry, so gating on capability alone would
 * leave that tier uneditable.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import type { ModelDto, TierDto, TierEntryDto } from './data/api';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const TIER: TierDto = {
  id: 't1',
  key: 'default',
  displayName: null,
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const model = (id: string, over: Partial<ModelDto> = {}): ModelDto => ({
  id,
  providerId: 'p1',
  externalModelId: id,
  displayName: null,
  contextWindow: null,
  supportsTools: false,
  supportsVision: false,
  supportsReasoning: false,
  isFree: false,
  inputPricePer1m: 1,
  outputPricePer1m: 2,
  effectivePrice: null,
  listedPrice: null,
  variant: null,
  baseExternalModelId: null,
  batchCapable: true,
  batchEffectivePrice: null,
  lastSyncedAt: null,
  ...over,
});

const entry = (modelId: string, position: number, mode: 'any' | 'batch' = 'any'): TierEntryDto => ({
  id: `e-${modelId}`,
  tierId: 't1',
  modelId,
  position,
  mode,
  model: { id: modelId, providerId: 'p1', externalModelId: modelId, displayName: null },
});

function makeFake(
  entries: TierEntryDto[],
  models: ModelDto[] = [model('m1'), model('m2')],
): FakeApiClient {
  return new FakeApiClient({
    tiers: [TIER],
    tierEntries: { t1: entries },
    models: { p1: models },
    providers: [{ id: 'p1', name: 'OpenRouter' } as never],
  });
}

async function mount(fake: FakeApiClient): Promise<{
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}> {
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
  store.go('routing');
  await flush();
  await flush();
  return {
    host,
    store,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

const sentAt = (f: FakeApiClient, i: number): { modelId: string; mode?: string }[] =>
  f.callLog.filter((c) => c.method === 'replaceTierEntries')[i]?.args[1] as never;
const lastSent = (f: FakeApiClient): { modelId: string; mode?: string }[] => {
  const w = f.callLog.filter((c) => c.method === 'replaceTierEntries');
  return w[w.length - 1]?.args[1] as never;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a mode survives every local path (task 5.1)', () => {
  it('is preserved by a reorder, an add, and a remove', async () => {
    const fake = makeFake(
      [entry('m1', 0, 'batch'), entry('m2', 1)],
      [model('m1'), model('m2'), model('m3')],
    );
    const h = await mount(fake);
    try {
      h.store.setPrimaryTierModel('t1', 'm2');
      await flush();
      expect(lastSent(fake)).toEqual([
        { modelId: 'm2', mode: 'any' },
        { modelId: 'm1', mode: 'batch' },
      ]);

      h.store.addTierModel('t1', 'm3');
      await flush();
      expect(lastSent(fake).find((e) => e.modelId === 'm1')?.mode).toBe('batch');
      expect(lastSent(fake).find((e) => e.modelId === 'm3')?.mode).toBe('any');

      h.store.removeTierModel('t1', 'm2');
      await flush();
      expect(lastSent(fake).find((e) => e.modelId === 'm1')?.mode).toBe('batch');
    } finally {
      h.dispose();
    }
  });

  it('is restored by a rollback, not just the order', async () => {
    // The confirmed baseline is what a failed write rolls back to. Carrying ids only
    // would silently unreserve the chain on any failure.
    const fake = makeFake([entry('m1', 0, 'batch'), entry('m2', 1)]);
    const h = await mount(fake);
    try {
      expect(h.store.state.confirmedEntries['t1']).toEqual([
        { modelId: 'm1', mode: 'batch' },
        { modelId: 'm2', mode: 'any' },
      ]);
      fake.deferTierWrites = true;
      h.store.setPrimaryTierModel('t1', 'm2');
      await flush();
      fake.tierWriteQueue.shift()?.settle('reject');
      await flush();
      expect(h.store.state.tierEntries['t1']?.map((e) => [e.modelId, e.mode])).toEqual([
        ['m1', 'batch'],
        ['m2', 'any'],
      ]);
    } finally {
      h.dispose();
    }
  });
});

describe('the reservation control (tasks 5.2/5.4)', () => {
  const toggleFor = (host: HTMLElement, modelId: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>('.chain-mode [role="switch"]')].find((b) =>
      (b.getAttribute('aria-label') ?? '').includes(modelId),
    );

  it('reserves the entry it belongs to, at a NON-ZERO position', async () => {
    // Position-independent on purpose: toggling the row at index 0 would pass even if
    // the mutator hardcoded `entries[0]`, so this toggles the middle of three and
    // asserts the other two are untouched.
    const fake = makeFake(
      [entry('m1', 0), entry('m2', 1), entry('m3', 2)],
      [model('m1'), model('m2'), model('m3')],
    );
    const h = await mount(fake);
    try {
      const t = toggleFor(h.host, 'm2')!;
      expect(t.getAttribute('aria-checked')).toBe('false');
      // The name identifies the ENTRY: a chain of five would otherwise present five
      // identically-named switches to a screen reader.
      expect(t.getAttribute('aria-label')).toBe('Reserve m2 for batch only');
      t.click();
      await flush();
      expect(lastSent(fake)).toEqual([
        { modelId: 'm1', mode: 'any' },
        { modelId: 'm2', mode: 'batch' },
        { modelId: 'm3', mode: 'any' },
      ]);
      expect(toggleFor(h.host, 'm2')?.getAttribute('aria-checked')).toBe('true');
      expect(toggleFor(h.host, 'm1')?.getAttribute('aria-checked')).toBe('false');
      expect(toggleFor(h.host, 'm3')?.getAttribute('aria-checked')).toBe('false');
    } finally {
      h.dispose();
    }
  });

  it('unreserves the right entry when two are reserved', async () => {
    // The inverse hazard: a mutator that cleared "the reserved one" rather than the
    // one asked for would pass every single-reservation test.
    const fake = makeFake([entry('m1', 0, 'batch'), entry('m2', 1, 'batch')]);
    const h = await mount(fake);
    try {
      toggleFor(h.host, 'm2')!.click();
      await flush();
      expect(lastSent(fake)).toEqual([
        { modelId: 'm1', mode: 'batch' },
        { modelId: 'm2', mode: 'any' },
      ]);
    } finally {
      h.dispose();
    }
  });

  it('offers no control where the provider cannot run a batch', async () => {
    const fake = makeFake([entry('m1', 0)], [model('m1', { batchCapable: false })]);
    const h = await mount(fake);
    try {
      expect(toggleFor(h.host, 'm1')).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  it('KEEPS the control on a stored reservation whose provider lost its seam', async () => {
    // Suppressing it on capability alone is the deadlock: the toggle disappears while
    // every chain edit resubmits the offending entry, so the tenant cannot reorder,
    // add, or remove anything in this tier without deleting the model outright.
    const fake = makeFake([entry('m1', 0, 'batch')], [model('m1', { batchCapable: false })]);
    const h = await mount(fake);
    try {
      const t = toggleFor(h.host, 'm1');
      expect(t).toBeDefined();
      expect(t?.getAttribute('aria-checked')).toBe('true');
      // And it says why, rather than leaving a reservation that silently serves nothing.
      expect(h.host.querySelector('[data-mode-orphaned="m1"]')?.textContent).toContain(
        'no batch API',
      );
      // Unreserving works, which is the escape hatch.
      t?.click();
      await flush();
      expect(lastSent(fake)).toEqual([{ modelId: 'm1', mode: 'any' }]);
    } finally {
      h.dispose();
    }
  });
});

describe('the aggregator twin shortcut (task 5.3)', () => {
  const twin = (over: Partial<ModelDto> = {}) =>
    model('m1:batch', { variant: 'batch', baseExternalModelId: 'm1', ...over });
  const rows = (host: HTMLElement): string[] =>
    [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');
  const openPicker = async (host: HTMLElement): Promise<void> => {
    const input = host.querySelector<HTMLInputElement>('.mp-input')!;
    input.focus();
    input.dispatchEvent(new Event('focus'));
    input.click();
    await flush();
  };

  it('commits the BASE model reserved, never the twin id', async () => {
    const fake = makeFake([entry('m2', 0)], [model('m1'), model('m2'), twin()]);
    const h = await mount(fake);
    try {
      await openPicker(h.host);
      const option = [...h.host.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
        (o.textContent ?? '').includes('m1:batch'),
      );
      expect(option, 'the twin should be offered as a shortcut').toBeDefined();
      option!.click();
      await flush();
      // The stored entry is indistinguishable from toggling `m1` directly, and the
      // non-routable twin never becomes a target.
      expect(lastSent(fake)).toEqual([
        { modelId: 'm2', mode: 'any' },
        { modelId: 'm1', mode: 'batch' },
      ]);
      expect(JSON.stringify(lastSent(fake))).not.toContain('m1:batch');
    } finally {
      h.dispose();
    }
  });

  it('withholds the shortcut for an orphan twin and a seam-less provider', async () => {
    // No routable sibling base on that provider → no id to store.
    const orphan = makeFake([], [model('m2'), twin({ baseExternalModelId: 'gone' })]);
    let h = await mount(orphan);
    await openPicker(h.host);
    expect(rows(h.host).some((r) => r.includes('m1:batch'))).toBe(false);
    h.dispose();

    // Base exists but its provider has no batch API → the save could only be rejected.
    const seamless = makeFake([], [model('m1', { batchCapable: false }), twin()]);
    h = await mount(seamless);
    await openPicker(h.host);
    expect(rows(h.host).some((r) => r.includes('m1:batch'))).toBe(false);
    h.dispose();
  });

  it('withholds the shortcut when that entry is already reserved', async () => {
    // Committing could only be a no-op.
    const fake = makeFake([entry('m1', 0, 'batch')], [model('m1'), twin()]);
    const h = await mount(fake);
    try {
      await openPicker(h.host);
      expect(rows(h.host).some((r) => r.includes('m1:batch'))).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('reserves an existing entry in place rather than appending a duplicate', async () => {
    // A tenant reserving a model they already route to is the obvious first thing to
    // try, and a second entry for the same model would be refused as a duplicate.
    const fake = makeFake([entry('m1', 0), entry('m2', 1)], [model('m1'), model('m2'), twin()]);
    const h = await mount(fake);
    try {
      await openPicker(h.host);
      [...h.host.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((o) => (o.textContent ?? '').includes('m1:batch'))!
        .click();
      await flush();
      expect(lastSent(fake)).toEqual([
        { modelId: 'm1', mode: 'batch' },
        { modelId: 'm2', mode: 'any' },
      ]);
      expect(lastSent(fake)).toHaveLength(2);
    } finally {
      h.dispose();
    }
  });

  it('does not count a mode change against the five-model cap', async () => {
    const five = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const fake = makeFake(
      five.map((id, i) => entry(id, i)),
      [...five.map((id) => model(id)), twin()],
    );
    const h = await mount(fake);
    try {
      const before = fake.callLog.filter((c) => c.method === 'replaceTierEntries').length;
      h.store.addTierModel('t1', 'm1', 'batch');
      await flush();
      const after = fake.callLog.filter((c) => c.method === 'replaceTierEntries');
      expect(after.length, 'the write must not be refused by the cap').toBe(before + 1);
      expect(sentAt(fake, after.length - 1)).toHaveLength(5);
      expect(lastSent(fake)[0]).toEqual({ modelId: 'm1', mode: 'batch' });
    } finally {
      h.dispose();
    }
  });
});
