/**
 * `planUsageView` (add-subscription-quota-display task 7.1, design D10; dashboard-core "A
 * subscription provider card states its plan usage in one neutral line"). Pure and
 * clock-injected; every time is pinned to UTC.
 */
import { describe, expect, it } from 'vitest';
import type { PlanUsageDto, PlanUsageWindowDto } from './api';
import { fmtUntil } from './format';
import { nextTickAt, PLAN_USAGE_COPY, planUsageView } from './planUsage';

const UTC = 'UTC';
const NOW = Date.parse('2026-11-06T13:40:00.000Z');
const at = (h: number, m = 0, day = 6): string =>
  new Date(Date.UTC(2026, 10, day, h, m)).toISOString();

const win = (over: Partial<PlanUsageWindowDto> & Pick<PlanUsageWindowDto, 'key'>) =>
  ({
    group: 'account',
    span: null,
    minutes: null,
    scope: null,
    usedPercent: 50,
    resetAt: at(18),
    observedAt: at(13, 2),
    source: 'traffic',
    ...over,
  }) satisfies PlanUsageWindowDto;

const usage = (
  windows: PlanUsageWindowDto[],
  billing: PlanUsageDto['billing'] = null,
): PlanUsageDto => ({ windows, billing });

const view = (u: PlanUsageDto | null, now = NOW, refresh: string | null | undefined = undefined) =>
  planUsageView(
    {
      planUsage: u,
      ...(refresh === undefined ? {} : { planUsageRefresh: { availableAt: refresh } }),
    },
    now,
    UTC,
  );

const CLAUDE = usage([
  win({
    key: 'account:5h',
    span: '5h',
    usedPercent: 62,
    resetAt: at(14, 10),
    observedAt: at(13, 2),
  }),
  win({
    key: 'account:weekly',
    span: 'weekly',
    usedPercent: 31,
    resetAt: at(18, 0, 9),
    observedAt: at(13, 2),
  }),
]);

describe('the line', () => {
  it('reads the Claude example, in order, ending with the observation time', () => {
    expect(view(CLAUDE)?.text).toBe(
      '5h 62% · resets 14:10 UTC · weekly 31% · resets Nov 9, 18:00 UTC · as of 13:02 UTC',
    );
  });

  it('orders the windows by span whatever order they arrive in', () => {
    const shuffled = usage([
      win({ key: 'a', span: 'annual', usedPercent: 1 }),
      win({ key: 'b', span: 'monthly', usedPercent: 2 }),
      win({ key: 'c', span: 'weekly', scope: 'Fable', usedPercent: 3 }),
      win({ key: 'd', span: 'weekly', usedPercent: 4 }),
      win({ key: 'e', span: 'daily', usedPercent: 5 }),
      win({ key: 'f', span: '5h', usedPercent: 6 }),
      win({ key: 'g', minutes: 90, usedPercent: 7 }),
      win({ key: 'h', minutes: 60, usedPercent: 8 }),
      win({ key: 'i', usedPercent: 9 }),
    ]);
    expect(view(shuffled)?.windows.map((w) => w.label)).toEqual([
      '5h',
      'daily',
      'weekly',
      'weekly Fable',
      'monthly',
      'annual',
      '1h window',
      '90-min window',
      'plan window',
    ]);
  });

  it('says unknown for a missing percent or reset, never 0% and never a lone dash', () => {
    const v = view(
      usage([
        win({ key: 'account:5h', span: '5h', usedPercent: null, resetAt: at(14, 10) }),
        win({ key: 'account:weekly', span: 'weekly', usedPercent: 31, resetAt: null }),
        win({ key: 'account:daily', span: 'daily', usedPercent: null, resetAt: null }),
      ]),
    )!;
    expect(v.windows.map((w) => w.text)).toEqual([
      '5h unknown · resets 14:10 UTC',
      'daily unknown · resets unknown',
      'weekly 31% · resets unknown',
    ]);
    expect(v.text).not.toMatch(/\b0%/);
    expect(v.text).not.toMatch(/(^| )[-–—]( |$)/);
  });

  it('keeps a real 0% as 0%: only a missing value is unknown', () => {
    expect(
      view(usage([win({ key: 'account:5h', span: '5h', usedPercent: 0 })]))?.windows[0]?.text,
    ).toMatch(/^5h 0% /);
  });

  it('reads reset · awaiting new data once the reset passes, with no percent', () => {
    const v = view(CLAUDE, Date.parse(at(14, 11)))!;
    expect(v.windows[0]?.text).toBe('5h reset · awaiting new data');
    expect(v.windows[0]?.awaiting).toBe(true);
    expect(v.windows[0]?.text).not.toMatch(/62/);
    expect(v.windows[1]?.text).toMatch(/^weekly 31%/);
    // The instant of the reset itself counts as passed.
    expect(view(CLAUDE, Date.parse(at(14, 10)))?.windows[0]?.awaiting).toBe(true);
    expect(v.text).toContain('5h ' + PLAN_USAGE_COPY.awaiting);
  });

  it('names the year of a reset outside the current year', () => {
    const v = view(
      usage([win({ key: 'account:annual', span: 'annual', resetAt: '2027-03-01T00:00:00.000Z' })]),
    )!;
    expect(v.windows[0]?.text).toBe('annual 50% · resets Mar 1, 2027, 00:00 UTC');
  });

  it('is null for planUsage = null, and for nothing but the plan’s own billing state', () => {
    expect(view(null)).toBeNull();
    expect(planUsageView({}, NOW, UTC)).toBeNull();
    expect(view(usage([], { state: 'plan', observedAt: at(13, 2) }))).toBeNull();
  });
});

