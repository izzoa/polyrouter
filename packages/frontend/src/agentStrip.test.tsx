/** Overview's agent strip (add-agent-request-attribution, task group 6).
 *
 * The load-bearing test here is the FIRST one. The breakdown endpoint defaults to
 * spend ranking at limit 10, so a strip that forgot to ask for `requests` would
 * still render — just missing exactly the agents it exists to reveal: high volume
 * on free, local or fully-cached routes, which accrues near-zero spend. That is a
 * silent, plausible-looking wrong answer, not a crash.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { Overview } from './pages/Overview';
import { AGENT_DELETED, AGENT_UNATTRIBUTED, toAgentStrip } from './data/analytics';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import { ApiError } from './data/api';
import type { BreakdownRow } from './data/api';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const brow = (
  key: string,
  label: string | null,
  spend: number,
  requests: number,
): BreakdownRow => ({
  key,
  label,
  spend,
  requests,
  estimatedTokens: 0,
  ...tokens,
});

/** Spend order and request order DISAGREE — a fixture where they agreed would let a
 * strip that never asked for `requests` pass. `busy` is the row at risk. */
const AGENTS: BreakdownRow[] = [
  brow('a-busy', 'busy-local', 0, 900),
  brow('a-costly', 'costly', 9, 12),
  brow('a-mid', 'mid', 5, 20),
  brow('', null, 1, 30),
  brow('a-gone', null, 2, 7),
];

const withAgents = (rows: BreakdownRow[]): FakeApiClient =>
  new FakeApiClient({
    breakdown: { agent: rows, model: [], provider: [], tier: [] },
  });

describe('toAgentStrip (pure)', () => {
  it('keeps keyless traffic but makes it un-actionable', () => {
    const out = toAgentStrip(AGENTS);
    const keyless = out.find((e) => e.key === '');
    expect(keyless, 'keyless volume was dropped, under-reporting the total').toBeDefined();
    expect(keyless?.label).toBe(AGENT_UNATTRIBUTED);
    // An empty agent id is a 400 server-side, so there is no action to offer.
    expect(keyless?.filterable).toBe(false);
    expect(keyless?.requests).toBe(30);
  });

  it('names a deleted agent distinctly from keyless, and keeps it filterable', () => {
    const gone = toAgentStrip(AGENTS).find((e) => e.key === 'a-gone');
    expect(gone?.label).toBe(AGENT_DELETED);
    // Its history outlives it and IS filterable — that is the useful behaviour.
    expect(gone?.filterable).toBe(true);
  });

  it('never surfaces a raw id as a label', () => {
    for (const e of toAgentStrip(AGENTS)) {
      expect(e.label).not.toBe(e.key);
    }
  });
});

describe('the strip asks for the right ranking', () => {
  it('requests the `requests` metric with an EXPLICIT limit, not the endpoint defaults', async () => {
    const fake = withAgents(AGENTS);
    const store = createAppStore(fake);
    // The strip is deliberately NOT part of `loadOverview` — that is the polled
    // fan-out, and a fifth endpoint on every 15s tick would raise an open
    // dashboard's idle cost by a quarter. It rides the range effect instead.
    await store.loadAgentStrip();
    await flush();

    const call = fake.callLog.filter((c) => c.method === 'breakdown' && c.args[0] === 'agent');
    expect(call.length, 'the strip never asked for the agent dimension').toBeGreaterThan(0);
    const [, , limit, metric] = call[call.length - 1]!.args;
    expect(metric, 'the strip inherited the spend ranking').toBe('requests');
    // The endpoint's default is 10; asking explicitly is what stops the cap from
    // silently truncating the very rows this view exists for.
    expect(limit).toBe(100);
  });

  it('refetches on a range change rather than relabelling the previous range', async () => {
    const fake = withAgents(AGENTS);
    const store = createAppStore(fake);
    await store.loadAgentStrip();
    await flush();
    const before = fake.callLog.filter(
      (c) => c.method === 'breakdown' && c.args[0] === 'agent',
    ).length;

    store.setRange('30d');
    await store.loadAgentStrip();
    await flush();

    const after = fake.callLog.filter((c) => c.method === 'breakdown' && c.args[0] === 'agent');
    expect(after.length, 'the strip did not refetch for the new range').toBeGreaterThan(before);
    expect(after[after.length - 1]!.args[3]).toBe('requests');
  });
});

