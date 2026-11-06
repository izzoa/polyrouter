/** The Agents page's per-agent figures under the figure states (adopt-figure-states task 3.4;
 * dashboard-core "Loading figures render a skeleton with a text equivalent", "A lone dash in a
 * figure slot means pending", "Failed, unavailable and absent figures are distinct states").
 *
 * Before: the figures read a lone `—` until they loaded, a reload cleared them first, and a
 * failed load left `—` forever. Now they load as named skeletons, a refetch keeps them, and a
 * failed read removes them under a notice whose Retry hands focus to the agents table.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { ApiError, type AgentDto, type BreakdownRow } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const agent = (id: string, name: string): AgentDto => ({
  id,
  name,
  harness: 'claude-code',
  prefix: `poly_${id}`,
  lastUsedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
});
const AGENTS = [agent('a-busy', 'busy-agent'), agent('a-idle', 'idle-agent')];

const row = (key: string, requests: number, spend: number): BreakdownRow => ({
  key,
  label: key,
  spend,
  requests,
  estimatedTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** A fake whose agent breakdown can be held in flight and released, or failed, on demand. */
class AgentStatsFake extends FakeApiClient {
  hold = false;
  private parked: (() => void)[] = [];
  constructor(rows: BreakdownRow[]) {
    super({ agents: AGENTS, breakdown: { agent: rows, model: [], provider: [], tier: [] } });
  }
  override breakdown(...args: Parameters<FakeApiClient['breakdown']>): Promise<BreakdownRow[]> {
    if (!this.hold) return super.breakdown(...args);
    return new Promise<BreakdownRow[]>((resolve, reject) => {
      this.parked.push(() => {
        super.breakdown(...args).then(resolve, reject);
      });
    });
  }
  release(): void {
    this.hold = false;
    for (const go of this.parked.splice(0)) go();
  }
}

interface Harness {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}

async function openAgents(fake: FakeApiClient): Promise<Harness> {
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
    (e) => labelText(e) === 'Agents',
  );
  if (!nav) throw new Error('no Agents nav item');
  nav.click();
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

/** One agent row's two figure cells, as rendered. */
function figures(h: Harness, name: string): { requests: HTMLElement; spend: HTMLElement } {
  const r = [...h.host.querySelectorAll<HTMLElement>('.rs-agent-row')].find((e) =>
    e.textContent?.includes(name),
  );
  if (!r) throw new Error(`no row for ${name}`);
  const cells = [...r.querySelectorAll<HTMLElement>('.cell-figure')];
  if (cells.length !== 2) throw new Error(`${name} has ${String(cells.length)} figure cells`);
  return { requests: cells[0]!, spend: cells[1]! };
}

/** A figure cell's own text: its field label (shown when the table stacks) left out. */
const value = (cell: HTMLElement): string =>
  [...cell.childNodes]
    .filter((n) => !(n instanceof HTMLElement && n.classList.contains('rs-cell-label')))
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();

const panel = (h: Harness): HTMLElement => h.host.querySelector<HTMLElement>('.rs-table-agents')!;
const notice = (h: Harness): HTMLElement | null =>
  [...h.host.querySelectorAll<HTMLElement>('.notice')].find((n) =>
    n.textContent?.includes('Agent activity'),
  ) ?? null;

