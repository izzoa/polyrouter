/**
 * The provider card's usage graphs (add-subscription-usage-history, design D6).
 *
 * `planUsageGraphs` is a pure function of the provider view, its usage history and a clock. It
 * names one graph per window of the card's usage line (account windows in the line's order, then
 * the model buckets the line folds into its disclosure), matched to the history by the window's
 * `key`, then any window the history holds and the snapshot no longer carries. A window without a
 * sample is an empty track that says `no reading yet`; a provider with a usage source but neither a
 * window nor a sample shows ONE such track, labelled `Plan usage`.
 *
 * Honest by construction: a sample whose percent was unknown is a null, which the chart draws as a
 * gap (never a zero, never interpolated across), and a track with no known percent draws no line
 * and no point at all. Every figure states its observation time in words.
 *
 * Display only. Nothing here feeds routing, an alert or a cost (invariant 4).
 */
import type {
  PlanUsageHistoryDto,
  PlanUsageHistorySampleDto,
  PlanUsageHistoryWindowDto,
  PlanUsageSpanDto,
  PlanUsageWindowDto,
} from './api';
import { fmtAsOf, fmtReset } from './format';
import {
  bucketLabel,
  PLAN_USAGE_COPY,
  planUsageView,
  windowLabel,
  type PlanUsageSource,
} from './planUsage';

/** Every string the graphs say, in one place (dashboard-core "A subscription provider card graphs
 * each usage window over its span"; DESIGN.md Figures and their states). */
export const PLAN_USAGE_GRAPH_COPY = {
  /** A window with no sample in its span. Never `0%`. */
  noReading: 'no reading yet',
  /** The latest sample's percent was unknown. */
  unknown: PLAN_USAGE_COPY.unknown,
  /** The one track of a provider with a usage source but no window and no sample. */
  generic: 'Plan usage',
  /** The skeleton's hidden text finishes `Loading …`. */
  loading: 'usage history',
  /** The Failed state (DESIGN.md: `<What> couldn't be loaded.` + Retry). */
  failed: 'Usage history couldn’t be loaded. Routing is unaffected.',
  failedTitle: 'Couldn’t load',
  retry: 'Retry',
} as const;

/** A window of unknown length spans the last 7 days (design D5, as the server reads it). */
export const UNKNOWN_SPAN_MS = 7 * 86_400_000;
/** A named span's length in minutes, as the data plane counts it (monthly 31 days, annual 366):
 * the span of a window the history has no sample for yet, which the server does not return. */
const SPAN_MINUTES: Readonly<Record<PlanUsageSpanDto, number>> = {
  '5h': 300,
  daily: 1440,
  weekly: 10_080,
  monthly: 31 * 1440,
  annual: 366 * 1440,
};
/** The shortest span a graph covers, so a degenerate span still has a width. */
const MIN_SPAN_MS = 60_000;

export interface PlanUsageGraphView {
  /** The window's key (`account:5h`), or `plan-usage` for the generic track. */
  readonly key: string;
  /** The window's name, as the usage line names it: `5h`, `weekly Fable`, a bucket's name. */
  readonly label: string;
  /** The latest reading: `58% used`, `unknown`, or `no reading yet`. */
  readonly figure: string;
  /** Whether `figure` is a percent (Ink) rather than a state word (Ink 3). */
  readonly known: boolean;
  /** `resets 16:10 UTC`, `resets unknown`, `reset 14:00 UTC` once passed; null for the generic
   * track, which has no window to reset. */
  readonly reset: string | null;
  /** The span the graph covers, in words: `from 11:10 UTC to 16:10 UTC`, or `… to now`. */
  readonly range: string;
  /** `latest reading 14:00 UTC`, or null without a sample. */
  readonly latest: string | null;
  /** The x axis, in epoch SECONDS (uPlot's unit). */
  readonly xExtent: [number, number];
  /** The reset as a dashed reference line, in epoch seconds, or null (unknown, or outside). */
  readonly referenceX: number | null;
  /** `[secs[], percents[]]`: a null percent is a gap. */
  readonly data: [number[], (number | null)[]];
  /** No known percent to draw: the track alone. */
  readonly empty: boolean;
}

export interface PlanUsageGraphs {
  /** The account windows, charted under the usage line. */
  readonly accounts: readonly PlanUsageGraphView[];
  /** The model buckets, charted inside a disclosure as the line lists them. */
  readonly buckets: readonly PlanUsageGraphView[];
}

const ms = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const iso = (t: number): string => new Date(t).toISOString();
const clampPercent = (p: number): number => Math.min(100, Math.max(0, p));

/** Where a snapshot window's current span starts, the server's rule (design D5): its reset minus
 * its length, the last `length` with an unknown reset, the last 7 days with an unknown length;
 * never after `now`. */
export function snapshotSpanStart(
  w: Pick<PlanUsageWindowDto, 'span' | 'minutes' | 'resetAt'>,
  now: number,
): number {
  const length =
    w.minutes !== null && w.minutes > 0
      ? w.minutes * 60_000
      : w.span !== null
        ? SPAN_MINUTES[w.span] * 60_000
        : null;
  if (length === null) return now - UNKNOWN_SPAN_MS;
  const reset = ms(w.resetAt);
  return Math.min(reset !== null ? reset - length : now - length, now);
}

/** One graph: the samples (oldest first) over `[start, end]`, where `end` is the reset while it
 * is ahead and `now` once it has passed or when it is unknown. */
