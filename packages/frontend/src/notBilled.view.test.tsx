/** zero-cost-unbilled-errors: the Requests table cell and the inspector's usage-and-cost
 * block, rendered through the real App from the fake API. The view-model rules are
 * unit-tested in data/analytics.test.ts; this asserts they actually reach the screen.
 *
 * adopt-figure-states (tasks 2.2, 2.3): the same surfaces in the figure-state vocabulary.
 * The retired `~` is gone; `· est.` marks an estimated price on the money and `· est. usage`
 * an estimated count on the tokens, and each part of a figure is drawn in its own tone:
 * `free` green, `· est.`, `· est. usage` and `unpriced` Ink 3, both not-billed halves Ink 2,
 * and an amount or the `$0` before `free` with no colour of its own (the slot's Ink). */
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

/** One row per figure state the cost cell can draw (adopt-figure-states design Risk 2),
 * newest first. Every one is billed and successful unless its state needs otherwise. */
function stateFixtures(): RequestRow[] {
  const at = (n: number): string =>
    new Date(Date.parse('2026-10-27T13:00:00Z') - n * 1000).toISOString();
  const ok: Partial<RequestRow> = {
    status: 'success',
    escalated: false,
    billed: true,
    usageEstimated: false,
    priceEstimated: false,
    priceSource: 'bundled',
    attemptCostMicros: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheReadPriceSnapshot: null,
    cacheWritePriceSnapshot: null,
    attemptFailures: null,
    hasBodies: false,
    batchId: null,
    priceMode: null,
  };
  const free: Partial<RequestRow> = { cost: 0, inputPriceSnapshot: 0, outputPriceSnapshot: 0 };
  return [
    { ...BASE, ...ok, ...free, id: 's-free', createdAt: at(0) },
    {
      ...BASE,
      ...ok,
      ...free,
      id: 's-free-listed',
      createdAt: at(1),
      priceSource: 'listed',
      priceEstimated: true,
    },
    { ...BASE, ...ok, id: 's-unpriced', createdAt: at(2), cost: null, priceSource: null },
    { ...BASE, ...ok, id: 's-speck', createdAt: at(3), cost: 0.00004 },
    {
      ...BASE,
      ...ok,
      id: 's-estimated',
      createdAt: at(4),
      cost: 0.0042,
      priceSource: 'native_family',
      priceEstimated: true,
    },
    { ...BASE, ...ok, id: 's-usage', createdAt: at(5), cost: 0.0042, usageEstimated: true },
    {
      ...BASE,
      ...ok,
      id: 's-not-billed',
      createdAt: at(6),
      status: 'error',
      cost: 0,
      billed: false,
      usageEstimated: true,
      priceEstimated: true,
      priceSource: 'native_family',
    },
  ];
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

/** A cell's value element, found by its field label. */
function cellValue(btn: HTMLElement, label: string): HTMLElement {
  const cell = [...btn.querySelectorAll<HTMLElement>('.rs-cell')].find(
    (c) => c.querySelector('.rs-cell-label')?.textContent === label,
  );
  const value = cell?.querySelector<HTMLElement>(':scope > :not(.rs-cell-label)');
  if (!value) throw new Error(`no ${label} cell`);
  return value;
}

/** A rendered figure's parts: each `FigureText` unit's text and its OWN inline colour
 * (`''` when it has none and inherits the slot's ink). */
const partsOf = (figure: HTMLElement): [string, string][] =>
  [...figure.querySelectorAll<HTMLElement>(':scope > span')].map((p) => [
    p.textContent ?? '',
    p.style.color,
  ]);

/** The `· est. usage` marker inside a tokens figure, or null. */
const usageMarker = (figure: HTMLElement): HTMLElement | null =>
  [...figure.querySelectorAll<HTMLElement>('span')].find(
    (s) => s.textContent === '· est. usage' && s.children.length === 0,
  ) ?? null;

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
      // legacy (billed null) row whose USAGE was estimated, at an exact price: its money is
      // unmarked, and its tokens cell carries the usage marker (adopt-figure-states D3)
      '$0.0042',
      '$0 · not billed',
      '$0.0015', // not-billed parent whose superseded cheap call cost real money
    ]);
    expect(buttons.map(costCell).join(' ')).not.toContain('~');
    // The usage estimate lives on the tokens cell, never on the cost cell.
    expect(buttons.map((b) => usageMarker(cellValue(b, 'Tokens')) !== null)).toEqual([
      false,
      true,
      true,
      true,
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
    expect(text).not.toContain('~');
    // adopt-figure-states 2.3: both not-billed figures are Ink 2 throughout, in two halves.
    for (const id of ['inspector-served-cost', 'inspector-total-cost']) {
      const figure = drawer.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      expect(partsOf(figure)).toEqual([
        ['$0 ·', 'var(--text2)'],
        ['not billed', 'var(--text2)'],
      ]);
    }
    expect(drawer.querySelector('[data-testid="inspector-total-cost"]')!.textContent).not.toContain(
      'est.',
    );
    // The estimated tokens carry `· est. usage` in Ink 3, on the input AND the output count.
    for (const id of ['inspector-input-tokens', 'inspector-output-tokens']) {
      const marker = usageMarker(drawer.querySelector<HTMLElement>(`[data-testid="${id}"]`)!);
      expect(marker, `${id} carries the usage marker`).not.toBeNull();
      expect(marker!.style.color).toBe('var(--text3)');
    }
    expect(drawer.querySelector('[data-testid="inspector-input-tokens"]')!.textContent).toBe(
      '54,040 · est. usage',
    );
    // The estimate-priced rows are untouched.
    expect(text).toContain('54,040');
    expect(text).toContain('$2 / 1M · est.');
    expect(text).toContain('native family · estimate');
  });

  it('a free row priced `listed` reads `$0 free · est.` on its total and price rows, with only `free` green (2.3)', async () => {
    h = await mountRequests(stateFixtures());
    const listed = [...h.host.querySelectorAll<HTMLElement>('button.req-row')][1]!;
    expect(costCell(listed)).toBe('$0 free · est.');
    listed.click();
    await flush();
    const drawer = h.host.querySelector<HTMLElement>('#inspector-drawer')!;
    const freeEst: [string, string][] = [
      ['$0', ''],
      ['free', 'var(--green-text)'],
      ['· est.', 'var(--text3)'],
    ];
    expect(
      partsOf(drawer.querySelector<HTMLElement>('[data-testid="inspector-total-cost"]')!),
    ).toEqual(freeEst);
    const prices = [...drawer.querySelectorAll<HTMLElement>('[data-testid="inspector-price"]')];
    // input and output at zero (`$0 free · est.`), the two cache classes unpriced.
    expect(prices.map((p) => p.textContent)).toEqual([
      '$0 free · est.',
      '$0 free · est.',
      'unpriced',
      'unpriced',
    ]);
    expect(partsOf(prices[0]!)).toEqual(freeEst);
    expect(partsOf(prices[1]!)).toEqual(freeEst);
    expect(partsOf(prices[2]!)).toEqual([['unpriced', 'var(--text3)']]);
    // The price row's own ink is Ink; the `$0` inherits it rather than going green.
    expect(prices[0]!.style.color).toBe('var(--text)');
    // Usage was reported, so the counts carry no marker and the caption names the source.
    expect(
      usageMarker(drawer.querySelector<HTMLElement>('[data-testid="inspector-input-tokens"]')!),
    ).toBeNull();
    expect(drawer.textContent).toContain('Token counts from provider usage');
  });

  it('a usage-estimated row says so in words, never with the retired marker (2.3)', async () => {
    h = await mountRequests(stateFixtures());
    const usage = [...h.host.querySelectorAll<HTMLElement>('button.req-row')][5]!;
    usage.click();
    await flush();
    const drawer = h.host.querySelector<HTMLElement>('#inspector-drawer')!;
    expect(drawer.textContent).toContain('Provider omitted usage — token counts are estimated.');
    expect(drawer.textContent).not.toContain('~');
    expect(drawer.textContent).not.toContain('flagged');
    // Estimated usage never marks the money figures.
    for (const id of ['inspector-served-cost', 'inspector-attempt-cost', 'inspector-total-cost']) {
      expect(drawer.querySelector(`[data-testid="${id}"]`)!.textContent).not.toContain('est.');
    }
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
    // The total shows the real attempt cost, never `$0 · not billed`, and it reads exactly
    // what the table's cost cell reads for the same row.
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

describe('each figure state renders its own words in its own tones (adopt-figure-states 2.2)', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('the table cost cell draws every state from its parts, and the inspector total reads the same', async () => {
    h = await mountRequests(stateFixtures());
    const buttons = [...h.host.querySelectorAll<HTMLElement>('button.req-row')];
    expect(buttons).toHaveLength(7);
    const cost = (i: number): [string, string][] => partsOf(cellValue(buttons[i]!, 'Cost'));
    // `$0 free`: only `free` is green; the `$0` keeps the cell's Ink.
    expect(cost(0)).toEqual([
      ['$0', ''],
      ['free', 'var(--green-text)'],
    ]);
    // `$0 free · est.`: an estimated zero price is still marked as an estimate, in Ink 3.
    expect(cost(1)).toEqual([
      ['$0', ''],
      ['free', 'var(--green-text)'],
      ['· est.', 'var(--text3)'],
    ]);
    // `unpriced`: the bare word in Ink 3, never a dash or `$0.0000`.
    expect(cost(2)).toEqual([['unpriced', 'var(--text3)']]);
    // A positive amount below four decimals never prints as zero; it keeps the cell's Ink.
    expect(cost(3)).toEqual([['<$0.0001', '']]);
    // An estimate-priced amount: the amount in Ink, its marker in Ink 3.
    expect(cost(4)).toEqual([
      ['$0.0042', ''],
      ['· est.', 'var(--text3)'],
    ]);
    // A usage-only estimate leaves the money unmarked.
    expect(cost(5)).toEqual([['$0.0042', '']]);
    // `$0 · not billed`: both no-wrap halves Ink 2, never `· est.`.
    expect(cost(6)).toEqual([
      ['$0 ·', 'var(--text2)'],
      ['not billed', 'var(--text2)'],
    ]);
    // Each part is one no-wrap unit; the cell itself is Ink.
    for (const b of buttons) {
      const figure = cellValue(b, 'Cost');
      expect(figure.style.color).toBe('var(--text)');
      for (const p of figure.querySelectorAll<HTMLElement>(':scope > span')) {
        expect(p.style.whiteSpace).toBe('nowrap');
      }
    }
    // The inspector's total reads the same words as the cell, row by row.
    for (const b of buttons) {
      const cell = costCell(b);
      b.click();
      await flush();
      const total = h.host.querySelector<HTMLElement>('[data-testid="inspector-total-cost"]')!;
      expect(total.textContent).toBe(cell);
      expect(partsOf(total)).toEqual(partsOf(cellValue(b, 'Cost')));
      h.host.querySelector<HTMLButtonElement>('button.drawer-close')?.click();
      await flush();
    }
  });

  it('a usage-estimated row carries `· est. usage` on its tokens cell as one Ink 3 unit, and says so to assistive technology', async () => {
    h = await mountRequests(stateFixtures());
    const buttons = [...h.host.querySelectorAll<HTMLElement>('button.req-row')];
    const tokens = (i: number): HTMLElement => cellValue(buttons[i]!, 'Tokens');
    for (const i of [5, 6]) {
      const marker = usageMarker(tokens(i));
      expect(marker, `row ${String(i)} carries the usage marker`).not.toBeNull();
      expect(marker!.style.color).toBe('var(--text3)');
      expect(marker!.style.whiteSpace).toBe('nowrap');
      // Inside the visible, aria-hidden half; the words go to the screen-reader text.
      expect(marker!.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(tokens(i).querySelector('.sr-only')!.textContent).toMatch(/, estimated usage$/);
    }
    for (const i of [0, 1, 2, 3, 4]) {
      expect(usageMarker(tokens(i))).toBeNull();
      expect(tokens(i).querySelector('.sr-only')!.textContent).not.toContain('estimated');
    }
    // No estimate marker of either axis rides another figure: none on the cost of a
    // usage-only row, none on the tokens of a price-only row.
    expect(costCell(buttons[5]!)).not.toContain('est.');
    expect(tokens(4).textContent).not.toContain('est.');
  });
});

/** Durations and token counts on screen (adopt-figure-states D8; dashboard-core "Request
 * durations render at one precision" and "Token counts render compact in lists and readouts,
 * exact in the inspector"). The pure formatters are unit-tested in data/figures.test.ts; this
 * asserts the table and the inspector actually render through them. */
describe('latency and token counts render at one precision in the table and the inspector', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  const timed = (): RequestRow[] => {
    const at = (n: number): string =>
      new Date(Date.parse('2026-10-27T14:00:00Z') - n * 1000).toISOString();
    const ok: Partial<RequestRow> = {
      status: 'success',
      billed: true,
      usageEstimated: false,
      priceEstimated: false,
      priceSource: 'bundled',
      attemptCostMicros: 0,
      batchId: null,
      priceMode: null,
      attemptFailures: null,
      hasBodies: false,
    };
    return [
      { ...BASE, ...ok, id: 't-ms', createdAt: at(0), durationMs: 412, inputTokens: 999 },
      {
        ...BASE,
        ...ok,
        id: 't-s',
        createdAt: at(1),
        durationMs: 1_240,
        inputTokens: 12_431,
        outputTokens: 1_240_000,
      },
      { ...BASE, ...ok, id: 't-m', createdAt: at(2), durationMs: 125_000, inputTokens: 1_240 },
    ];
  };
  /** The inspector's duration value. */
  const inspectorDuration = (host: HTMLElement): string =>
    [...host.querySelectorAll<HTMLElement>('#inspector-drawer span')]
      .find((s) => s.textContent === 'duration')
      ?.nextElementSibling?.textContent?.trim() ?? '';

  it('formats latency by magnitude, and counts compact in the table but exact in the inspector', async () => {
    h = await mountRequests(timed());
    const buttons = [...h.host.querySelectorAll<HTMLElement>('button.req-row')];
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => cellValue(b, 'Latency').textContent?.trim())).toEqual([
      '412ms',
      '1.24s',
      '2m 05s',
    ]);
    const visibleTokens = (b: HTMLElement): string =>
      cellValue(b, 'Tokens').querySelector('[aria-hidden="true"]')?.textContent?.trim() ?? '';
    expect(visibleTokens(buttons[0]!)).toMatch(/^999↑ /);
    expect(visibleTokens(buttons[1]!)).toBe('12.4k↑ 1.2M↓');
    expect(visibleTokens(buttons[2]!)).toMatch(/^1\.2k↑ /);
    expect(cellValue(buttons[1]!, 'Tokens').querySelector('.sr-only')?.textContent).toBe(
      '12.4k tokens in, 1.2M out',
    );

    const expected = ['412ms', '1.24s', '2m 05s'];
    for (const [i, b] of buttons.entries()) {
      b.click();
      await flush();
      expect(inspectorDuration(h.host), `row ${String(i)} inspector duration`).toBe(expected[i]);
      if (i === 1) {
        // The inspector shows the same count exactly, with digit grouping.
        expect(
          h.host.querySelector('[data-testid="inspector-input-tokens"]')?.textContent?.trim(),
        ).toBe('12,431');
        expect(
          h.host.querySelector('[data-testid="inspector-output-tokens"]')?.textContent?.trim(),
        ).toBe('1,240,000');
      }
      h.host.querySelector<HTMLButtonElement>('button.drawer-close')?.click();
      await flush();
    }
  });
});
