import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { AutoPerformance } from './data/api';
import { DEFAULT_AUTO_PERF, FakeApiClient } from './test/fakeClient';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';

/** add-workload-telemetry 5.1/5.2 §render: the Workload mix block's states on the
 * real Routing page, and the inspector's workload chip (VM logic is unit-tested
 * in data/autoPerf.test.ts / data/analytics.test.ts — this file asserts the
 * surfaces actually render, honestly, from the fake API). */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

type Mix = AutoPerformance['workloadMix'];
const mix = (over: Partial<Mix> = {}): Mix => ({
  evaluated: 0,
  unclassified: 0,
  since: null,
  revisions: [],
  classes: [],
  ...over,
});
const cls = (
  c: string,
  requests: number,
  spendUsd: number | null,
  over: Partial<Mix['classes'][number]> = {},
): Mix['classes'][number] => ({
  class: c,
  requests,
  unpricedRequests: 0,
  unpricedAttempts: 0,
  spendUsd,
  routed: 0,
  ...over,
});

interface Harness {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}

async function mount(
  autoPerf: Partial<AutoPerformance>,
  page: 'Routing' | 'Requests' = 'Routing',
): Promise<Harness> {
  const fake = new FakeApiClient({ autoPerf: { ...DEFAULT_AUTO_PERF, ...autoPerf } });
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
  const nav = [...host.querySelectorAll<HTMLElement>('.nav-item span')].find(
    (e) => e.textContent?.trim() === page,
  );
  nav?.click();
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

const q = (h: Harness, id: string): HTMLElement | null =>
  h.host.querySelector(`[data-testid="${id}"]`);
const rows = (h: Harness): HTMLElement[] => [
  ...h.host.querySelectorAll<HTMLElement>('[data-testid="workload-row"]'),
];

describe('Workload mix block (add-workload-telemetry)', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('renders present classes with shares summing to 100%, the none wording, spend, and the footnote', async () => {
    h = await mount({
      workloadMix: mix({
        evaluated: 10,
        since: '2026-07-12T00:00:00.000Z',
        revisions: [{ revision: 'structural/v1/c1/aaa', requests: 10 }],
        classes: [
          cls('code', 5, 2),
          cls('none', 3, 0.1),
          cls('structured', 2, 0.5, { unpricedRequests: 1 }),
        ],
      }),
    });
    const block = q(h, 'workload-mix');
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain('of workload-classified auto requests');
    const r = rows(h);
    expect(r).toHaveLength(3);
    expect(r[0]!.textContent).toContain('code');
    expect(r[0]!.textContent).toContain('50%');
    expect(r[1]!.textContent).toContain('no specialist workload');
    expect(r[1]!.textContent).toContain('30%');
    expect(r[2]!.textContent).toContain('structured');
    expect(r[2]!.textContent).toContain('1 unpriced');
    expect(q(h, 'workload-mix-footnote')!.textContent).toContain(
      'research and writing arrive with the semantic workload source',
    );
    expect(q(h, 'workload-mix-coverage')).toBeNull();
    expect(q(h, 'workload-mix-revisions')).toBeNull();
    expect(q(h, 'workload-mix-attempt-only')).toBeNull();
  });

  it('spend honesty: unpriced → dash + "unpriced"; free → $0 without a qualifier; attempt-side unpriced qualifies', async () => {
    h = await mount({
      workloadMix: mix({
        evaluated: 3,
        classes: [
          cls('vision', 1, null, { unpricedRequests: 1 }),
          cls('code', 1, 0),
          cls('structured', 1, 1, { unpricedAttempts: 1 }),
        ],
      }),
    });
    const byLabel = (label: string): HTMLElement =>
      rows(h!).find((e) => e.textContent?.includes(label))!;
    expect(byLabel('vision').textContent).toContain('—');
    expect(byLabel('vision').textContent).toContain('unpriced');
    expect(byLabel('code').textContent).toMatch(/\$0/);
    expect(byLabel('code').textContent).not.toContain('unpriced');
    expect(byLabel('structured').textContent).toContain('1 unpriced');
  });

  it('attempt-only classes are NOT an empty state: zero share + spend + the note, even with evaluated 0', async () => {
    h = await mount({
      workloadMix: mix({ evaluated: 0, classes: [cls('code', 0, 0.25, { unpricedAttempts: 0 })] }),
    });
    expect(q(h, 'workload-mix')).not.toBeNull();
    expect(q(h, 'workload-mix-empty')).toBeNull();
    expect(q(h, 'workload-mix-attempt-only')!.textContent).toContain(
      'attempt spend but no classified parent requests',
    );
    expect(rows(h)[0]!.textContent).toContain('0%');
  });

  it('discloses coverage (structurally evaluated wording) and multi-revision ranges', async () => {
    h = await mount({
      workloadMix: mix({
        evaluated: 8,
        unclassified: 2,
        revisions: [
          { revision: 'structural/v1/c1/aaa', requests: 5 },
          { revision: 'structural/v1/c1/bbb', requests: 3 },
        ],
        classes: [cls('none', 8, 0)],
      }),
    });
    expect(q(h, 'workload-mix-coverage')!.textContent).toBe(
      '8 of 10 structurally evaluated auto requests carry workload telemetry',
    );
    expect(q(h, 'workload-mix-revisions')!.textContent).toBe(
      'request figures span 2 classifier revisions',
    );
  });

  it('empty states key on the WORKLOAD since — pre-capture vs never — independent of structural telemetrySince', async () => {
    h = await mount({ workloadMix: mix({ since: '2026-07-12T00:00:00.000Z' }) });
    expect(q(h, 'workload-mix')).toBeNull();
    expect(q(h, 'workload-mix-empty')!.textContent).toContain('workload capture begins');
    h.dispose();
    // DEFAULT_AUTO_PERF has structural telemetrySince set — it must NOT stand in.
    h = await mount({ workloadMix: mix({ since: null }) });
    expect(q(h, 'workload-mix-empty')!.textContent).toContain('No workload telemetry yet');
  });
});

