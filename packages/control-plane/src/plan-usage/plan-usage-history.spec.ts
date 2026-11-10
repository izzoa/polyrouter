// add-subscription-usage-history task 4.2: the history answer's spans, order, labels and the
// windows no longer in the snapshot. Pure functions: no store, no clock of their own.
import type { PlanUsageSampleView } from '@polyrouter/shared/server';
import {
  HISTORY_UNKNOWN_LENGTH_MS,
  buildPlanUsageHistory,
  historySinceByWindow,
  historySpanStart,
  historyWindowLabel,
  snapshotWindowMetas,
  windowMetaFromKey,
  type HistoryWindowMeta,
} from './plan-usage-history';

const NOW = Date.UTC(2026, 10, 9, 12, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const meta = (over: Partial<HistoryWindowMeta>): HistoryWindowMeta => ({
  key: 'account:5h',
  group: 'account',
  span: '5h',
  minutes: 300,
  scope: null,
  resetMs: null,
  ...over,
});
const sample = (
  windowKey: string,
  at: number,
  usedPercent: number | null,
  resetAt: number | null = null,
): PlanUsageSampleView => ({
  windowKey,
  usedPercent,
  resetAt: resetAt === null ? null : new Date(resetAt),
  observedAt: new Date(at),
});

describe('plan-usage history (task 4.2)', () => {
  it('a window spans from its reset minus its length; unknown reset: the last length; unknown length: 7 days', () => {
    // The weekly window resets in 2 days: its span started 5 days ago.
    expect(
      historySpanStart(meta({ span: 'weekly', minutes: 10_080, resetMs: NOW + 2 * DAY }), NOW),
    ).toBe(NOW - 5 * DAY);
    expect(historySpanStart(meta({ resetMs: NOW + 2 * HOUR }), NOW)).toBe(NOW - 3 * HOUR);
    expect(historySpanStart(meta({ resetMs: null }), NOW)).toBe(NOW - 5 * HOUR);
    expect(historySpanStart(meta({ span: null, minutes: 90 }), NOW)).toBe(NOW - 90 * 60_000);
    expect(historySpanStart(meta({ span: null, minutes: null }), NOW)).toBe(
      NOW - HISTORY_UNKNOWN_LENGTH_MS,
    );
    // Never after now (a reset at the far plausibility edge).
    expect(historySpanStart(meta({ resetMs: NOW + 6 * HOUR }), NOW)).toBe(NOW);
  });

  it('labels follow the usage line: span, scope, unnamed lengths, a plan window, model buckets', () => {
    expect(historyWindowLabel(meta({}))).toBe('5h');
    expect(
      historyWindowLabel(meta({ key: 'account:weekly:Fable', span: 'weekly', scope: 'Fable' })),
    ).toBe('weekly Fable');
    expect(historyWindowLabel(meta({ span: null, minutes: 60 }))).toBe('1h window');
    expect(historyWindowLabel(meta({ span: null, minutes: 90 }))).toBe('90-min window');
    expect(historyWindowLabel(meta({ span: null, minutes: null }))).toBe('plan window');
    expect(
      historyWindowLabel(meta({ key: 'model:spark', group: 'model', scope: 'GPT Spark' })),
    ).toBe('GPT Spark');
    expect(historyWindowLabel(meta({ key: 'model:spark', group: 'model', scope: null }))).toBe(
      'spark',
    );
  });

  it('reads what it can from a key alone', () => {
    expect(windowMetaFromKey('account:weekly:Sonnet')).toEqual({
      key: 'account:weekly:Sonnet',
      group: 'account',
      span: 'weekly',
      minutes: 10_080,
      scope: 'Sonnet',
    });
    expect(windowMetaFromKey('account:m90')).toMatchObject({ span: null, minutes: 90 });
    expect(windowMetaFromKey('account:summary')).toMatchObject({ span: null, minutes: null });
    expect(windowMetaFromKey('model:spark')).toMatchObject({ group: 'model', span: null });
  });

  it('each window holds its own span, oldest first, with an unknown percent kept as null', () => {
    const metas = snapshotWindowMetas({
      windows: [
        {
          key: 'account:weekly',
          group: 'account',
          span: 'weekly',
          minutes: 10_080,
          scope: null,
          usedPercent: 30,
          resetMs: NOW + 2 * DAY,
          observedAt: NOW - HOUR,
          source: 'refresh',
        },
        {
          key: 'account:5h',
          group: 'account',
          span: '5h',
          minutes: 300,
          scope: null,
          usedPercent: 12,
          resetMs: NOW + 2 * HOUR,
          observedAt: NOW - HOUR,
          source: 'refresh',
        },
      ],
      billing: null,
    });
    // The usage line's order: 5h before weekly.
    expect(metas.map((m) => m.key)).toEqual(['account:5h', 'account:weekly']);
    const since = historySinceByWindow(metas, NOW);
    expect(since.get('account:5h')!.getTime()).toBe(NOW - 3 * HOUR);
    expect(since.get('account:weekly')!.getTime()).toBe(NOW - 5 * DAY);

    const history = buildPlanUsageHistory(
      metas,
      [
        sample('account:5h', NOW - HOUR, 12, NOW + 2 * HOUR),
        sample('account:5h', NOW - 2 * HOUR, null, NOW + 2 * HOUR), // unknown stays null
        sample('account:5h', NOW - 4 * HOUR, 99), // before this span: the previous window
        sample('account:weekly', NOW - 4 * DAY, 10, NOW + 2 * DAY),
        sample('account:weekly', NOW - HOUR, 30, NOW + 2 * DAY),
      ],
      NOW,
    );
    expect(history.windows.map((w) => [w.key, w.label, w.from, w.resetAt])).toEqual([
      [
        'account:5h',
        '5h',
        new Date(NOW - 3 * HOUR).toISOString(),
        new Date(NOW + 2 * HOUR).toISOString(),
      ],
      [
        'account:weekly',
        'weekly',
        new Date(NOW - 5 * DAY).toISOString(),
        new Date(NOW + 2 * DAY).toISOString(),
      ],
    ]);
    expect(history.windows[0]!.samples).toEqual([
      {
        at: new Date(NOW - 2 * HOUR).toISOString(),
        usedPercent: null,
        resetAt: new Date(NOW + 2 * HOUR).toISOString(),
      },
      {
        at: new Date(NOW - HOUR).toISOString(),
        usedPercent: 12,
        resetAt: new Date(NOW + 2 * HOUR).toISOString(),
      },
    ]);
    expect(history.windows[1]!.samples.map((s) => s.usedPercent)).toEqual([10, 30]);
    expect(history.windows[0]).toMatchObject({
      group: 'account',
      span: '5h',
      minutes: 300,
      scope: null,
    });
  });

  it('a window with samples that the snapshot no longer carries is derived from its key and labelled by the usual rules', () => {
    const history = buildPlanUsageHistory(
      [],
      [
        sample('account:weekly:Fable', NOW - 3 * DAY, 40, NOW + 4 * DAY),
        sample('account:weekly:Fable', NOW - 9 * DAY, 80, NOW - 2 * DAY), // the previous week
        sample('model:spark', NOW - 2 * DAY, 5),
        sample('model:spark', NOW - 8 * DAY, 6), // past the 7-day fallback
      ],
      NOW,
    );
    expect(history.windows).toEqual([
      {
        key: 'account:weekly:Fable',
        group: 'account',
        span: 'weekly',
        minutes: 10_080,
        scope: 'Fable',
        label: 'weekly Fable',
        from: new Date(NOW - 3 * DAY).toISOString(),
        resetAt: new Date(NOW + 4 * DAY).toISOString(),
        samples: [
          {
            at: new Date(NOW - 3 * DAY).toISOString(),
            usedPercent: 40,
            resetAt: new Date(NOW + 4 * DAY).toISOString(),
          },
        ],
      },
      {
        key: 'model:spark',
        group: 'model',
        span: null,
        minutes: null,
        scope: null,
        label: 'spark',
        from: new Date(NOW - 7 * DAY).toISOString(),
        resetAt: null,
        samples: [{ at: new Date(NOW - 2 * DAY).toISOString(), usedPercent: 5, resetAt: null }],
      },
    ]);
  });

  it('no samples is an empty list, even beside a snapshot (the card shows "no reading yet")', () => {
    expect(buildPlanUsageHistory([meta({ resetMs: NOW + HOUR })], [], NOW)).toEqual({
      windows: [],
    });
    expect(buildPlanUsageHistory([], [], NOW)).toEqual({ windows: [] });
  });
});
