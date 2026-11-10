import type { PlanUsageSnapshot, PlanUsageSpan } from '@polyrouter/data-plane';
import type { PlanUsageSampleView } from '@polyrouter/shared/server';

/**
 * The owner's plan-usage history, as the provider card's graphs read it (add-subscription-usage-
 * history, design D5). Pure functions over the provider's CURRENT snapshot (for each window's key,
 * label, length and reset) and its samples: no store, no clock and no upstream call of their own.
 *
 * Each window covers its CURRENT span: from its reset minus its length (or, with an unknown reset,
 * the last `length`; with an unknown length, the last 7 days) until now. A window that has samples
 * but is no longer in the snapshot is derived from its key, labelled by the usual rules, and spans
 * from its latest sample's reset minus its length when both are known. Only windows with at least
 * one sample in their span are returned, so a provider without samples answers an empty list (the
 * card then shows "no reading yet" for each window of its usage line).
 *
 * Numbers, enums and ISO instants only (invariant 8).
 */

export interface PlanUsageHistorySample {
  /** When the figure was observed (ISO-8601). */
  at: string;
  /** Whole percent 0-100, or null when the reading was unknown (never 0). */
  usedPercent: number | null;
  resetAt: string | null;
}

export interface PlanUsageHistoryWindow {
  key: string;
  group: 'account' | 'model';
  span: PlanUsageSpan | null;
  minutes: number | null;
  scope: string | null;
  /** The window's name, by the usage line's own rules (`5h`, `weekly Fable`, `90-min window`,
   * a model bucket's name), or the key itself for a window no longer in the snapshot. */
  label: string;
  /** The span's start (ISO-8601). */
  from: string;
  resetAt: string | null;
  /** Oldest first. */
  samples: PlanUsageHistorySample[];
}

export interface PlanUsageHistory {
  windows: PlanUsageHistoryWindow[];
}

/** A window of unknown length spans the last 7 days (design D5). */
export const HISTORY_UNKNOWN_LENGTH_MS = 7 * 24 * 60 * 60 * 1000;
/** Samples of a window no longer in the snapshot are looked for back to the retention. */
export const HISTORY_LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;
/** A named span's length in minutes, as the data plane counts it (monthly 31 days, annual 366). */
const SPAN_MINUTES: Readonly<Record<PlanUsageSpan, number>> = {
  '5h': 300,
  daily: 1440,
  weekly: 10_080,
  monthly: 31 * 1440,
  annual: 366 * 1440,
};
const SPANS: ReadonlySet<string> = new Set(Object.keys(SPAN_MINUTES));

/** The parts of a window the history needs. */
export interface HistoryWindowMeta {
  readonly key: string;
  readonly group: 'account' | 'model';
  readonly span: PlanUsageSpan | null;
  readonly minutes: number | null;
  readonly scope: string | null;
  readonly resetMs: number | null;
}

/** The window's length in ms: its minutes, else its span, else unknown (null). */
function lengthMs(w: Pick<HistoryWindowMeta, 'span' | 'minutes'>): number | null {
  if (w.minutes !== null && w.minutes > 0) return w.minutes * MINUTE_MS;
  if (w.span !== null) return SPAN_MINUTES[w.span] * MINUTE_MS;
  return null;
}

/** Where a window's current span starts (design D5), never after `now`. */
export function historySpanStart(
  w: Pick<HistoryWindowMeta, 'span' | 'minutes' | 'resetMs'>,
  now: number,
): number {
  const length = lengthMs(w);
  if (length === null) return now - HISTORY_UNKNOWN_LENGTH_MS;
  const start = w.resetMs !== null ? w.resetMs - length : now - length;
  return Math.min(start, now);
}

/** What a window key says about its window (`account:5h`, `account:weekly:Fable`,
 * `account:m90`, `account:unsized`, `account:summary`, `model:<id>`): the most that can be read
 * from the key alone, for a window no longer in the snapshot. */
export function windowMetaFromKey(key: string): Omit<HistoryWindowMeta, 'resetMs'> {
  const [group, second, ...rest] = key.split(':');
  if (group === 'model') {
    return { key, group: 'model', span: null, minutes: null, scope: null };
  }
  if (second !== undefined && SPANS.has(second)) {
    const span = second as PlanUsageSpan;
    return {
      key,
      group: 'account',
      span,
      minutes: SPAN_MINUTES[span],
      scope: rest.length > 0 ? rest.join(':') : null,
    };
  }
  const sized = second !== undefined ? /^m(\d{1,6})$/.exec(second) : null;
  const minutes = sized?.[1] !== undefined ? Number(sized[1]) : null;
  return {
    key,
    group: 'account',
    span: null,
    minutes: minutes !== null && minutes > 0 ? minutes : null,
    scope: null,
  };
}

/** The usage line's label rules (packages/frontend/src/data/planUsage.ts `windowLabel` /
 * `bucketLabel`, kept in step): a named span is its label; an unnamed length is labelled by its
 * minutes (`1h window`, `90-min window`); no length at all is a `plan window`; a scoped account
 * window names its scope; a model bucket is named by its scope, or the id the server derived. */