describe('as of', () => {
  it('is the oldest observedAt among the windows shown', () => {
    const v = view(
      usage([
        win({ key: 'account:5h', span: '5h', observedAt: at(13, 2) }),
        win({ key: 'account:weekly', span: 'weekly', observedAt: at(9, 0) }),
      ]),
    )!;
    expect(v.asOf).toBe('09:00 UTC');
    expect(v.text.endsWith('as of 09:00 UTC')).toBe(true);
  });

  it('windows at 09:00 and billing at 13:40 read as of 09:00', () => {
    const v = view(
      usage([win({ key: 'account:5h', span: '5h', observedAt: at(9, 0), resetAt: at(18) })], {
        state: 'extra_usage',
        observedAt: at(13, 40),
      }),
    )!;
    expect(v.billingPhrase).not.toBeNull();
    expect(v.asOf).toBe('09:00 UTC');
  });

  it('a billing-only observation reads as of its own time', () => {
    const v = view(usage([], { state: 'extra_usage', observedAt: at(13, 40) }))!;
    expect(v.text).toBe(`${PLAN_USAGE_COPY.extraUsage} · as of 13:40 UTC`);
  });

  it('a window already reading awaiting does not hold the time back', () => {
    const v = view(
      usage([
        win({ key: 'account:5h', span: '5h', observedAt: at(9, 0), resetAt: at(13, 0) }),
        win({ key: 'account:weekly', span: 'weekly', observedAt: at(13, 30) }),
      ]),
    )!;
    expect(v.windows[0]?.awaiting).toBe(true);
    expect(v.asOf).toBe('13:30 UTC');
  });

  it('with every window awaiting, it is the oldest of them, never invented', () => {
    const v = view(
      usage([win({ key: 'account:5h', span: '5h', observedAt: at(9, 0), resetAt: at(13, 0) })]),
    )!;
    expect(v.asOf).toBe('09:00 UTC');
  });

  it('names the date when the oldest figure is from another day', () => {
    const v = view(usage([win({ key: 'account:5h', span: '5h', observedAt: at(23, 15, 5) })]))!;
    expect(v.asOf).toBe('Nov 5, 23:15 UTC');
  });
});

describe('the billing phrase', () => {
  const windows = [
    win({
      key: 'account:5h',
      span: '5h',
      usedPercent: 100,
      resetAt: at(18),
      observedAt: at(13, 2),
    }),
  ];

  it('extra usage says the plan is billing extra usage at the provider’s paid rates', () => {
    const v = view(usage(windows, { state: 'extra_usage', observedAt: at(13, 2) }))!;
    expect(v.billingPhrase).toBe(PLAN_USAGE_COPY.extraUsage);
    expect(v.billingPhrase).toMatch(/extra usage/i);
    expect(v.billingPhrase).toMatch(/paid rates/);
    expect(v.text.startsWith(PLAN_USAGE_COPY.extraUsage)).toBe(true);
  });

  it('the ChatGPT inference says credits MAY be in use, never that they are', () => {
    const v = view(usage(windows, { state: 'extra_usage_possible', observedAt: at(13, 2) }))!;
    expect(v.billingPhrase).toBe(PLAN_USAGE_COPY.extraUsagePossible);
    expect(v.billingPhrase).toMatch(/\bmay\b/);
    expect(v.billingPhrase).toMatch(/full/);
  });

  it('the plan itself, or no state, says nothing', () => {
    expect(
      view(usage(windows, { state: 'plan', observedAt: at(13, 2) }))?.billingPhrase,
    ).toBeNull();
    expect(view(usage(windows, null))?.billingPhrase).toBeNull();
  });

  it('is omitted once a shown window’s reset after the billing observation has passed', () => {
    const u = usage(windows, { state: 'extra_usage', observedAt: at(13, 2) });
    expect(view(u, Date.parse(at(17, 59)))?.billingPhrase).not.toBeNull();
    const after = view(u, Date.parse(at(18, 1)))!;
    expect(after.billingPhrase).toBeNull();
    expect(after.windows[0]?.text).toBe('5h reset · awaiting new data');
    expect(after.text).not.toMatch(/extra usage|credits/i);
  });

  it('survives a reset that fell BEFORE the billing observation', () => {
    const u = usage(
      [win({ key: 'account:5h', span: '5h', resetAt: at(13, 0), observedAt: at(13, 30) })],
      { state: 'extra_usage', observedAt: at(13, 30) },
    );
    expect(view(u)?.billingPhrase).toBe(PLAN_USAGE_COPY.extraUsage);
  });
});

