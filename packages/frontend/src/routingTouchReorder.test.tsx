/** Touch reorder (phase3-touch-reorder).
 *
 * A sibling of `routingDrag.test.tsx` rather than an addition to it: that suite's 835
 * lines cover invariants which are transport-INDEPENDENT, so it must keep passing
 * unmodified. Needing to edit it would mean this change reached somewhere it should not.
 *
 * What cannot be tested here: that HTML drag-and-drop never fires for touch, and that a
 * press on a nested button starts the ancestor row's drag. Both are native behaviours
 * happy-dom does not implement — they live in the browser suite.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelDto, TierDto, TierEntryDto } from './data/api';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = '2026-07-15T00:00:00.000Z';
const TIER: TierDto = {
  id: 't1',
  key: 'default',
  displayName: 'Default',
  description: null,
  createdAt: NOW,
};

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
    listedPrice: null,
    lastSyncedAt: null,
  };
}
const mkEntry = (modelId: string, position: number): TierEntryDto => ({
  id: `e-${modelId}`,
  tierId: 't1',
  modelId,
  position,
  model: null,
});

function makeFake(entries: string[] = ['m1', 'm2', 'm3']): FakeApiClient {
  return new FakeApiClient({
    models: { p1: ['m1', 'm2', 'm3', 'm4'].map(mkModel) },
    tiers: [TIER],
    tierEntries: { t1: entries.map((m, i) => mkEntry(m, i)) },
  });
}

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
  dispose: () => void;
}

async function mountRouting(fake: FakeApiClient = makeFake()): Promise<Harness> {
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
  [...host.querySelectorAll<HTMLElement>('.nav-item span')]
    .find((e) => e.textContent?.trim() === 'Routing')
    ?.click();
  await flush();
  return {
    host,
    store,
    fake,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

const rows = (host: HTMLElement): HTMLElement[] => [
  ...(host.querySelector<HTMLElement>('.panel')?.querySelectorAll<HTMLElement>('.chain-row') ?? []),
];
const order = (host: HTMLElement): string[] => rows(host).map((r) => r.dataset['modelId'] ?? '?');
const writesOf = (fake: FakeApiClient): { method: string; args: unknown[] }[] =>
  fake.callLog.filter((c) => c.method === 'replaceTierEntries');

/** The move control on the row for `modelId`. */
function moveBtn(host: HTMLElement, modelId: string, dir: 'up' | 'down'): HTMLButtonElement {
  const row = rows(host).find((r) => r.dataset['modelId'] === modelId);
  const b = row?.querySelector<HTMLButtonElement>(`.chain-move[data-dir="${dir}"]`);
  if (!b) throw new Error(`no ${dir} control on row ${modelId}`);
  return b;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('reordering without a drag', () => {
  it('moves an entry and persists through the SAME ordered-chain replace a drag uses', async () => {
    const h = await mountRouting();
    try {
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']);
      moveBtn(h.host, 'm1', 'down').click();
      await flush();

      expect(order(h.host), 'the entry did not move').toEqual(['m2', 'm1', 'm3']);
      // The REQUEST, not just the rendered order: a chain that repaints without
      // persisting is the failure this asserts against.
      const w = writesOf(h.fake);
      expect(w).toHaveLength(1);
      expect(w[0]?.args[1]).toEqual(['m2', 'm1', 'm3']);
    } finally {
      h.dispose();
    }
  });

  it('moves an entry up', async () => {
    const h = await mountRouting();
    try {
      moveBtn(h.host, 'm3', 'up').click();
      await flush();
      expect(order(h.host)).toEqual(['m1', 'm3', 'm2']);
    } finally {
      h.dispose();
    }
  });

  it('announces the new position, like the keyboard path', async () => {
    const h = await mountRouting();
    try {
      moveBtn(h.host, 'm1', 'down').click();
      await flush();
      const status = h.host.querySelector('[data-testid="reorder-status"]');
      expect(status?.textContent).toContain('Fallback 1');
    } finally {
      h.dispose();
    }
  });
});

describe('the chain boundaries', () => {
  it('disables "up" on the primary and "down" on the last', async () => {
    const h = await mountRouting();
    try {
      expect(moveBtn(h.host, 'm1', 'up').disabled, 'up on the primary').toBe(true);
      expect(moveBtn(h.host, 'm3', 'down').disabled, 'down on the last').toBe(true);
      expect(moveBtn(h.host, 'm2', 'up').disabled).toBe(false);
      expect(moveBtn(h.host, 'm2', 'down').disabled).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('activating a boundary control changes nothing', async () => {
    const h = await mountRouting();
    try {
      moveBtn(h.host, 'm1', 'up').click();
      await flush();
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']);
      expect(writesOf(h.fake), 'a no-op move issued a write').toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('a ONE-entry chain has both controls disabled', async () => {
    // No focus rule is needed for this case, and this is why: it cannot be activated at
    // all. A successful move implies at least two entries, so whenever the pressed
    // direction becomes disabled the opposite one is necessarily enabled.
    const h = await mountRouting(makeFake(['m1']));
    try {
      expect(moveBtn(h.host, 'm1', 'up').disabled).toBe(true);
      expect(moveBtn(h.host, 'm1', 'down').disabled).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe('focus continuity', () => {
  it('keeps focus on the button pressed', async () => {
    // NOT on the drag handle. `keyboardMove` focuses the handle because that is where a
    // keyboard user was; doing that here would move focus off the control just tapped.
    const h = await mountRouting();
    try {
      moveBtn(h.host, 'm1', 'down').click();
      await flush();
      const active = document.activeElement as HTMLElement | null;
      expect(active?.className, 'focus left the move controls').toContain('chain-move');
      expect(active?.getAttribute('data-dir')).toBe('down');
      expect(active?.closest('.chain-row')?.getAttribute('data-model-id')).toBe('m1');
    } finally {
      h.dispose();
    }
  });

  it('moves focus to the opposite control when the pressed one becomes disabled', async () => {
    const h = await mountRouting();
    try {
      // Moving m2 down lands it on the LAST position, which disables the very "down"
      // button the user just pressed — the case this focus rule exists for.
      moveBtn(h.host, 'm2', 'down').click();
      await flush();
      expect(order(h.host)).toEqual(['m1', 'm3', 'm2']);
      expect(moveBtn(h.host, 'm2', 'down').disabled, 'the pressed control is still enabled').toBe(
        true,
      );
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute('data-dir'), 'focus was left on a disabled control').toBe('up');
      expect(active?.closest('.chain-row')?.getAttribute('data-model-id')).toBe('m2');
      expect((active as HTMLButtonElement | null)?.disabled).toBe(false);
    } finally {
      h.dispose();
    }
  });
});

describe('exclusion with a live drag', () => {
  /** happy-dom has no `DragEvent`; the handlers only read `dataTransfer`, so a plain
   *  Event with it defined is a faithful stand-in (same device as `routingDrag.test.tsx`). */
  const fireDrag = (el: HTMLElement, type: string): void => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { effectAllowed: '', dropEffect: '', setData: () => undefined },
    });
    el.dispatchEvent(ev);
  };

  it('the move controls stand down while a drag holds the tier', async () => {
    // A hybrid user could otherwise mutate the chain underneath a drag, so the order
    // finally committed on drop would not be the order they dropped.
    const h = await mountRouting();
    try {
      expect(moveBtn(h.host, 'm2', 'down').disabled, 'disabled before any drag').toBe(false);
      fireDrag(rows(h.host)[0]!, 'dragstart');
      await flush();
      expect(moveBtn(h.host, 'm2', 'down').disabled, 'still live during a drag').toBe(true);
      expect(moveBtn(h.host, 'm2', 'up').disabled).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('they come back once the drag ends', async () => {
    const h = await mountRouting();
    try {
      const row = rows(h.host)[0]!;
      fireDrag(row, 'dragstart');
      await flush();
      fireDrag(row, 'dragend');
      await flush();
      expect(moveBtn(h.host, 'm2', 'down').disabled, 'left disabled after the drag').toBe(false);
    } finally {
      h.dispose();
    }
  });
});

describe('coexistence with the other transports', () => {
  it('leaves the reorder handle and its Alt+Arrow path intact', async () => {
    const h = await mountRouting();
    try {
      const row = rows(h.host).find((r) => r.dataset['modelId'] === 'm1');
      const handle = row?.querySelector<HTMLButtonElement>('.drag-handle');
      expect(handle, 'the drag handle was removed').not.toBeNull();
      expect(handle?.getAttribute('aria-label')).toContain('Alt');

      handle?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
      );
      await flush();
      expect(order(h.host), 'the keyboard path stopped working').toEqual(['m2', 'm1', 'm3']);
    } finally {
      h.dispose();
    }
  });

  it('TRANSPORT EQUIVALENCE: keyboard and buttons persist an identical chain', async () => {
    // Three callers of one mover — this is the assertion that keeps them honest.
    const viaKeyboard = await mountRouting();
    let keyboardResult: unknown;
    try {
      const row = rows(viaKeyboard.host).find((r) => r.dataset['modelId'] === 'm1');
      row
        ?.querySelector<HTMLButtonElement>('.drag-handle')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
        );
      await flush();
      keyboardResult = writesOf(viaKeyboard.fake).at(-1)?.args[1];
    } finally {
      viaKeyboard.dispose();
    }

    const viaButton = await mountRouting();
    try {
      moveBtn(viaButton.host, 'm1', 'down').click();
      await flush();
      expect(writesOf(viaButton.fake).at(-1)?.args[1]).toEqual(keyboardResult);
    } finally {
      viaButton.dispose();
    }
  });

  it('coalesces a rapid burst into fewer writes than activations', async () => {
    const h = await mountRouting(makeFake(['m1', 'm2', 'm3', 'm4']));
    try {
      moveBtn(h.host, 'm1', 'down').click();
      moveBtn(h.host, 'm1', 'down').click();
      moveBtn(h.host, 'm1', 'down').click();
      await flush();
      expect(order(h.host)).toEqual(['m2', 'm3', 'm4', 'm1']);
      const w = writesOf(h.fake);
      expect(w.length, 'one write per activation').toBeLessThan(3);
      expect(w.at(-1)?.args[1], 'the final order is not what persisted').toEqual([
        'm2',
        'm3',
        'm4',
        'm1',
      ]);
    } finally {
      h.dispose();
    }
  });
});