function track(args: {
  key: string;
  label: string;
  resetIso: string | null;
  start: number;
  samples: readonly PlanUsageHistorySampleDto[];
  now: number;
  timeZone: string | undefined;
  generic?: boolean;
}): PlanUsageGraphView {
  const { now, timeZone } = args;
  const samples = args.samples
    .map((s) => ({ s, at: ms(s.at) }))
    .filter((x): x is { s: PlanUsageHistorySampleDto; at: number } => x.at !== null)
    .sort((a, b) => a.at - b.at);
  const reset = ms(args.resetIso);
  const ahead = reset !== null && reset > now;
  const first = samples[0]?.at ?? null;
  const last = samples.at(-1) ?? null;
  let end = reset !== null && reset > now ? reset : now;
  if (last !== null && last.at > end) end = last.at;
  let start = first !== null ? Math.min(args.start, first) : args.start;
  if (end - start < MIN_SPAN_MS) start = end - MIN_SPAN_MS;

  const data: [number[], (number | null)[]] =
    samples.length === 0
      ? // The track alone: two empty readings at the span's edges set the axis, and draw nothing.
        [
          [start / 1000, end / 1000],
          [null, null],
        ]
      : [
          samples.map((x) => x.at / 1000),
          samples.map((x) => (x.s.usedPercent === null ? null : clampPercent(x.s.usedPercent))),
        ];
  const latestPercent = last?.s.usedPercent ?? null;
  const figure =
    last === null
      ? PLAN_USAGE_GRAPH_COPY.noReading
      : latestPercent === null
        ? PLAN_USAGE_GRAPH_COPY.unknown
        : `${String(Math.round(clampPercent(latestPercent)))}% used`;

  let resetText: string | null;
  if (args.generic === true) resetText = null;
  else if (reset === null || args.resetIso === null)
    resetText = `resets ${PLAN_USAGE_COPY.unknown}`;
  else if (ahead) {
    resetText = `resets ${fmtReset(args.resetIso, now, timeZone) ?? PLAN_USAGE_COPY.unknown}`;
  } else resetText = `reset ${fmtAsOf(args.resetIso, now, timeZone) ?? PLAN_USAGE_COPY.unknown}`;

  const from = fmtAsOf(iso(start), now, timeZone) ?? PLAN_USAGE_COPY.unknown;
  const to =
    ahead && args.resetIso !== null ? (fmtReset(args.resetIso, now, timeZone) ?? 'now') : 'now';
  return {
    key: args.key,
    label: args.label,
    figure,
    known: last !== null && latestPercent !== null,
    reset: resetText,
    range: `from ${from} to ${to}`,
    latest:
      last === null
        ? null
        : `latest reading ${fmtAsOf(last.s.at, now, timeZone) ?? PLAN_USAGE_COPY.unknown}`,
    xExtent: [start / 1000, end / 1000],
    referenceX: reset !== null && reset >= start && reset <= end ? reset / 1000 : null,
    data,
    empty: !samples.some((x) => x.s.usedPercent !== null),
  };
}

function graphOf(
  key: string,
  label: string,
  snap: PlanUsageWindowDto | undefined,
  hist: PlanUsageHistoryWindowDto | undefined,
  now: number,
  timeZone: string | undefined,
): PlanUsageGraphView {
  // The history's span is the server's (read against the snapshot it holds now); without a sample
  // the server returns no window, so the snapshot's own span is derived by the same rule.
  const resetIso = hist !== undefined ? hist.resetAt : (snap?.resetAt ?? null);
  const start =
    hist !== undefined
      ? (ms(hist.from) ?? now - UNKNOWN_SPAN_MS)
      : snap !== undefined
        ? snapshotSpanStart(snap, now)
        : now - UNKNOWN_SPAN_MS;
  return track({ key, label, resetIso, start, samples: hist?.samples ?? [], now, timeZone });
}

/**
 * The graphs for one provider card. `history` is the history endpoint's answer; `now` and
 * `timeZone` are injectable for tests.
 */
export function planUsageGraphs(
  p: PlanUsageSource,
  history: PlanUsageHistoryDto,
  now: number,
  timeZone?: string,
): PlanUsageGraphs {
  const line = planUsageView(p, now, timeZone);
  const snapshot = new Map((p.planUsage?.windows ?? []).map((w) => [w.key, w]));
  const byKey = new Map(history.windows.map((w) => [w.key, w]));
  const shown = new Set<string>();
  const accounts: PlanUsageGraphView[] = [];
  const buckets: PlanUsageGraphView[] = [];
  for (const w of line?.windows ?? []) {
    shown.add(w.key);
    accounts.push(graphOf(w.key, w.label, snapshot.get(w.key), byKey.get(w.key), now, timeZone));
  }
  for (const w of line?.buckets ?? []) {
    shown.add(w.key);
    buckets.push(graphOf(w.key, w.label, snapshot.get(w.key), byKey.get(w.key), now, timeZone));
  }
  // Windows with samples the snapshot no longer carries, named by the line's own rules.
  for (const h of history.windows) {
    if (shown.has(h.key)) continue;
    shown.add(h.key);
    if (h.group === 'model')
      buckets.push(graphOf(h.key, bucketLabel(h), undefined, h, now, timeZone));
    else accounts.push(graphOf(h.key, windowLabel(h), undefined, h, now, timeZone));
  }
  if (accounts.length === 0 && buckets.length === 0) {
    accounts.push(
      track({
        key: 'plan-usage',
        label: PLAN_USAGE_GRAPH_COPY.generic,
        resetIso: null,
        start: now - UNKNOWN_SPAN_MS,
        samples: [],
        now,
        timeZone,
        generic: true,
      }),
    );
  }
  return { accounts, buckets };
}