describe('labels', () => {
  const label = (w: Partial<PlanUsageWindowDto>): string | undefined =>
    view(usage([win({ key: 'k', ...w })]))?.windows[0]?.label;

  it('a scoped account window names its scope', () => {
    expect(label({ span: 'weekly', scope: 'Fable' })).toBe('weekly Fable');
  });
  it('an unnamed length reads in whole hours or in minutes', () => {
    expect(label({ minutes: 60 })).toBe('1h window');
    expect(label({ minutes: 120 })).toBe('2h window');
    expect(label({ minutes: 90 })).toBe('90-min window');
  });
  it('a window with no length at all is a plan window', () => {
    expect(label({ minutes: null })).toBe('plan window');
    expect(label({ minutes: 0 })).toBe('plan window');
  });
});

describe('model buckets', () => {
  const codex = usage([
    win({ key: 'account:5h', span: '5h', usedPercent: 40, resetAt: at(15) }),
    win({
      key: 'model:gpt_5_2_codex_sonic',
      group: 'model',
      span: '5h',
      scope: 'gpt-5.2-codex-sonic',
      usedPercent: 80,
      resetAt: at(16),
    }),
    win({
      key: 'model:other',
      group: 'model',
      scope: null,
      usedPercent: null,
      resetAt: null,
    }),
  ]);

  it('keeps buckets out of the line and in their own list, with their name, percent and reset', () => {
    const v = view(codex)!;
    expect(v.windows.map((w) => w.key)).toEqual(['account:5h']);
    expect(v.buckets.map((b) => b.text)).toEqual([
      'gpt-5.2-codex-sonic 80% · resets 16:00 UTC',
      'other unknown · resets unknown',
    ]);
    expect(v.text).not.toMatch(/sonic/);
  });

  it('a bucket past its reset reads awaiting too', () => {
    const v = view(codex, Date.parse(at(16, 5)))!;
    expect(v.buckets[0]?.text).toBe('gpt-5.2-codex-sonic reset · awaiting new data');
  });
});

describe('nextTickAt', () => {
  it('is the earliest future reset', () => {
    expect(view(CLAUDE)?.nextTickAt).toBe(Date.parse(at(14, 10)));
  });

  it('skips resets already past and takes availableAt when it is sooner', () => {
    const u = usage([
      win({ key: 'account:5h', span: '5h', resetAt: at(13, 0) }),
      win({ key: 'account:weekly', span: 'weekly', resetAt: at(18, 0, 9) }),
    ]);
    expect(view(u)?.nextTickAt).toBe(Date.parse(at(18, 0, 9)));
    expect(view(u, NOW, at(13, 45))?.nextTickAt).toBe(Date.parse(at(13, 45)));
    // A cooldown already over is not a tick.
    expect(view(u, NOW, at(13, 0))?.nextTickAt).toBe(Date.parse(at(18, 0, 9)));
  });

  it('is null when nothing is in the future', () => {
    expect(
      view(usage([win({ key: 'account:5h', span: '5h', resetAt: null })]))?.nextTickAt,
    ).toBeNull();
  });

  it('serves a provider with a cooldown and no usage yet, which has no line but a button', () => {
    const p = { planUsage: null, planUsageRefresh: { availableAt: at(13, 45) } };
    expect(planUsageView(p, NOW, UTC)).toBeNull();
    expect(nextTickAt(p, NOW)).toBe(Date.parse(at(13, 45)));
    expect(nextTickAt({ planUsage: null, planUsageRefresh: null }, NOW)).toBeNull();
  });
});

describe('the reset reads like fmtUntil', () => {
  it('a reset in the current year is exactly fmtUntil’s output', () => {
    const reset = at(18, 0, 9);
    expect(
      view(usage([win({ key: 'account:5h', span: '5h', resetAt: reset })]))?.windows[0]?.text,
    ).toBe(`5h 50% · resets ${String(fmtUntil(reset, NOW, UTC))}`);
  });
});