describe('the Agents page names its figure states', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('loads as named skeletons, never a dash or a zero, then shows measured figures', async () => {
    const fake = new AgentStatsFake([row('a-busy', 42, 1.5)]);
    fake.hold = true;
    h = await openAgents(fake);
    for (const name of ['busy-agent', 'idle-agent']) {
      const { requests, spend } = figures(h, name);
      expect(value(requests)).toBe('Loading requests');
      expect(value(spend)).toBe('Loading spend');
      for (const cell of [requests, spend]) {
        expect(cell.querySelector('.sr-only')?.textContent).toMatch(/^Loading (requests|spend)$/);
        expect(cell.querySelector('.fig-skel')?.getAttribute('aria-hidden')).toBe('true');
      }
    }
    expect(panel(h).textContent).not.toContain('—');
    fake.release();
    await flush();
    expect(value(figures(h, 'busy-agent').requests)).toBe('42');
    expect(value(figures(h, 'busy-agent').spend)).toBe('$1.50');
    // An idle agent shows measured zeros: `0` and `$0.00`, never `$0` or a dash.
    expect(value(figures(h, 'idle-agent').requests)).toBe('0');
    expect(value(figures(h, 'idle-agent').spend)).toBe('$0.00');
    expect(panel(h).querySelector('.fig-skel')).toBeNull();
  });

  it('reads spend at cents, below precision as `<$0.01`', async () => {
    h = await openAgents(new AgentStatsFake([row('a-busy', 3, 0.004)]));
    expect(value(figures(h, 'busy-agent').spend)).toBe('<$0.01');
  });

  it('a refetch keeps the previous figures, with no skeleton in their place', async () => {
    const fake = new AgentStatsFake([row('a-busy', 42, 1.5)]);
    h = await openAgents(fake);
    expect(value(figures(h, 'busy-agent').spend)).toBe('$1.50');
    fake.hold = true;
    void h.store.loadAgentStats();
    await flush();
    expect(h.store.state.agentStatsLoading).toBe(true);
    expect(value(figures(h, 'busy-agent').requests)).toBe('42');
    expect(value(figures(h, 'busy-agent').spend)).toBe('$1.50');
    expect(panel(h).querySelector('.fig-skel')).toBeNull();
    fake.release();
    await flush();
    expect(value(figures(h, 'busy-agent').spend)).toBe('$1.50');
  });

  it('a failed first load shows the notice and Retry, with no skeleton left pulsing; Retry leaves focus on the agents table', async () => {
    const fake = new AgentStatsFake([row('a-busy', 42, 1.5)]);
    fake.analyticsFailure = new ApiError(500, 'Internal', 'boom');
    h = await openAgents(fake);
    const n = notice(h);
    expect(n, 'the failure notice').not.toBeNull();
    expect(n!.getAttribute('role')).toBe('status');
    expect(n!.querySelector('.notice-title')?.textContent).toBe('Couldn’t load');
    // The figures are an analytics read, so the body says routing is unaffected (D5, F9).
    expect(n!.querySelector('.notice-body')?.textContent).toBe(
      'Agent activity couldn’t be loaded. Routing is unaffected.',
    );
    expect(n!.textContent).not.toContain('boom');
    expect(
      [...n!.querySelectorAll('button')].map((b) => labelText(b)),
      'one Retry',
    ).toEqual(['Retry']);
    // The configuration list still renders, and is not the figures' failure line.
    expect(h.host.textContent).not.toContain('Couldn’t load agents:');
    expect(figures(h, 'busy-agent')).toBeDefined();
    // No skeleton, no dash, no zero: the figures are absent.
    expect(panel(h).querySelector('.fig-skel')).toBeNull();
    for (const name of ['busy-agent', 'idle-agent']) {
      const { requests, spend } = figures(h, name);
      expect([value(requests), value(spend)]).toEqual(['', '']);
    }

    // Retry, focused before the click: its load starts, the notice goes, and focus is on the
    // agents table panel, never <body>.
    fake.analyticsFailure = null;
    fake.hold = true;
    const retry = n!.querySelector<HTMLButtonElement>('button')!;
    retry.focus();
    retry.click();
    await Promise.resolve();
    expect(notice(h)).toBeNull();
    expect(panel(h).getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel(h));
    expect(value(figures(h, 'busy-agent').spend)).toBe('Loading spend');
    fake.release();
    await flush();
    expect(value(figures(h, 'busy-agent').spend)).toBe('$1.50');
    expect(document.activeElement).toBe(panel(h));
  });

  it('a failed refetch removes the figures it would have replaced', async () => {
    const fake = new AgentStatsFake([row('a-busy', 42, 1.5)]);
    h = await openAgents(fake);
    expect(value(figures(h, 'busy-agent').spend)).toBe('$1.50');
    fake.analyticsFailure = new ApiError(500, 'Internal', 'boom');
    await h.store.loadAgentStats();
    await flush();
    // The store keeps the old figures; the page must not show them as current.
    expect(h.store.state.agentStatsLoaded).toBe(true);
    expect(notice(h)).not.toBeNull();
    expect(value(figures(h, 'busy-agent').requests)).toBe('');
    expect(value(figures(h, 'busy-agent').spend)).toBe('');
    expect(panel(h).querySelector('.fig-skel')).toBeNull();
  });
});
