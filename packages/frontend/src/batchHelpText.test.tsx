/**
 * The batch reservation's help text (add-batch-mode-help).
 *
 * Two properties carry it. The FIGURES must be sourced — a latency claim typed into
 * the interface and a cost claim invented as a ratio are the two ways this text could
 * lie, and both are cheap to write by accident. And the DISCLOSURE must not touch the
 * switch: a tap on a `role="switch"` belongs to that switch, whose hit area already
 * expands to 44x44 under a coarse pointer.
 */
import { render } from 'solid-js/web';
import { BATCH_COMPLETION_WINDOW_MS, BATCH_COMPLETION_WINDOW_TEXT } from '@polyrouter/shared';
import { afterEach, describe, expect, it } from 'vitest';
// NOT named `batchModeHelp.test.tsx`: that differs from `components/BatchModeHelp.tsx`
// only by case, and on a case-insensitive filesystem vite's module graph collides the
// two and fails to transform this file (with a misleading "invalid JS syntax").
import { batchHelpLines } from './components/BatchModeHelp';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import type { EffectivePrice, ModelDto, TierDto, TierEntryDto } from './data/api';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const price = (i: number, o: number, over: Partial<EffectivePrice> = {}): EffectivePrice => ({
  inputPricePer1m: i,
  outputPricePer1m: o,
  isFree: false,
  source: 'model',
  estimated: false,
  ...over,
});

const model = (over: Partial<ModelDto> = {}): ModelDto => ({
  id: 'm1',
  providerId: 'p1',
  externalModelId: 'm1',
  displayName: null,
  contextWindow: null,
  supportsTools: false,
  supportsVision: false,
  supportsReasoning: false,
  isFree: false,
  inputPricePer1m: 10,
  outputPricePer1m: 30,
  effectivePrice: price(10, 30),
  listedPrice: null,
  variant: null,
  baseExternalModelId: null,
  batchCapable: true,
  batchEffectivePrice: null,
  lastSyncedAt: null,
  ...over,
});

describe('the figures are sourced, never invented', () => {
  it('states the window from the shared constant the adapters also read', () => {
    const text = batchHelpLines(model()).join(' ');
    expect(text).toContain(BATCH_COMPLETION_WINDOW_TEXT);
    // Not a coincidence of wording: the words and the number are the same fact.
    expect(BATCH_COMPLETION_WINDOW_TEXT).toBe(
      `${String(BATCH_COMPLETION_WINDOW_MS / 3_600_000)} hours`,
    );
    // The other half of the latency claim, which a completion window alone omits.
    expect(text).toMatch(/only when the whole batch finishes/i);
    expect(text).toMatch(/nothing streams/i);
  });

  it('shows the resolved batch rate beside its synchronous one — never a ratio', () => {
    const text = batchHelpLines(
      model({ batchEffectivePrice: price(5, 15), effectivePrice: price(10, 30) }),
    ).join(' ');
    expect(text).toContain('$5.00 / $15.00');
    expect(text).toContain('$10.00 / $30.00');
    // The wording this change exists to avoid: a fraction is a price claim polyrouter
    // cannot source, and is simply wrong wherever the real rate is not that fraction.
    expect(text).not.toMatch(/half|50%|percent/i);
  });

  it('says the rate is unknown rather than implying the synchronous one', () => {
    // The common path for a native Anthropic provider, which publishes no batch rate
    // polyrouter can read. Substituting the sync price would misstate the whole trade.
    const text = batchHelpLines(model({ batchEffectivePrice: null })).join(' ');
    expect(text).toMatch(/unknown/i);
    expect(text).not.toContain('$10.00 / $30.00');
  });

  it('marks an estimated batch rate as one', () => {
    const text = batchHelpLines(
      model({ batchEffectivePrice: price(5, 15, { source: 'listed', estimated: true }) }),
    ).join(' ');
    expect(text).toContain('estimate');
  });

  it('leads with what the control does, so a reader who stops early still learns it', () => {
    expect(batchHelpLines(model())[0]).toMatch(/held for batch work/i);
    // And never implies the two things the routing rules explicitly do NOT do.
    const all = batchHelpLines(model()).join(' ').toLowerCase();
    expect(all).not.toMatch(/prefer/);
    expect(all).not.toMatch(/cannot serve batch/);
  });
});

