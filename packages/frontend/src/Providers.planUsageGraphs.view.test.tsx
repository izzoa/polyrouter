/**
 * The provider card's usage graphs and Edit's usage-schedule switch (add-subscription-usage-history
 * tasks 6.2 and 6.3; dashboard-core "A subscription provider card graphs each usage window over
 * its span").
 *
 * The real App on a fake client, with the real uPlot under the test canvas shim. The series
 * options uPlot is handed (Ink 2, no fill, nulls, the dashed reset) are pinned with uPlot mocked
 * in `components/PlanUsageGraphs.series.test.tsx`; here, what a reader and a screen reader get:
 * one figure per window with its caption in words, the drawing hidden, the empty track for a
 * window without a reading, the loading and failure states in place, the re-read after a Refresh
 * usage, and the switch in Edit only where a usage endpoint exists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, type PlanUsageDto, type PlanUsageRefreshResultDto } from './data/api';
import { fmtAsOf, fmtReset } from './data/format';
import { chatgptPlanUsageHistory } from './test/fakeClient';
import { labelText } from './test/labelText';
import {
  buttonNamed,
  calls,
  flush,
  iso,
  mkProvider,
  mount,
  refreshButton,
  T0,
  unmountAll,
  usageLine,
  useFakeClock,
  usageOf,
  window5h,
  windowWeekly,
  type Harness,
} from './test/planUsageHarness';

beforeEach(useFakeClock);
afterEach(unmountAll);

const HOUR = 3_600_000;
const CHATGPT_USAGE = (): PlanUsageDto =>
  usageOf([
    window5h({ usedPercent: 41, observedAt: iso(T0) }),
    windowWeekly({ usedPercent: 24, observedAt: iso(T0) }),
  ]);
const chatgptCard = (over: Parameters<typeof mkProvider>[0] = {}) =>
  mkProvider({
    id: 'p-chatgpt',
    name: 'ChatGPT Pro',
    keyPreset: null,
    oauthPreset: 'chatgpt',
    protocol: 'openai_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    planUsage: CHATGPT_USAGE(),
    planUsageRefresh: { availableAt: null },
    checkPlanUsage: true,
    ...over,
  });
const withHistory = (fake: Parameters<NonNullable<Parameters<typeof mount>[1]>>[0]): void => {
  fake.planUsageHistories = { 'p-chatgpt': chatgptPlanUsageHistory(T0) };
};

const figures = (h: Harness): HTMLElement[] => [
  ...h.host.querySelectorAll<HTMLElement>('figure[data-usage-graph]'),
];
const caption = (f: HTMLElement): string =>
  (f.querySelector('figcaption')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const graphs = (h: Harness): HTMLElement | null =>
  h.host.querySelector<HTMLElement>('[data-usage-graphs]');

describe('a ChatGPT card graphs its two windows', () => {
  it('shows one figure per window, labelled with the window, its percent, its reset and its range', async () => {
    const h = await mount(chatgptCard(), withHistory);
    const [five, week] = figures(h);
    expect(figures(h)).toHaveLength(2);
    expect(five?.dataset['usageGraph']).toBe('account:5h');
    expect(week?.dataset['usageGraph']).toBe('account:weekly');
    const reset5h = String(fmtReset(iso(T0 + 2 * HOUR), T0));
    const resetWeek = String(fmtReset(iso(T0 + 3 * 24 * HOUR), T0));
    expect(caption(five!)).toBe(
      `5h · 41% used · resets ${reset5h} ` +
        `from ${String(fmtAsOf(iso(T0 - 3 * HOUR), T0))} to ${reset5h} · latest reading ${String(fmtAsOf(iso(T0), T0))}`,
    );
    expect(caption(week!)).toBe(
      `weekly · 24% used · resets ${resetWeek} ` +
        `from ${String(fmtAsOf(iso(T0 - 4 * 24 * HOUR), T0))} to ${resetWeek} · latest reading ${String(fmtAsOf(iso(T0), T0))}`,
    );
  });

  it('draws each into a uPlot track whose drawing is hidden from assistive technology', async () => {
    const h = await mount(chatgptCard(), withHistory);
    for (const f of figures(h)) {
      const plot = f.querySelector<HTMLElement>('.pu-graph-plot');
      expect(plot?.getAttribute('aria-hidden')).toBe('true');
      expect(plot?.querySelector('.uplot canvas')).not.toBeNull();
      // Everything a screen reader is given is the caption.
      const exposed = [...f.children].filter((c) => c.getAttribute('aria-hidden') !== 'true');
      expect(exposed.map((c) => c.tagName)).toEqual(['FIGCAPTION']);
    }
  });

  it('marks the reset as the dashed reference only where one is drawn', async () => {
    const h = await mount(chatgptCard(), withHistory);
    for (const f of figures(h)) {
      expect(f.querySelector('.pu-graph-reset')?.getAttribute('data-reference')).toBe('true');
    }
  });

  it('sits under the usage line, inside a named group, and reads the history once', async () => {
    const h = await mount(chatgptCard(), withHistory);
    const all = [...h.host.querySelectorAll('*')];
    expect(all.indexOf(graphs(h)!)).toBeGreaterThan(all.indexOf(usageLine(h)!));
    expect(graphs(h)?.getAttribute('role')).toBe('group');
    expect(graphs(h)?.getAttribute('aria-label')).toBe('ChatGPT Pro usage history');
    expect(calls(h.fake, 'planUsageHistory')).toEqual([['p-chatgpt']]);
  });

  it('spends no indigo: the series is declared neutral and names no focal measure', async () => {
    const h = await mount(chatgptCard(), withHistory);
    for (const f of figures(h)) {
      const root = f.querySelector<HTMLElement>('[data-series]');
      expect(root?.dataset['series']).toBe('neutral');
      expect(root?.hasAttribute('data-measure')).toBe(false);
    }
  });
});

describe('a window without a reading is never drawn as 0%', () => {
  it('no sample yet: each window is the empty track with `no reading yet`, and no 0% anywhere', async () => {
    const h = await mount(chatgptCard());
    expect(figures(h)).toHaveLength(2);
    for (const f of figures(h)) {
      expect(f.querySelector('.pu-graph-figure')?.textContent).toBe('no reading yet');
      expect(f.querySelector('.pu-graph-figure')?.getAttribute('data-known')).toBe('false');
      expect(caption(f)).not.toMatch(/\b0%/);
    }
  });

  it('a usage source with no window and no sample shows ONE generic empty track', async () => {
    const h = await mount(chatgptCard({ planUsage: null }));
    expect(figures(h)).toHaveLength(1);
    const [only] = figures(h);
    expect(caption(only!)).toMatch(/^Plan usage · no reading yet from .+ to now$/);
  });

  it('an unknown latest reading reads `unknown`, never a percent', async () => {
    const h = await mount(chatgptCard(), (fake) => {
      const history = chatgptPlanUsageHistory(T0);
      history.windows[0]!.samples.at(-1)!.usedPercent = null;
      fake.planUsageHistories = { 'p-chatgpt': history };
    });
    const [five] = figures(h);
    expect(five?.querySelector('.pu-graph-figure')?.textContent).toBe('unknown');
    expect(caption(five!)).toMatch(/^5h · unknown · resets /);
  });
});

describe('the graph loads and fails in place', () => {
  it('shows a chart-sized skeleton that names what loads, then the graphs', async () => {
    let release!: () => void;
    const h = await mount(chatgptCard(), (fake) => {
      withHistory(fake);
      fake.planUsageHistoryGate = new Promise<void>((r) => {
        release = r;
      });
    });
    const loading = h.host.querySelector<HTMLElement>('[data-usage-graphs-loading]');
    expect(loading?.querySelector('.fig-skel.fig-skel-chart')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(loading?.textContent).toBe('Loading usage history');
    expect(figures(h)).toHaveLength(0);
    // The line above is already there.
    expect(usageLine(h)?.textContent).toMatch(/^5h 41%/);
    release();
    await flush();
    expect(h.host.querySelector('[data-usage-graphs-loading]')).toBeNull();
    expect(figures(h)).toHaveLength(2);
  });

  it('a failed read says so in place with Retry, and leaves the usage line as it was', async () => {
    const h = await mount(chatgptCard(), (fake) => {
      withHistory(fake);
      fake.planUsageHistoryRejects = new ApiError(500, 'Internal Server Error', 'boom');
    });
    const lineBefore = usageLine(h)?.textContent;
    const failure = h.host.querySelector<HTMLElement>('[data-usage-graphs-failure]');
    expect(failure?.textContent).toContain(
      'Usage history couldn’t be loaded. Routing is unaffected.',
    );
    expect(figures(h)).toHaveLength(0);
    expect(usageLine(h)?.textContent).toBe(lineBefore);
    const retry = buttonNamed(failure!, 'Retry');
    expect(retry).toBeDefined();

    retry!.click();
    await flush();
    expect(h.host.querySelector('[data-usage-graphs-failure]')).toBeNull();
    expect(figures(h)).toHaveLength(2);
    // Retry's notice went with its button: focus is on the group, never the page.
    expect(document.activeElement).toBe(graphs(h));
    expect(calls(h.fake, 'planUsageHistory')).toHaveLength(2);
  });

  it('a failed re-read removes the graphs rather than leaving them stale', async () => {
    const h = await mount(chatgptCard(), withHistory);
    expect(figures(h)).toHaveLength(2);
    h.fake.planUsageHistoryRejects = new ApiError(503, 'Service Unavailable', 'down');
    refreshButton(h)!.click();
    await flush();
    expect(figures(h)).toHaveLength(0);
    expect(h.host.querySelector('[data-usage-graphs-failure]')).not.toBeNull();
  });
});

describe('the history is re-read after a successful Refresh usage, and only then', () => {
  const answers =
    (ok: boolean) => (p: Parameters<NonNullable<Harness['fake']['planUsageRefreshResult']>>[0]) =>
      ({
        ok,
        ...(ok ? {} : { message: 'The usage endpoint did not answer.' }),
        provider: { ...p, planUsageRefresh: { availableAt: iso(Date.now() + 300_000) } },
      }) satisfies PlanUsageRefreshResultDto;

  it('a success reads it again and keeps the graphs on screen while it does', async () => {
    const h = await mount(chatgptCard(), withHistory);
    h.fake.planUsageRefreshResult = answers(true);
    let release!: () => void;
    h.fake.planUsageHistoryGate = new Promise<void>((r) => {
      release = r;
    });
    refreshButton(h)!.click();
    await flush();
    expect(calls(h.fake, 'planUsageHistory')).toHaveLength(2);
    // A re-read keeps the figures (DESIGN.md Loading: on a refetch, keep the old figures).
    expect(figures(h)).toHaveLength(2);
    expect(h.host.querySelector('[data-usage-graphs-loading]')).toBeNull();
    release();
    await flush();
    expect(figures(h)).toHaveLength(2);
  });

  it('a failed refresh reads nothing', async () => {
    const h = await mount(chatgptCard(), withHistory);
    h.fake.planUsageRefreshResult = answers(false);
    refreshButton(h)!.click();
    await flush();
    expect(calls(h.fake, 'planUsageHistory')).toHaveLength(1);
  });
});

describe('where the graphs appear', () => {
  it('not on a provider without a usage endpoint', async () => {
    const h = await mount(chatgptCard({ planUsageRefresh: null }), withHistory);
    expect(graphs(h)).toBeNull();
    expect(calls(h.fake, 'planUsageHistory')).toEqual([]);
  });

  it('not while the status line states a plan pause, like the usage line', async () => {
    const h = await mount(
      chatgptCard({
        planCooldown: { kind: 'quota_exhausted', until: iso(T0 + HOUR), untilSource: 'default' },
      }),
      withHistory,
    );
    expect(usageLine(h)).toBeNull();
    expect(graphs(h)).toBeNull();
  });

  it('model buckets are graphed in their own disclosure, mounted only while it is open', async () => {
    const bucket = window5h({
      key: 'model:gpt_5_codex',
      group: 'model',
      span: null,
      scope: 'GPT-5-Codex',
      usedPercent: 12,
      observedAt: iso(T0),
    });
    const h = await mount(
      chatgptCard({ planUsage: usageOf([...CHATGPT_USAGE().windows, bucket]) }),
      withHistory,
    );
    const details = h.host.querySelector<HTMLDetailsElement>('details[data-usage-graph-buckets]');
    expect(details?.querySelector('summary')?.textContent).toBe('model limit graphs (1)');
    expect(details?.querySelector('figure')).toBeNull();
    details!.open = true;
    details!.dispatchEvent(new Event('toggle'));
    await flush();
    const inside = details!.querySelector<HTMLElement>('figure[data-usage-graph]');
    expect(inside?.dataset['usageGraph']).toBe('model:gpt_5_codex');
    expect(caption(inside!)).toMatch(/^GPT-5-Codex · no reading yet · resets /);
  });
});

describe('Edit offers the usage-schedule switch', () => {
  const SWITCH = '#f-np-plan-usage';
  const openEdit = async (h: Harness): Promise<void> => {
    buttonNamed(h.host, 'Edit')!.click();
    await flush();
  };
  const save = async (): Promise<void> => {
    [...document.querySelectorAll<HTMLButtonElement>('.modal-card button')]
      .find((b) => labelText(b) === 'Save changes')!
      .click();
    await flush();
  };

  it('shows the switch reflecting checkPlanUsage, with its caption as its description', async () => {
    const h = await mount(chatgptCard({ checkPlanUsage: false }));
    await openEdit(h);
    const box = document.querySelector<HTMLInputElement>(SWITCH);
    expect(box?.type).toBe('checkbox');
    expect(box?.checked).toBe(false);
    expect(labelText(box!.closest('label')!)).toBe('Check plan usage on a schedule');
    const described = document.getElementById(box!.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('Reads this plan’s usage endpoint about every 15 minutes.');
  });

  it('saving sends the change, and only the change', async () => {
    const h = await mount(chatgptCard());
    await openEdit(h);
    const box = document.querySelector<HTMLInputElement>(SWITCH)!;
    expect(box.checked).toBe(true);
    box.click();
    await save();
    const [, patch] = h.fake.lastArgs('updateProvider') as [string, Record<string, unknown>];
    expect(patch).toEqual({
      name: 'ChatGPT Pro',
      firstByteTimeoutMs: null,
      idleTimeoutMs: null,
      checkPlanUsage: false,
    });
    expect(h.store.state.providers[0]?.checkPlanUsage).toBe(false);
  });

  it('an unrelated edit never sends it', async () => {
    const h = await mount(chatgptCard());
    await openEdit(h);
    await save();
    const [, patch] = h.fake.lastArgs('updateProvider') as [string, Record<string, unknown>];
    expect(patch).not.toHaveProperty('checkPlanUsage');
  });

  it('a key-preset plan with an endpoint offers it too, and its PATCH carries only the switch', async () => {
    const h = await mount(mkProvider({ planUsageRefresh: { availableAt: null } }));
    await openEdit(h);
    document.querySelector<HTMLInputElement>(SWITCH)!.click();
    await save();
    const [, patch] = h.fake.lastArgs('updateProvider') as [string, Record<string, unknown>];
    expect(patch).toEqual({ checkPlanUsage: false });
  });

  it('any other provider shows no such switch', async () => {
    for (const p of [
      mkProvider({ planUsageRefresh: null }),
      mkProvider({
        kind: 'api_key',
        keyPreset: null,
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        planUsageRefresh: null,
      }),
    ]) {
      const h = await mount(p);
      await openEdit(h);
      expect(document.querySelector('.modal-card')).not.toBeNull();
      expect(document.querySelector(SWITCH)).toBeNull();
      expect(document.body.textContent).not.toMatch(/Check plan usage on a schedule/);
      unmountAll();
      useFakeClock();
    }
  });
});
