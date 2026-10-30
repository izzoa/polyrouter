/** zero-cost-unbilled-errors: the Requests table cell and the inspector's usage-and-cost
 * block, rendered through the real App from the fake API. The view-model rules are
 * unit-tested in data/analytics.test.ts; this asserts they actually reach the screen. */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { RequestRow } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { buildRequestRows, FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const BASE = buildRequestRows(1)[0]!;

/** Named rows, newest first — the listing renders them in this order. The not-billed rows
 * sit at indexes 2 and 3 so a pass cannot come from the first row alone. */
function fixtures(): Record<string, RequestRow> {
  const at = (n: number): string =>
    new Date(Date.parse('2026-10-27T12:00:00Z') - n * 1000).toISOString();
  const shared: Partial<RequestRow> = {
    status: 'error',
    escalated: false,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheReadPriceSnapshot: null,
    cacheWritePriceSnapshot: null,
    attemptFailures: null,
    hasBodies: false,
    errorKind: 'unavailable',
    errorStatus: null,
    errorMessage: null,
    errorRequestId: null,
    errorMarkers: null,
  };
  return {
    paid: {
      ...BASE,
      ...shared,
      id: 'r-paid',
      createdAt: at(0),
      status: 'success',
      cost: 0.0042,
      billed: true,
      usageEstimated: false,
      priceEstimated: false,
      priceSource: 'bundled',
      attemptCostMicros: 0,
      errorKind: null,
    },
    legacy: {
      ...BASE,
      ...shared,
      id: 'r-legacy',
      createdAt: at(1),
      cost: 0.0042,
      billed: null,
      usageEstimated: true,
      priceEstimated: false,
      priceSource: 'bundled',
      attemptCostMicros: 0,
    },
    notBilled: {
      ...BASE,
      ...shared,
      id: 'r-field',
      createdAt: at(2),
      inputTokens: 54_040,
      outputTokens: 0,
      inputPriceSnapshot: 2,
      outputPriceSnapshot: 8,
      cost: 0,
      billed: false,
      usageEstimated: true,
      priceEstimated: true,
      priceSource: 'native_family',
      attemptCostMicros: 0,
    },
    notBilledParent: {
      ...BASE,
      ...shared,
      id: 'r-parent',
      createdAt: at(3),
      cost: 0,
      billed: false,
      usageEstimated: true,
      priceEstimated: false,
      priceSource: 'bundled',
      attemptCostMicros: 1_500,
    },
  };
}

interface Harness {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}

async function mountRequests(rows: RequestRow[]): Promise<Harness> {
  const store = createAppStore(new FakeApiClient({ requestRows: rows }));
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
    .find((e) => e.textContent?.trim() === 'Requests')
    ?.click();
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

const costCell = (btn: HTMLElement): string => {
  const cell = [...btn.querySelectorAll<HTMLElement>('.rs-cell')].find(
    (c) => c.querySelector('.rs-cell-label')?.textContent === 'Cost',
  );
  return (cell?.textContent ?? '').replace(
    cell?.querySelector('.rs-cell-label')?.textContent ?? '',
    '',
  );
};

describe('not-billed requests on screen (zero-cost-unbilled-errors)', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('the table cost cell reads `$0 · not billed` only where billed is false and no attempt cost exists', async () => {
    const f = fixtures();
    h = await mountRequests([f.paid!, f.legacy!, f.notBilled!, f.notBilledParent!]);
    const buttons = [...h.host.querySelectorAll<HTMLElement>('button.req-row')];
    expect(buttons).toHaveLength(4);
    expect(buttons.map(costCell)).toEqual([
      '$0.0042',
      '$0.0042~', // legacy (billed null) estimated row: exactly as before
      '$0 · not billed',
      '$0.0015~', // not-billed parent whose superseded cheap call cost real money
    ]);
  });

  it('the inspector notes the served call was not billed, keeping tokens and est. price rows', async () => {
    const f = fixtures();
    h = await mountRequests([f.paid!, f.legacy!, f.notBilled!, f.notBilledParent!]);
    const buttons = [...h.host.querySelectorAll<HTMLElement>('button.req-row')];
    buttons[2]!.click();
    await flush();
    const drawer = h.host.querySelector<HTMLElement>('#inspector-drawer')!;
    const note = drawer.querySelector<HTMLElement>('[data-testid="not-billed-note"]');
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain('never sent or was rejected');
    expect(note!.getAttribute('style')).toContain('var(--text3)');
    const text = drawer.textContent ?? '';
    // served + total both read not billed, and no `~`/`est.` marker rides the cost.
    expect(text.match(/\$0 · not billed/g)).toHaveLength(2);
    // The estimated tokens and the estimate-priced rows are untouched.
    expect(text).toContain('54,040');
    expect(text).toContain('~est');
    expect(text).toContain('$2 / 1M · est.');
    expect(text).toContain('native family · estimate');
  });

  it('a not-billed parent keeps its attempt line and total, and the note stays; a billed row has no note', async () => {
    const f = fixtures();
    h = await mountRequests([f.paid!, f.legacy!, f.notBilled!, f.notBilledParent!]);
    const open = async (i: number): Promise<HTMLElement> => {
      [...h!.host.querySelectorAll<HTMLElement>('button.req-row')][i]!.click();
      await flush();
      return h!.host.querySelector<HTMLElement>('#inspector-drawer')!;
    };
    const parent = await open(3);
    expect(parent.querySelector('[data-testid="not-billed-note"]')).not.toBeNull();
    const rowsText = [...parent.querySelectorAll<HTMLElement>('.kv-box > div')].map(
      (d) => d.textContent ?? '',
    );
    expect(rowsText).toContain('served cost$0 · not billed');
    expect(rowsText).toContain('attempt cost$0.0015');
    // The total shows the real attempt cost, never `$0 · not billed`.
    expect(rowsText).toContain('total$0.0015');
    // Billed rows (paid at 0, legacy at 1) carry no note and keep the usage caption.
    parent.querySelector<HTMLButtonElement>('button.drawer-close')?.click();
    await flush();
    for (const i of [0, 1]) {
      const d = await open(i);
      expect(d.querySelector('[data-testid="not-billed-note"]')).toBeNull();
      expect(d.textContent).not.toContain('not billed');
      d.querySelector<HTMLButtonElement>('button.drawer-close')?.click();
      await flush();
    }
  });
});