const TIER: TierDto = {
  id: 't1',
  key: 'default',
  displayName: null,
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const entry = (mode: 'any' | 'batch' = 'any'): TierEntryDto => ({
  id: 'e-m1',
  tierId: 't1',
  modelId: 'm1',
  position: 0,
  mode,
  model: { id: 'm1', providerId: 'p1', externalModelId: 'm1', displayName: null },
});

async function mount(m: ModelDto = model()): Promise<{
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}> {
  const store = createAppStore(
    new FakeApiClient({
      tiers: [TIER],
      tierEntries: { t1: [entry()] },
      models: { p1: [m] },
      providers: [{ id: 'p1', name: 'OpenRouter' } as never],
    }),
  );
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

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the disclosure never competes with the switch', () => {
  it('describes the switch, so the consequences reach a screen reader', async () => {
    const h = await mount();
    try {
      const sw = h.host.querySelector('.chain-mode [role="switch"]')!;
      const id = sw.getAttribute('aria-describedby');
      expect(id, 'the switch must point at its help').toBeTruthy();
      const cardId = String(id);
      const card = [...h.host.querySelectorAll('.chain-help-card')].find((el) => el.id === cardId);
      expect(card?.textContent).toMatch(/held for batch work/i);
      // The association exists WITHOUT any interaction — a reader using assistive
      // technology never hovers, and below the narrow threshold nothing is disclosed.
      expect(card?.classList.contains('chain-help-shown')).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('reveals on keyboard focus alone, with no mouse', async () => {
    const h = await mount();
    try {
      const trigger = h.host.querySelector<HTMLButtonElement>('.chain-help-trigger')!;
      const card = h.host.querySelector('.chain-help-card')!;
      expect(card.classList.contains('chain-help-shown')).toBe(false);
      trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await flush();
      expect(card.classList.contains('chain-help-shown')).toBe(true);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
    } finally {
      h.dispose();
    }
  });

  it('attaches NO disclosure handler to the switch itself', async () => {
    // The defect this design avoids: a tap on a `role="switch"` must toggle it, and its
    // hit area already expands to 44x44 under a coarse pointer with the overlay inside
    // the button. Binding reveal to the switch would either steal the toggle or raise
    // the help on every state change. So the switch's only job stays toggling.
    const h = await mount();
    try {
      const sw = h.host.querySelector<HTMLButtonElement>('.chain-mode [role="switch"]')!;
      const card = h.host.querySelector('.chain-help-card')!;
      sw.click();
      await flush();
      expect(card.classList.contains('chain-help-shown'), 'the switch must not reveal').toBe(false);
      // ...and it did what a switch does.
      expect(
        h.host.querySelector('.chain-mode [role="switch"]')?.getAttribute('aria-checked'),
      ).toBe('true');
    } finally {
      h.dispose();
    }
  });

  it('is one element in one place, whatever the width', async () => {
    // `aria-describedby` must point at the SAME node at every width: the narrow
    // presentation is the same element restyled, not a second copy that could drift.
    const h = await mount();
    try {
      expect(h.host.querySelectorAll('.chain-help-card')).toHaveLength(1);
      expect(h.host.querySelectorAll('.chain-help')).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
});

/** Read lazily inside the test, as the sibling suites do: a top-level node-builtin
 * import in a browser-environment test file breaks vite's transform of this file. */
const cssText = async (): Promise<string> => {
  const [{ readFileSync }, { fileURLToPath }, { dirname, join }] = await Promise.all([
    import('node:fs'),
    import('node:url'),
    import('node:path'),
  ]);
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
};

describe('the narrow presentation is CSS, not a second element', () => {
  it('is always visible and in flow below the threshold, with no trigger to tap', async () => {
    const css = await cssText();
    const narrow = css.slice(css.indexOf('@media (max-width: 768px)'));
    // Shown without interaction...
    expect(narrow).toMatch(/\.chain-help-card \{\s*display: block;/);
    // ...on its own line, like the row's other wrapped children...
    expect(narrow).toMatch(/\.chain-help \{[^}]*flex: 1 1 100%;/);
    // ...and with no second hit target competing with the switch.
    expect(narrow).toMatch(/\.chain-help-trigger \{\s*display: none;/);
  });

  it('carries the card treatment only on the REVEALED state', async () => {
    // Which is what lets the narrow layer show it in flow without clearing anything —
    // and keeps the elevation lock satisfied, since it forbids a non-token shadow value
    // anywhere in the stylesheet, comments included.
    const css = await cssText();
    const shown = /\.chain-help-shown \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(shown).toContain('position: fixed');
    expect(shown).toContain('box-shadow: var(--shadow-pop)');
    const base = /\.chain-help-card \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(base.trim()).toBe('display: none;');
  });
});
