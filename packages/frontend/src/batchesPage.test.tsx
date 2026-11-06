/**
 * The Batches page (add-batch-inference Phase D, tasks 7.1–7.3).
 *
 * The page exists for the questions the request table cannot answer, and each of
 * those is a claim that has to be exactly right:
 *
 * A reservation is not spend. Rendering `$0.0250` in a Cost column without saying
 * what it is turns money PROMISED into money spent — the one number on this page
 * a user would act on wrongly.
 *
 * Retention is the PROVIDER's, because polyrouter stores nothing. A job whose
 * provider states no deadline must say so rather than show a date polyrouter made
 * up, and the page carries that disclosure at the top rather than burying it.
 *
 * `0 / N` on a lost submission reads like a job that did nothing — true, but the
 * part that matters is that it cost nothing.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, type BatchJobDto } from './data/api';
import { PAGE_ICONS } from './components/PageIcon';
import { PAGES } from './state/route';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import type { Page } from './types';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const HOUR = 3_600_000;
const job = (id: string, over: Partial<BatchJobDto> = {}): BatchJobDto => ({
  id,
  upstreamBatchId: `up-${id}`,
  status: 'in_progress',
  terminal: false,
  endpoint: '/v1/chat/completions',
  agentId: 'ag',
  providerId: 'p1',
  providerLabel: 'OpenRouter',
  modelId: 'm1',
  modelLabel: `model-${id}`,
  tierAssigned: 'nightly',
  counts: { total: 50, completed: 12, failed: 0 },
  submittedAt: new Date(Date.now() - 3 * HOUR - 5 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  terminalAt: null,
  reservedCeilingMicros: 25_000,
  settledCostMicros: null,
  resultsExpireAt: null,
  errorKind: null,
  ...over,
});

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
  store.go('batches');
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

const rowsOf = (host: HTMLElement): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>('.rs-table-batches .rs-batch-row'),
];
const rowFor = (host: HTMLElement, id: string): HTMLElement =>
  rowsOf(host).find((r) => r.dataset['batchJob'] === id)!;
/** A row's Cost cell: its value, without the stacked layout's label. */
const costCell = (row: HTMLElement): HTMLElement => {
  const cell = [...row.querySelectorAll<HTMLElement>('.rs-cell')].find(
    (c) => c.querySelector('.rs-cell-label')?.textContent === 'Cost',
  );
  if (!cell) throw new Error('no Cost cell');
  return cell.querySelector<HTMLElement>('.cell-figure')!;
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the page is a first-class destination (7.1)', () => {
  it('is in the Page union, the route table, the icon registry and the primary nav', () => {
    expect((PAGES as readonly string[]).includes('batches')).toBe(true);
    // The registry is exhaustive over the union by construction — a missing entry
    // is a compile error, so this asserts the entry exists and is a component.
    expect(typeof PAGE_ICONS['batches' satisfies Page]).toBe('function');
  });

  it('reaches the page by hash, and shows the disclosure the whole feature rests on', async () => {
    const h = await mount(new FakeApiClient({ batchJobs: [job('j1')] }));
    try {
      expect(h.store.state.page).toBe('batches');
      const nav = [...h.host.querySelectorAll('button.nav-item')].find(
        (b) => b.textContent?.includes('Batches') ?? false,
      );
      expect(nav?.getAttribute('aria-current')).toBe('page');
      expect(h.host.textContent).toContain('polyrouter stores no results');
    } finally {
      h.dispose();
    }
  });

  it('renders the ten columns in order, with the same tracks on the head and every row', async () => {
    const h = await mount(
      new FakeApiClient({
        batchJobs: [job('j1'), job('j2', { status: 'completed', terminal: true })],
      }),
    );
    try {
      const head = h.host.querySelector('.rs-table-batches .table-head')!;
      expect([...head.children].map((c) => c.textContent)).toEqual([
        'Status',
        'Model',
        'Provider',
        'Tier',
        'Submitted',
        'Progress',
        'Wall time',
        'Cost',
        'Results until',
        '',
      ]);
      const rows = rowsOf(h.host);
      expect(rows).toHaveLength(2);
      // Column-edge equality: the template is declared ONCE on the shared class,
      // never inline, and every row occupies the same ten tracks as the head.
      for (const el of [head, ...rows]) {
        expect(el.getAttribute('style') ?? '').not.toMatch(/grid-template-columns/);
      }
      expect(rows[0]!.querySelectorAll('.rs-cell')).toHaveLength(head.children.length);
      expect(rows[1]!.querySelectorAll('.rs-cell')).toHaveLength(head.children.length);
    } finally {
      h.dispose();
    }
  });

  it('declares minmax tracks and a stacked reflow at the locked container width (7.3)', async () => {
    const [{ readFileSync }, { fileURLToPath }, { dirname, join }] = await Promise.all([
      import('node:fs'),
      import('node:url'),
      import('node:path'),
    ]);
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'styles.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const block =
      /\.rs-table-batches \.table-head,\s*\.rs-table-batches \.rs-batch-row \{[\s\S]*?\}/.exec(
        css,
      )![0];
    expect(block.match(/minmax\(0,/g)).toHaveLength(10);
    // The two-class rule carries the TEMPLATE and nothing else. A container query adds no
    // specificity, so `display: grid` declared here outranks the query's one-class
    // `.rs-batch-row { display: block }` and the table never reflows — it shipped that way
    // until the browser suite measured it at 390px.
    expect(block).not.toMatch(/display:/);
    expect(css).toMatch(/\.rs-batch-row \{\s*display: grid;/);
    // `.rs-cell` is `display: contents`, so a row's direct children carry no box: the rule
    // has to reach the cells' children or it sets min-width on nothing.
    expect(css).toMatch(/\.rs-table-batches \.rs-batch-row > \.rs-cell > \*\s*\{\s*min-width: 0;/);
    expect(css).toContain('container-name: rs-batches');
    // The same stacked-record reflow the requests table gets, at its own measured width
    // (adopt-design-tokens-v2 task 14.1: 1000px; requests is 980px).
    expect(css).toMatch(/@container rs-batches \(max-width: 1000px\)/);
    const lock = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'STYLESEED.md'),
      'utf8',
    );
    // The lock and the stylesheet change together, never one alone.
    expect(lock).toContain('`table-fit-batches`');
  });
});

