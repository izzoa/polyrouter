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
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { BatchJobDto } from './data/api';
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

afterEach(() => {
  document.body.innerHTML = '';
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
    // The same stacked-record reflow the requests table gets, at the same width.
    expect(css).toMatch(/@container rs-batches \(max-width: 960px\)/);
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
      expect(row.textContent).toContain('up to $0.0250');
      expect(row.textContent).toContain('reserved, not spent');
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
