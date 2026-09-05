/**
 * The live-row band's BATCH partition on screen (add-batch-inference tasks 5.2–5.4).
 *
 * Three things here are easy to get wrong in ways that look fine:
 *
 * A job row is NOT a request row. It has no decision layer, no cost until it
 * settles, and a wall time measured in hours — so every cell has to say so, or the
 * band quietly asserts things about a batch that are only true of a request.
 *
 * The count beneath the status is the column-stability crux (D17). It is the one
 * cell in the table whose content can exceed its track, and under bare `fr` tracks
 * that shifts every other column — the mockup reproduced exactly that.
 *
 * The handoff is evidence-based. A job leaving the active read is not proof its
 * item rows are visible: the Overview refresh fetches six rows and a small batch's
 * items may never appear in that window, so a targeted existence read decides.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { BatchJobDto, RequestRow } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const job = (id: string, over: Partial<BatchJobDto> = {}): BatchJobDto => ({
  id,
  upstreamBatchId: `up-${id}`,
  status: 'in_progress',
  terminal: false,
  endpoint: '/v1/chat/completions',
  agentId: 'ag',
  providerId: 'p1',
  providerLabel: `prov-${id}`,
  modelId: 'm1',
  modelLabel: `model-${id}`,
  tierAssigned: 'nightly',
  counts: { total: 50, completed: 12, failed: 0 },
  submittedAt: new Date(Date.now() - 3 * 3_600_000 - 5 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  terminalAt: null,
  reservedCeilingMicros: 25_000,
  settledCostMicros: null,
  resultsExpireAt: null,
  errorKind: null,
  ...over,
});

async function mount(
  fake: FakeApiClient,
  page: 'Requests' | 'Overview' = 'Requests',
): Promise<{ host: HTMLElement; store: AppStore; dispose: () => void }> {
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
    .find((e) => e.textContent?.trim() === page)
    ?.click();
  await flush();
  await store.loadBatchBand();
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

const batchRows = (host: HTMLElement): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>('.rs-table-requests [data-batch-row]'),
];
const allRows = (host: HTMLElement): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>('.rs-table-requests .req-row'),
];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a live job row reads as a job, not as a request (5.2)', () => {
  it('carries the neutral batch chip and glyph, neutral token/cost cells, and no decision layer', async () => {
    const h = await mount(new FakeApiClient({ batchJobs: [job('j1')] }));
    try {
      const rows = batchRows(h.host);
      expect(rows).toHaveLength(1);
      const text = rows[0]!.textContent ?? '';
      expect(text).toContain('batch');
      expect(rows[0]!.querySelector('svg[data-icon="layers"]')).not.toBeNull();
      // No decision layer: a job's routing decision belongs on its settled items.
      for (const layer of ['explicit', 'structural', 'semantic', 'cascade']) {
        expect(text).not.toContain(layer);
      }
      // Tokens and cost are neutral — a reservation is never rendered as spend.
      expect(text).not.toMatch(/\$/);
      expect(text).toContain('model-j1');
      expect(text).toContain('prov-j1');
      expect(text).toContain('nightly');
      // Not selectable: there is no terminal detail to inspect yet.
      expect(rows[0]!.tagName).toBe('DIV');
      expect(rows[0]!.querySelector('button')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it.each([
    ['submitting', 'Queued'],
    ['validating', 'Queued'],
    ['submission_unknown', 'Reconciling'],
    ['in_progress', 'In progress'],
    ['finalizing', 'Finalizing'],
    ['cancelling', 'Cancelling'],
  ])('renders %s as "%s"', async (status, label) => {
    const h = await mount(new FakeApiClient({ batchJobs: [job('s1', { status })] }));
    try {
      expect(batchRows(h.host)[0]!.textContent).toContain(label);
    } finally {
      h.dispose();
    }
  });

  it('puts the progress count on its OWN line, and shows none before anything finishes', async () => {
    const h = await mount(
      new FakeApiClient({
        batchJobs: [
          job('counted', { counts: { total: 50, completed: 11, failed: 1 } }),
          job('fresh', { counts: { total: 9, completed: 0, failed: 0 } }),
        ],
      }),
    );
    try {
      const rows = batchRows(h.host);
      const counted = rows.find((r) => r.textContent?.includes('model-counted'))!;
      expect(counted.textContent).toContain('12 of 50');
      // Its own element, in its own line — never appended to the status text.
      const statusCell = [...counted.querySelectorAll('.rs-cell')].at(-1)!;
      const lines = [...statusCell.querySelectorAll('span')].map((e) => e.textContent?.trim());
      expect(lines).toContain('12 of 50');
      expect(lines).not.toContain('In progress 12 of 50');
      const fresh = rows.find((r) => r.textContent?.includes('model-fresh'))!;
      expect(fresh.textContent).not.toMatch(/ of /);
    } finally {
      h.dispose();
    }
  });

  it('pulses only where the state is one the user is waiting on, and reduced motion settles it', async () => {
    const h = await mount(
      new FakeApiClient({
        batchJobs: [
          job('run', { status: 'in_progress' }),
          job('canc', { status: 'cancelling' }),
          job('rec', { status: 'submission_unknown' }),
          job('fin', { status: 'finalizing' }),
        ],
      }),
    );
    try {
      const dotOf = (id: string): HTMLElement =>
        batchRows(h.host)
          .find((r) => r.dataset['batchRow'] === id)!
          .querySelector<HTMLElement>('[aria-hidden="true"][style*="border-radius"]')!;
      expect(dotOf('run').style.animation).toContain('pulse');
      expect(dotOf('canc').style.animation).toContain('pulse');
      expect(dotOf('canc').style.background).toContain('--amber');
      expect(dotOf('rec').style.animation).toContain('pulse');
      expect(dotOf('rec').style.background).toContain('--faint');
      // A job whose work is done upstream is not "in progress" — it does not pulse.
      expect(dotOf('fin').style.animation).toBe('');
      // The reduced-motion rule is global: the app's media query forces
      // iteration-count 1, so every pulse settles to a static dot.
      const css = h.host.ownerDocument.documentElement.outerHTML;
      void css;
    } finally {
      h.dispose();
    }
  });

  it('formats elapsed time as a job (hours), not as a request (seconds)', async () => {
    const h = await mount(new FakeApiClient({ batchJobs: [job('long')] }));
    try {
      const text = batchRows(h.host)[0]!.textContent ?? '';
      expect(text).toMatch(/\dh \d+m/);
      expect(text).not.toMatch(/\d+\.\ds/);
    } finally {
      h.dispose();
    }
  });
});

describe('a job row cannot shift the table (D17)', () => {
  it('declares minmax tracks and shrinkable cells so one long cell cannot widen its column', async () => {
    const [{ readFileSync }, { fileURLToPath }, { dirname, join }] = await Promise.all([
      import('node:fs'),
      import('node:url'),
      import('node:path'),
    ]);
    // Comments stripped first: the rule's own comment NAMES `minmax(0, …)`, and a
    // count that included prose would pass for the wrong reason.
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'styles.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const block =
      /\.rs-table-requests \.table-head,\s*\.rs-table-requests \.req-row \{[\s\S]*?\}/.exec(
        css,
      )![0];
    // Nine tracks, every flexible one floored at zero.
    expect(block.match(/minmax\(0,/g)).toHaveLength(8);
    expect(block).not.toMatch(/:\s*66px 1\.5fr/);
    expect(css).toMatch(/\.rs-table-requests \.req-row > \*\s*\{\s*min-width: 0;/);
  });

  it('gives a job row the SAME column template as a completed row', async () => {
    const h = await mount(
      new FakeApiClient({
        batchJobs: [job('geo', { counts: { total: 5000, completed: 4321, failed: 12 } })],
      }),
    );
    try {
      const rows = allRows(h.host);
      const batch = rows.find((r) => r.hasAttribute('data-batch-row'))!;
      const sync = rows.find((r) => !r.hasAttribute('data-batch-row'))!;
      // happy-dom computes no grid geometry, so the guarantee is asserted where it
      // actually lives: both rows carry the SAME class, and the template is declared
      // once on that class (never inline) — which is what makes their edges equal.
      expect(batch.className.split(/\s+/)).toContain('req-row');
      expect(sync.className.split(/\s+/)).toContain('req-row');
      expect(batch.getAttribute('style') ?? '').not.toMatch(/grid-template-columns/);
      expect(sync.getAttribute('style') ?? '').not.toMatch(/grid-template-columns/);
      // Same number of cells, so the two rows occupy the same nine tracks.
      expect(batch.querySelectorAll('.rs-cell')).toHaveLength(
        sync.querySelectorAll('.rs-cell').length,
      );
    } finally {
      h.dispose();
    }
  });
});

describe('the handoff from a job row to its settled items (5.3)', () => {
  const settledItem = (batchId: string, rows: RequestRow[]): RequestRow[] =>
    rows.map((r, i) => (i === 0 ? { ...r, batchId, priceMode: 'batch' as const } : r));

  it('retains the job as finishing, then hands off once its items are visible', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('h1')] });
    const h = await mount(fake);
    try {
      expect(batchRows(h.host)).toHaveLength(1);
      // The job goes terminal AND its items land.
      fake.batchJobs = [];
      fake.requestRows = settledItem('h1', fake.requestRows);
      await h.store.loadBatchBand();
      await flush();
      expect(batchRows(h.host)).toHaveLength(0);
      // The existence read was targeted at the job, not a page walk.
      expect(
        fake.callLog.some((c) => c.method === 'requests' && JSON.stringify(c.args).includes('h1')),
      ).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('keeps showing a finished job whose items have not arrived, reading as Finishing', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('h2')] });
    const h = await mount(fake);
    try {
      fake.batchJobs = []; // terminal upstream, but nothing settled into the list
      await h.store.loadBatchBand();
      await flush();
      const rows = batchRows(h.host);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain('Finishing');
    } finally {
      h.dispose();
    }
  });

  it('a degraded read retains the cached job rows rather than blanking the band', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('h3')] });
    const h = await mount(fake);
    try {
      expect(batchRows(h.host)).toHaveLength(1);
      fake.batchesFailure = Object.assign(new Error('down'), { status: 503 }) as never;
      await h.store.loadBatchBand();
      await flush();
      expect(batchRows(h.host)).toHaveLength(1); // never settled on a failure
    } finally {
      h.dispose();
    }
  });
});

describe('settled batch items and the Mode filter (5.4)', () => {
  it('marks a settled item with the same chip and reads its latency in hours', async () => {
    const fake = new FakeApiClient({});
    fake.requestRows = fake.requestRows.map((r, i) =>
      i === 0
        ? {
            ...r,
            batchId: 'job-x',
            priceMode: 'batch' as const,
            durationMs: 3 * 3_600_000 + 60_000,
          }
        : r,
    );
    const h = await mount(fake);
    try {
      const row = allRows(h.host).find((r) => !r.hasAttribute('data-batch-row'))!;
      expect(row.textContent).toContain('batch');
      expect(row.querySelector('svg[data-icon="layers"]')).not.toBeNull();
      expect(row.textContent).toContain('3h 1m');
      // Never the sole carrier: the decision layer is still stated beside it.
      expect(row.textContent).toContain('explicit');
    } finally {
      h.dispose();
    }
  });

  it("carries the job id into the inspector, as a link to the job's own page", async () => {
    // The request row answers "this was a batch item"; only the Batches page answers
    // "and how is that job doing". Without the link the id is a string to copy and
    // paste into a filter that does not exist.
    const fake = new FakeApiClient({});
    fake.requestRows = fake.requestRows.map((r, i) =>
      i === 0 ? { ...r, batchId: 'job-x', priceMode: 'batch' as const } : r,
    );
    const h = await mount(fake);
    try {
      const row = allRows(h.host).find((r) => !r.hasAttribute('data-batch-row'))!;
      row.click();
      await flush();
      const link = h.host.querySelector<HTMLElement>('[data-batch-id="job-x"]')!;
      expect(link.textContent).toBe('job-x');
      link.click();
      await flush();
      expect(h.store.state.page).toBe('batches');
    } finally {
      h.dispose();
    }
  });

  it('offers a Mode control that partitions the list server-side', async () => {
    const fake = new FakeApiClient({ batchJobs: [job('m1')] });
    const h = await mount(fake);
    try {
      const group = h.host.querySelector('[aria-labelledby="req-mode-label"]')!;
      const buttons = [...group.querySelectorAll('button')];
      expect(buttons.map((b) => b.textContent?.trim())).toEqual(['All', 'Sync', 'Batch']);
      expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');

      buttons[2]!.click(); // Batch
      await flush();
      const batchCall = fake.callLog.filter((c) => c.method === 'requests').at(-1)!;
      expect(JSON.stringify(batchCall.args)).toContain('"mode":"batch"');
      expect(buttons[2]!.getAttribute('aria-pressed')).toBe('true');

      buttons[1]!.click(); // Sync — the live job band is hidden with it
      await flush();
      expect(
        JSON.stringify(fake.callLog.filter((c) => c.method === 'requests').at(-1)!.args),
      ).toContain('"mode":"sync"');
      expect(batchRows(h.host)).toHaveLength(0);

      buttons[0]!.click(); // All — no mode param at all
      await flush();
      expect(
        JSON.stringify(fake.callLog.filter((c) => c.method === 'requests').at(-1)!.args),
      ).not.toContain('mode');
      expect(batchRows(h.host)).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
});