describe('the strip renders honestly', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  const mount = (store: AppStore): HTMLElement => {
    const host = document.createElement('div');
    document.body.append(host);
    dispose = render(
      () => (
        <AppProvider store={store}>
          <Overview live={false} />
        </AppProvider>
      ),
      host,
    );
    return host;
  };

  const stripPanel = (host: HTMLElement): HTMLElement | null =>
    [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
      p.textContent?.includes('Agents'),
    ) ?? null;
  /** The strip's own failure notice, inside its panel (not the page's analytics notice). */
  const stripNotice = (host: HTMLElement): HTMLElement | null =>
    stripPanel(host)?.querySelector<HTMLElement>('.notice') ?? null;

  it('shows a zero-spend high-volume agent — the row a spend ranking would hide', async () => {
    const fake = withAgents(AGENTS);
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadOverview();
    await flush();

    const panel = stripPanel(host);
    expect(panel, 'no agent strip rendered').not.toBeNull();
    const text = panel?.textContent ?? '';
    expect(text).toContain('busy-local');
    expect(text).toContain('900');
    expect(text).toContain('costly');
  });

  it('shows no figures at all before the strip has loaded', () => {
    const fake = withAgents(AGENTS);
    const store = createAppStore(fake);
    const host = mount(store);
    // Deliberately NOT awaiting the load: an unloaded strip is UNKNOWN, and must
    // never present that as a measured zero.
    const text = stripPanel(host)?.textContent ?? '';
    expect(text).toContain('Loading');
    expect(text).not.toMatch(/\b0\b/);
    // The shared skeleton with its hidden text, never a bare visible `Loading…`
    // (adopt-figure-states D5).
    const panel = stripPanel(host)!;
    expect(panel.querySelector('.fig-skel')?.getAttribute('aria-hidden')).toBe('true');
    expect(panel.querySelector('.sr-only')?.textContent).toBe('Loading agent activity');
    expect(text).not.toContain('Loading…');
  });

  it('makes keyless volume visible but not clickable', async () => {
    const fake = withAgents(AGENTS);
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadOverview();
    await flush();

    const panel = stripPanel(host)!;
    expect(panel.textContent).toContain(AGENT_UNATTRIBUTED);
    expect(panel.textContent).toContain('30');
    const labels = [...panel.querySelectorAll('button')].map((b) => b.textContent ?? '');
    // Every BUTTON is filterable; the keyless entry is not among them.
    expect(labels.some((l) => l.includes(AGENT_UNATTRIBUTED))).toBe(false);
  });

  it('hands the filter to Requests on click-through', async () => {
    const fake = withAgents(AGENTS);
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadOverview();
    await flush();

    const panel = stripPanel(host)!;
    const busy = [...panel.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('busy-local'),
    );
    expect(busy, 'the high-volume agent was not click-through').toBeDefined();
    busy!.click();
    await flush();

    expect(store.state.reqAgentId).toBe('a-busy');
    expect(store.state.page).toBe('requests');
  });

  it('distinguishes a FAILED load from a slow one', async () => {
    const fake = withAgents(AGENTS);
    fake.analyticsFailure = new ApiError(500, 'Server Error', 'boom');
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadAgentStrip();
    await flush();
    const text = stripPanel(host)?.textContent ?? '';
    // A failure must not keep reading as "still working".
    expect(text).not.toContain('Loading');
    expect(stripPanel(host)!.querySelector('.fig-skel')).toBeNull();
    // It is the shared Info notice, in the figure states' words, with the rendered U+2019
    // (adopt-figure-states 3.2, D5, flag F9): the strip's counts are an analytics read, so
    // the body says routing is unaffected. No raw error, and one ghost Retry.
    const n = stripNotice(host);
    expect(n, 'the strip failure is not a notice').not.toBeNull();
    expect(n!.classList.contains('notice--info')).toBe(true);
    expect(n!.getAttribute('role')).toBe('status');
    expect(n!.querySelector('.notice-title')?.textContent).toBe('Couldn’t load');
    expect(n!.querySelector('.notice-body')?.textContent).toBe(
      'Agent activity couldn’t be loaded. Routing is unaffected.',
    );
    expect(n!.textContent).not.toContain('boom');
    const buttons = [...n!.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Retry']);
    expect(buttons[0]!.classList.contains('btn-ghost')).toBe(true);
    expect(text).not.toContain('Couldn’t load agent activity');
  });

  it('Retry reloads the strip and leaves focus on its panel, never on <body>', async () => {
    const fake = withAgents(AGENTS);
    fake.analyticsFailure = new ApiError(500, 'Server Error', 'boom');
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadAgentStrip();
    await flush();
    const panel = stripPanel(host)!;
    // A script-only focus target: out of the tab order, focusable by Retry's hand-off.
    expect(panel.getAttribute('tabindex')).toBe('-1');

    // The retry is held in flight, so the in-between state can be read.
    fake.analyticsFailure = null;
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const breakdown = fake.breakdown.bind(fake);
    const asked: unknown[][] = [];
    fake.breakdown = (...args) => {
      if (args[0] === 'agent') asked.push(args);
      return held.then(() => breakdown(...args));
    };

    const retry = stripNotice(host)!.querySelector<HTMLButtonElement>('button')!;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    retry.click();
    await Promise.resolve();
    // Its load started: the agent dimension was asked for again, ranked by requests.
    expect(asked.map((a) => a[3])).toEqual(['requests']);
    // The notice (and the Retry in it) is gone, the strip loads as its skeleton, and focus is
    // on the strip's panel, not <body>.
    expect(stripNotice(host)).toBeNull();
    expect(retry.isConnected).toBe(false);
    expect(panel.querySelector('.sr-only')?.textContent).toBe('Loading agent activity');
    expect(document.activeElement).toBe(panel);

    release();
    await flush();
    // The figures commit, and focus stays where Retry left it.
    expect(panel.textContent).toContain('busy-local');
    expect(panel.textContent).toContain('900');
    expect(document.activeElement).toBe(panel);
  });

  it('says so when no agent was active, rather than rendering an empty strip', async () => {
    const fake = withAgents([]);
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadOverview();
    await flush();
    expect(stripPanel(host)?.textContent ?? '').toMatch(/No agent activity/i);
  });
});