describe('Inspector workload chip (add-workload-telemetry 5.1)', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('shows `workload · <class> (<source>)`, the plain-language none, and nothing for unevaluated rows', async () => {
    h = await mount({}, 'Requests');
    const buttons = [...h.host.querySelectorAll<HTMLButtonElement>('button.req-row')];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    const seen: (string | null)[] = [];
    for (const b of buttons.slice(0, 6)) {
      b.click();
      await flush();
      const chip = h.host.querySelector('[data-testid="workload-chip"]');
      seen.push(chip === null ? null : chip.textContent);
      // close the drawer
      const close = h.host.querySelector<HTMLButtonElement>('#inspector-drawer button');
      close?.click();
      await flush();
    }
    expect(seen).toContain('workload · code (structural)');
    expect(seen).toContain('no specialist workload (structural)');
    expect(seen).toContain(null); // a never-classified row shows no chip
  });

  it('a workload-ROUTED row reads `router · workload` and the chip says routed; a classified-only row does not (add-workload-routing)', async () => {
    h = await mount({}, 'Requests');
    const idx = h.store.state.requestList.findIndex((r) => r.workloadClass === 'code');
    expect(idx).toBeGreaterThanOrEqual(0);
    const open = async (): Promise<{ router: string; chip: string | null }> => {
      const buttons = [...h!.host.querySelectorAll<HTMLButtonElement>('button.req-row')];
      buttons[idx]!.click();
      await flush();
      const drawer = h!.host.querySelector('#inspector-drawer')!;
      const router =
        [...drawer.querySelectorAll<HTMLElement>('*')]
          .map((e) => e.textContent ?? '')
          .find((t) => /^router · \w+$/.test(t.trim())) ?? '';
      const chip = drawer.querySelector('[data-testid="workload-chip"]')?.textContent ?? null;
      drawer.querySelector<HTMLButtonElement>('button')?.click();
      await flush();
      return { router: router.trim(), chip };
    };
    const before = await open();
    expect(before.chip).toBe('workload · code (structural)');
    expect(before.router).not.toBe('router · workload');
    h.store.setState('requestList', idx, 'decisionLayer', 'workload');
    const after = await open();
    expect(after.router).toBe('router · workload');
    expect(after.chip).toBe('workload · code (structural) · routed');
  });
});
