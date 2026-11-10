/**
 * The usage graphs' model (add-subscription-usage-history task 6.2; dashboard-core "A subscription
 * provider card graphs each usage window over its span"). A pure function of the provider view,
 * the history and a clock, so every state is pinned here at a fixed instant and zone.
 */
import { describe, expect, it } from 'vitest';
import type { PlanUsageHistoryDto, PlanUsageWindowDto } from './api';
import { fmtAsOf, fmtReset } from './format';
import { PLAN_USAGE_GRAPH_COPY, planUsageGraphs, snapshotSpanStart } from './planUsageHistory';
import { chatgptPlanUsageHistory } from '../test/fakeClient';

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const TZ = 'UTC';

const win = (over: Partial<PlanUsageWindowDto> = {}): PlanUsageWindowDto => ({
  key: 'account:5h',
  group: 'account',
  span: '5h',
  minutes: 300,
  scope: null,
  usedPercent: 41,
  resetAt: iso(T0 + 2 * HOUR),
  observedAt: iso(T0 - 5 * 60_000),
  source: 'refresh',
  ...over,
});
const weekly = (over: Partial<PlanUsageWindowDto> = {}): PlanUsageWindowDto =>
  win({
    key: 'account:weekly',
    span: 'weekly',
    minutes: 10080,
    usedPercent: 24,
    resetAt: iso(T0 + 72 * HOUR),
    ...over,
  });
const chatgpt = (windows: PlanUsageWindowDto[] = [win(), weekly()]) => ({
  planUsage: { windows, billing: null },
  planUsageRefresh: { availableAt: null },
});
const EMPTY: PlanUsageHistoryDto = { windows: [] };

describe('which graphs a card shows', () => {
  it('a ChatGPT card with samples for its 5-hour and weekly windows shows those two, in line order', () => {
    const g = planUsageGraphs(chatgpt(), chatgptPlanUsageHistory(T0), T0, TZ);
    expect(g.accounts.map((x) => [x.key, x.label])).toEqual([
      ['account:5h', '5h'],
      ['account:weekly', 'weekly'],
    ]);
    expect(g.buckets).toEqual([]);
  });

  it('a snapshot window without a sample still gets its track; a history-only window follows', () => {
    const history: PlanUsageHistoryDto = {
      windows: [
        {
          key: 'account:daily',
          group: 'account',
          span: 'daily',
          minutes: 1440,
          scope: null,
          label: 'account:daily',
          from: iso(T0 - 20 * HOUR),
          resetAt: iso(T0 + 4 * HOUR),
          samples: [{ at: iso(T0 - HOUR), usedPercent: 10, resetAt: iso(T0 + 4 * HOUR) }],
        },
      ],
    };
    const g = planUsageGraphs(chatgpt([win()]), history, T0, TZ);
    expect(g.accounts.map((x) => x.key)).toEqual(['account:5h', 'account:daily']);
    // Named by the line's own rules, not the key the server falls back to.
    expect(g.accounts[1]?.label).toBe('daily');
    expect(g.accounts[0]?.figure).toBe(PLAN_USAGE_GRAPH_COPY.noReading);
  });

  it('model buckets are graphed apart from the account windows', () => {
    const bucket = win({
      key: 'model:gpt_5_codex',
      group: 'model',
      span: null,
      minutes: 300,
      scope: 'GPT-5-Codex',
    });
    const g = planUsageGraphs(chatgpt([win(), bucket]), EMPTY, T0, TZ);
    expect(g.accounts.map((x) => x.key)).toEqual(['account:5h']);
    expect(g.buckets.map((x) => [x.key, x.label])).toEqual([['model:gpt_5_codex', 'GPT-5-Codex']]);
  });

  it('a usage source with no window and no sample shows ONE generic track', () => {
    const g = planUsageGraphs(
      { planUsage: null, planUsageRefresh: { availableAt: null } },
      EMPTY,
      T0,
      TZ,
    );
    expect(g.accounts).toHaveLength(1);
    const only = g.accounts[0]!;
    expect(only.label).toBe('Plan usage');
    expect(only.figure).toBe('no reading yet');
    expect(only.reset).toBeNull();
    expect(only.empty).toBe(true);
    expect(only.range).toBe(`from ${String(fmtAsOf(iso(T0 - 7 * 24 * HOUR), T0, TZ))} to now`);
  });
});