export function historyWindowLabel(
  w: Pick<HistoryWindowMeta, 'key' | 'group' | 'span' | 'minutes' | 'scope'>,
): string {
  if (w.group === 'model') return w.scope ?? w.key.replace(/^model:/, '');
  let base: string;
  if (w.span !== null) base = w.span;
  else if (w.minutes !== null && w.minutes > 0) {
    base =
      w.minutes % 60 === 0
        ? `${String(w.minutes / 60)}h window`
        : `${String(w.minutes)}-min window`;
  } else base = 'plan window';
  return w.scope !== null ? `${base} ${w.scope}` : base;
}

const SPAN_ORDER: Readonly<Record<PlanUsageSpan, number>> = {
  '5h': 0,
  daily: 1,
  weekly: 2,
  monthly: 3,
  annual: 4,
};

/** The usage line's order: account windows by span (the unscoped one first), then unnamed
 * lengths shortest first, then model buckets in the same order. */
function byOrder(a: HistoryWindowMeta, b: HistoryWindowMeta): number {
  if (a.group !== b.group) return a.group === 'account' ? -1 : 1;
  const oa = a.span === null ? 5 : SPAN_ORDER[a.span];
  const ob = b.span === null ? 5 : SPAN_ORDER[b.span];
  if (oa !== ob) return oa - ob;
  if (a.span === null && a.minutes !== b.minutes) {
    if (a.minutes === null) return 1;
    if (b.minutes === null) return -1;
    return a.minutes - b.minutes;
  }
  const sa = a.scope === null ? 0 : 1;
  const sb = b.scope === null ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The snapshot's windows as history metadata, in the usage line's order. */
export function snapshotWindowMetas(
  snapshot: PlanUsageSnapshot | null | undefined,
): HistoryWindowMeta[] {
  return (snapshot?.windows ?? [])
    .map((w) => ({
      key: w.key,
      group: w.group,
      span: w.span,
      minutes: w.minutes,
      scope: w.scope,
      resetMs: w.resetMs,
    }))
    .sort(byOrder);
}

/** The per-window lower bounds to read samples from: each snapshot window's span start. Every
 * OTHER window is read from `now - HISTORY_LOOKBACK_MS` and narrowed by `buildPlanUsageHistory`. */
export function historySinceByWindow(
  metas: readonly HistoryWindowMeta[],
  now: number,
): Map<string, Date> {
  return new Map(metas.map((m) => [m.key, new Date(historySpanStart(m, now))]));
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The history answer from the snapshot's windows and the samples read (oldest first). */
export function buildPlanUsageHistory(
  metas: readonly HistoryWindowMeta[],
  samples: readonly PlanUsageSampleView[],
  now: number,
): PlanUsageHistory {
  const byKey = new Map<string, PlanUsageSampleView[]>();
  for (const s of samples) {
    const list = byKey.get(s.windowKey);
    if (list === undefined) byKey.set(s.windowKey, [s]);
    else list.push(s);
  }
  const ordered = (list: readonly PlanUsageSampleView[]): PlanUsageSampleView[] =>
    [...list].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const toSample = (s: PlanUsageSampleView): PlanUsageHistorySample => ({
    at: s.observedAt.toISOString(),
    usedPercent: s.usedPercent,
    resetAt: s.resetAt === null ? null : s.resetAt.toISOString(),
  });

  const windows: PlanUsageHistoryWindow[] = [];
  const known = new Set<string>();
  for (const m of metas) {
    known.add(m.key);
    const from = historySpanStart(m, now);
    const inSpan = ordered(byKey.get(m.key) ?? []).filter((s) => s.observedAt.getTime() >= from);
    if (inSpan.length === 0) continue;
    windows.push({
      key: m.key,
      group: m.group,
      span: m.span,
      minutes: m.minutes,
      scope: m.scope,
      label: historyWindowLabel(m),
      from: iso(from),
      resetAt: m.resetMs === null ? null : iso(m.resetMs),
      samples: inSpan.map(toSample),
    });
  }

  // Windows with samples that the snapshot no longer carries: derived from the key, labelled by the
  // same rules as the rest.
  const absent = [...byKey.keys()].filter((k) => !known.has(k)).sort();
  for (const key of absent) {
    const all = ordered(byKey.get(key)!);
    const latestReset = [...all].reverse().find((s) => s.resetAt !== null)?.resetAt ?? null;
    const meta = { ...windowMetaFromKey(key), resetMs: latestReset?.getTime() ?? null };
    const from = historySpanStart(meta, now);
    const inSpan = all.filter((s) => s.observedAt.getTime() >= from);
    if (inSpan.length === 0) continue;
    windows.push({
      key,
      group: meta.group,
      span: meta.span,
      minutes: meta.minutes,
      scope: meta.scope,
      label: historyWindowLabel(meta),
      from: iso(from),
      resetAt: latestReset === null ? null : latestReset.toISOString(),
      samples: inSpan.map(toSample),
    });
  }
  return { windows };
}