describe('every row states what it actually knows (7.1)', () => {
  it('an active job shows a ceiling labelled as reserved, never as spend', async () => {
    const h = await mount(new FakeApiClient({ batchJobs: [job('active')] }));
    try {
      const row = rowFor(h.host, 'active');
      expect(row.textContent).toContain('In progress');
      expect(row.textContent).toContain('12 / 50');
      // A bound at cents, rounded UP: $0.025 reads `≤ $0.03`, never `up to` (adopt-figure-states 5.3).
      expect(row.textContent).toContain('≤ $0.03');
      expect(row.textContent).toContain('reserved, not spent');
      expect(row.textContent).not.toContain('up to');
      expect(row.textContent).toMatch(/3h 5m/);
      // The bar reflects the count and is decorative — the numbers carry it.
      const fill = row.querySelector<HTMLElement>('.rs-batch-bar > span')!;
      expect(fill.style.width).toBe('24%');
      expect(row.querySelector('.rs-batch-bar')!.getAttribute('aria-hidden')).toBe('true');
    } finally {
      h.dispose();
    }
  });

  it('a terminal job shows its settled cost and no reservation', async () => {
    const submittedAt = new Date(Date.now() - 5 * HOUR).toISOString();
    const h = await mount(
      new FakeApiClient({
        batchJobs: [
          job('done', {
            status: 'completed',
            terminal: true,
            counts: { total: 50, completed: 48, failed: 2 },
            submittedAt,
            terminalAt: new Date(Date.parse(submittedAt) + 2 * HOUR).toISOString(),
            reservedCeilingMicros: null,
            settledCostMicros: 12_345,
            resultsExpireAt: new Date(Date.now() + 20 * 24 * HOUR).toISOString(),
          }),
        ],
      }),
    );
    try {
      const row = rowFor(h.host, 'done');
      expect(row.textContent).toContain('Completed');
      expect(row.textContent).toContain('50 / 50');
      expect(row.textContent).toContain('$0.0123');
      expect(row.textContent).not.toContain('reserved, not spent');
      // Wall time is submission → settlement, not "until now".
      expect(row.textContent).toContain('2h 0m');
      // Retention is the provider's, and it is named.
      expect(row.textContent).toContain('OpenRouter');
      expect(row.textContent).not.toContain('retention unknown');
      // No cancel on a job that has already ended.
      expect([...row.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  it('reads a reserved ceiling as `≤ $x` at cents, rounded up, in Ink 2 above `reserved, not spent` (adopt-figure-states 5.3)', async () => {
    const h = await mount(
      new FakeApiClient({
        batchJobs: [
          job('three', { reservedCeilingMicros: 3_000_000 }),
          job('three-up', { reservedCeilingMicros: 3_004_000 }),
          job('speck', { reservedCeilingMicros: 40 }),
        ],
      }),
    );
    try {
      for (const [id, shown] of [
        ['three', '≤ $3.00'],
        ['three-up', '≤ $3.01'],
        ['speck', '≤ $0.01'],
      ] as const) {
        const cost = costCell(rowFor(h.host, id));
        const [ceiling, label] = [...cost.children] as HTMLElement[];
        expect(ceiling!.textContent, id).toBe(shown);
        expect(ceiling!.style.color, `${id}: the ceiling is Ink 2, never a cost`).toBe(
          'var(--text2)',
        );
        expect(label!.textContent).toBe('reserved, not spent');
        // The retired spellings, and a pending dash, are absent from the Cost cell.
        expect(cost.textContent).not.toContain('up to');
        expect(cost.textContent).not.toContain('—');
        expect(cost.textContent).not.toContain('<$');
      }
    } finally {
      h.dispose();
    }
  });

  it('a terminal job with a null settled cost reads `unpriced`, never a dash; a zero is measured', async () => {
    const terminal = { status: 'completed', terminal: true, reservedCeilingMicros: null } as const;
    const h = await mount(
      new FakeApiClient({
        batchJobs: [
          job('null', { ...terminal, settledCostMicros: null }),
          job('zero', { ...terminal, settledCostMicros: 0 }),
          job('speck', { ...terminal, settledCostMicros: 40 }),
        ],
      }),
    );
    try {
      const unpriced = costCell(rowFor(h.host, 'null'));
      expect(unpriced.textContent).toBe('unpriced');
      expect(unpriced.textContent).not.toContain('—');
      const word = [...unpriced.querySelectorAll<HTMLElement>('span')].find(
        (e) => e.textContent === 'unpriced' && e.children.length === 0,
      );
      expect(word?.style.color, 'unpriced is Ink 3').toBe('var(--text3)');
      // Four decimals, so the job reconciles with its items in the Requests table.
      expect(costCell(rowFor(h.host, 'zero')).textContent).toBe('$0.0000');
      expect(costCell(rowFor(h.host, 'speck')).textContent).toBe('<$0.0001');
    } finally {
      h.dispose();
    }
  });

  it('a lost submission says nothing was charged; a reconciling job says why it is waiting', async () => {
    const h = await mount(
      new FakeApiClient({
        batchJobs: [
          job('lost', {
            status: 'failed',
            terminal: true,
            errorKind: 'submit_lost',
            counts: { total: 20, completed: 0, failed: 0 },
            reservedCeilingMicros: null,
            settledCostMicros: 0,
          }),
          job('rec', {
            status: 'submission_unknown',
            counts: { total: 8, completed: 0, failed: 0 },
          }),
        ],
      }),
    );
    try {
      const lost = rowFor(h.host, 'lost');
      expect(lost.textContent).toContain('Failed');
      expect(lost.textContent).toContain('0 / 20');
      expect(lost.textContent).toContain('submission lost — nothing charged');
      const rec = rowFor(h.host, 'rec');
      expect(rec.textContent).toContain('Reconciling');
      expect(rec.textContent).toContain('reconciling with provider');
    } finally {
      h.dispose();
    }
  });

  it('says retention is unknown rather than inventing a date, and calls an unbounded ceiling what it is', async () => {
    const h = await mount(
      new FakeApiClient({
        batchJobs: [job('unknown', { resultsExpireAt: null, reservedCeilingMicros: null })],
      }),
    );
    try {
      const row = rowFor(h.host, 'unknown');
      expect(row.textContent).toContain('retention unknown — check provider');
      expect(row.textContent).toContain('unbounded');
    } finally {
      h.dispose();
    }
  });

  it('shows an empty state that tells the reader how to make one', async () => {
    const h = await mount(new FakeApiClient({ batchJobs: [] }));
    try {
      expect(rowsOf(h.host)).toHaveLength(0);
      expect(h.host.textContent).toContain('No batches yet');
      expect(h.host.textContent).toContain('POST /v1/batches');
    } finally {
      h.dispose();
    }
  });

  it('keeps the last known list on screen when a refresh fails, and says it may be stale', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('keep')] });
    const h = await mount(fake);
    try {
      expect(rowsOf(h.host)).toHaveLength(1);
      fake.batchesFailure = Object.assign(new Error('down'), { status: 503 }) as never;
      await h.store.listBatches({ limit: 1 }).catch(() => undefined);
      // Drive the page's own reload through its poller-equivalent path.
      h.store.go('overview');
      await flush();
      h.store.go('batches');
      await flush();
      await flush();
      expect(h.host.textContent).toContain('Could not refresh batches');
    } finally {
      h.dispose();
    }
  });
});

describe('cancelling is destructive, and behaves like it (7.2)', () => {
  it('confirms first, states what is abandoned, and only then calls the endpoint', async () => {
    const fake = new FakeApiClient({
      batchJobs: [job('c1', { counts: { total: 50, completed: 12, failed: 3 } })],
    });
    const h = await mount(fake);
    try {
      const cancel = [...rowFor(h.host, 'c1').querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Cancel',
      )!;
      // Ten active rows would otherwise offer ten buttons all named "Cancel".
      expect(cancel.getAttribute('aria-label')).toBe('Cancel batch on model-c1');
      cancel.click();
      await flush();
      const dialog = h.host.querySelector('.confirm-card')!;
      // The real modal contract: a labelled dialog, not a bare div claiming one.
      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-label')).toBe('Cancel batch');
      expect(dialog.textContent).toContain('35 of 50 requests have not run yet');
      expect(dialog.textContent).toContain('still recorded and still charged');
      // Nothing has happened yet.
      expect(fake.callLog.some((c) => c.method === 'cancelBatch')).toBe(false);

      [...dialog.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Cancel batch'))!
        .click();
      await flush();
      await flush();
      expect(fake.callLog.filter((c) => c.method === 'cancelBatch').map((c) => c.args[0])).toEqual([
        'c1',
      ]);
      expect(h.host.querySelector('.confirm-card')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  // adopt-red-destructive-actions task 4.3: the dialog moved onto the shared destructive
  // confirmation, keeping its name, title, body and dismiss label.
  const openCancel = async (h: { host: HTMLElement }, id: string): Promise<HTMLElement> => {
    const trigger = [...rowFor(h.host, id).querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Cancel',
    )!;
    trigger.focus();
    trigger.click();
    await flush();
    const dialog = h.host.querySelector<HTMLElement>('.confirm-card');
    expect(dialog, 'Cancel opened no dialog').not.toBeNull();
    return dialog!;
  };
  const commitOf = (dialog: HTMLElement): HTMLButtonElement =>
    dialog.querySelector<HTMLButtonElement>('button.btn-destructive')!;

  it('keeps its name, puts Keep running first, and commits with the red destructive fill', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('c3')] });
    const h = await mount(fake);
    try {
      const trigger = [...rowFor(h.host, 'c3').querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Cancel',
      )!;
      // The row's trigger is the destructive ghost, and keeps the name that says which batch.
      expect(trigger.className).toBe('btn-ghost btn-ghost--destructive');
      expect(trigger.getAttribute('aria-label')).toBe('Cancel batch on model-c3');
      const dialog = await openCancel(h, 'c3');
      expect(dialog.getAttribute('aria-label')).toBe('Cancel batch');
      expect(dialog.querySelector('.section-title')?.textContent).toBe('Cancel this batch?');
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
      expect(buttons.map((b) => b.className)).toEqual(['btn-cancel', 'btn-destructive']);
      expect(buttons[0]!.textContent?.trim()).toBe('Keep running');
      expect(document.activeElement, 'Keep running holds the initial focus').toBe(buttons[0]);
      expect(dialog.querySelector('.btn-primary'), 'an indigo primary in the dialog').toBeNull();
      expect(commitOf(dialog).textContent).toContain('Cancel batch');
    } finally {
      h.dispose();
    }
  });

  it('sends one cancel per double activation, reading Cancelling… while it runs', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('c4')] });
    const h = await mount(fake);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const real = fake.cancelBatch.bind(fake);
    const cancel = vi
      .spyOn(fake, 'cancelBatch')
      .mockImplementation((id: string) => held.then(() => real(id)));
    try {
      const dialog = await openCancel(h, 'c4');
      const commit = commitOf(dialog);
      commit.click();
      commit.click();
      await flush();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(commit.disabled).toBe(true);
      expect(commit.getAttribute('aria-busy')).toBe('true');
      expect(commit.querySelector('[data-shown="true"]')?.textContent).toBe('Cancelling…');
      release();
      await flush();
      await flush();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(h.host.querySelector('.confirm-card')).toBeNull();
      // The commit held through the reload, so the list it closed onto shows the job cancelling.
      expect(rowFor(h.host, 'c4').textContent).toContain('Cancelling');
      // The reload re-created the rows, and with them the trigger: focus lands on the table
      // (D8), a stable point on the page, never the body.
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Batches');
      expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
    } finally {
      h.dispose();
    }
  });

  it('a failed cancel keeps the dialog open, says why, and leaves the job running', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('c5')] });
    const h = await mount(fake);
    vi.spyOn(fake, 'cancelBatch').mockRejectedValueOnce(
      new ApiError(409, 'Conflict', 'the provider already finalized it'),
    );
    try {
      const dialog = await openCancel(h, 'c5');
      commitOf(dialog).click();
      await flush();
      expect(h.store.state.destructive, 'the failure closed the dialog').not.toBeNull();
      expect(h.host.querySelector('.confirm-card')).toBe(dialog);
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
        'the provider already finalized it',
      );
      expect(commitOf(dialog).disabled).toBe(false);
      expect(rowFor(h.host, 'c5').textContent).toContain('In progress');
      expect(h.store.state.toast).toBeNull();
    } finally {
      h.dispose();
    }
  });

  // A review asked for the dialog to stay open when the reload after an accepted cancel fails.
  // It closes: the destructive request succeeded (ADDED "the dialog closes once the request
  // succeeds"), so an alert reading "Cancel batch failed" would report a failure that did not
  // happen, and a retry would send a second cancel. The failed read is the page's, reported by
  // the same stale-list banner as any failed refresh, as it was before the dialog moved.
  it('a cancel the provider accepted closes the dialog even when the reload after it fails', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('c6')] });
    const h = await mount(fake);
    const real = fake.cancelBatch.bind(fake);
    const cancel = vi.spyOn(fake, 'cancelBatch').mockImplementation(async (id: string) => {
      const accepted = await real(id);
      fake.batchesFailure = new ApiError(503, 'Unavailable', 'the batch list is unavailable');
      return accepted;
    });
    try {
      const dialog = await openCancel(h, 'c6');
      commitOf(dialog).click();
      await flush();
      await flush();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(
        h.host.querySelector('.confirm-card'),
        'an accepted cancel kept the dialog open',
      ).toBeNull();
      expect(h.store.state.destructive).toBeNull();
      expect(h.host.textContent).toContain(
        'Could not refresh batches — showing the last known list.',
      );
      expect(h.store.state.toast?.kind, 'the refresh failure was toasted').not.toBe('failure');
      expect(document.activeElement, 'focus fell to the document body').not.toBe(document.body);
    } finally {
      h.dispose();
    }
  });

  it('dismissing the dialog leaves the job alone', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('c2')] });
    const h = await mount(fake);
    try {
      [...rowFor(h.host, 'c2').querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Cancel')!
        .click();
      await flush();
      [...h.host.querySelectorAll<HTMLButtonElement>('.confirm-card button')]
        .find((b) => b.textContent?.includes('Keep running'))!
        .click();
      await flush();
      expect(h.host.querySelector('.confirm-card')).toBeNull();
      expect(fake.callLog.some((c) => c.method === 'cancelBatch')).toBe(false);
    } finally {
      h.dispose();
    }
  });
});