describe('a window without a reading is never drawn as 0%', () => {
  it('no sample: the empty track spans the window and draws only nulls', () => {
    const [g] = planUsageGraphs(chatgpt([win()]), EMPTY, T0, TZ).accounts;
    expect(g?.empty).toBe(true);
    expect(g?.known).toBe(false);
    expect(g?.figure).toBe('no reading yet');
    expect(g?.latest).toBeNull();
    expect(g?.data[1]).toEqual([null, null]);
    expect(g?.data[1]).not.toContain(0);
    // The span the server would read: the reset minus the window's length, to the reset.
    expect(g?.xExtent).toEqual([(T0 - 3 * HOUR) / 1000, (T0 + 2 * HOUR) / 1000]);
  });

  it('an unknown latest reading reads `unknown`, stays a null, and the known ones still draw', () => {
    const history = chatgptPlanUsageHistory(T0);
    history.windows[0]!.samples.push({ at: iso(T0 + 1000), usedPercent: null, resetAt: null });
    const [g] = planUsageGraphs(chatgpt(), history, T0 + 2000, TZ).accounts;
    expect(g?.figure).toBe('unknown');
    expect(g?.known).toBe(false);
    expect(g?.empty).toBe(false);
    expect(g?.data[1].at(-1)).toBeNull();
    // The fixture's own unknown (the fifth reading) is a null too: a gap, never 0.
    expect(g?.data[1][4]).toBeNull();
    expect(g?.data[1]).not.toContain(0);
  });

  it('every reading unknown: the empty track, `unknown`, and nothing drawable', () => {
    const history: PlanUsageHistoryDto = {
      windows: [
        {
          ...chatgptPlanUsageHistory(T0).windows[0]!,
          samples: [
            { at: iso(T0 - HOUR), usedPercent: null, resetAt: null },
            { at: iso(T0), usedPercent: null, resetAt: null },
          ],
        },
      ],
    };
    const [g] = planUsageGraphs(chatgpt([win()]), history, T0, TZ).accounts;
    expect(g?.figure).toBe('unknown');
    expect(g?.empty).toBe(true);
    expect(g?.data[1]).toEqual([null, null]);
  });
});

describe('the caption states the window, its percent, its reset and its range in words', () => {
  it('reads the latest percent, the reset ahead, the span and the latest reading time', () => {
    const g = planUsageGraphs(chatgpt(), chatgptPlanUsageHistory(T0), T0, TZ);
    const [five, week] = g.accounts;
    expect(five?.figure).toBe('41% used');
    expect(five?.known).toBe(true);
    expect(five?.reset).toBe(`resets ${String(fmtReset(iso(T0 + 2 * HOUR), T0, TZ))}`);
    expect(five?.range).toBe(
      `from ${String(fmtAsOf(iso(T0 - 3 * HOUR), T0, TZ))} to ${String(fmtReset(iso(T0 + 2 * HOUR), T0, TZ))}`,
    );
    expect(five?.latest).toBe(`latest reading ${String(fmtAsOf(iso(T0), T0, TZ))}`);
    expect(week?.figure).toBe('24% used');
    expect(week?.reset).toBe(`resets ${String(fmtReset(iso(T0 + 72 * HOUR), T0, TZ))}`);
  });

  it('marks the reset as the reference line at the span’s end', () => {
    const [five] = planUsageGraphs(chatgpt(), chatgptPlanUsageHistory(T0), T0, TZ).accounts;
    expect(five?.referenceX).toBe((T0 + 2 * HOUR) / 1000);
    expect(five?.xExtent[1]).toBe((T0 + 2 * HOUR) / 1000);
  });

  it('an unknown reset says so, draws no reference, and the span ends now', () => {
    const [g] = planUsageGraphs(chatgpt([win({ resetAt: null })]), EMPTY, T0, TZ).accounts;
    expect(g?.reset).toBe('resets unknown');
    expect(g?.referenceX).toBeNull();
    expect(g?.xExtent).toEqual([(T0 - 5 * HOUR) / 1000, T0 / 1000]);
    expect(g?.range).toMatch(/ to now$/);
  });

  it('a reset that has passed is stated in the past, inside a span that runs to now', () => {
    const passed = T0 - HOUR;
    const [g] = planUsageGraphs(chatgpt([win({ resetAt: iso(passed) })]), EMPTY, T0, TZ).accounts;
    expect(g?.reset).toBe(`reset ${String(fmtAsOf(iso(passed), T0, TZ))}`);
    expect(g?.referenceX).toBe(passed / 1000);
    expect(g?.xExtent[1]).toBe(T0 / 1000);
  });
});

describe('snapshotSpanStart (the server’s span rule, for a window with no sample yet)', () => {
  it('reads the minutes, then the named span, then 7 days', () => {
    expect(snapshotSpanStart({ span: null, minutes: 90, resetAt: iso(T0 + HOUR) }, T0)).toBe(
      T0 + HOUR - 90 * 60_000,
    );
    expect(snapshotSpanStart({ span: 'daily', minutes: null, resetAt: iso(T0 + HOUR) }, T0)).toBe(
      T0 + HOUR - 24 * HOUR,
    );
    expect(snapshotSpanStart({ span: null, minutes: null, resetAt: iso(T0 + HOUR) }, T0)).toBe(
      T0 - 7 * 24 * HOUR,
    );
  });

  it('never starts after now', () => {
    expect(snapshotSpanStart({ span: '5h', minutes: 300, resetAt: iso(T0 + 9 * HOUR) }, T0)).toBe(
      T0,
    );
  });
});
