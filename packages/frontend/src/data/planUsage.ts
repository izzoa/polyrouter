/**
 * The provider card's plan-usage line (add-subscription-quota-display, design D10).
 *
 * `planUsageView` is a pure function of the provider view and a clock: it reads the server's
 * `planUsage` snapshot and states it as one neutral line of text. It asserts nothing about health
 * (the card's one status line does that), never a zero for a missing value (DESIGN.md Words, Not
 * Zeros), and never claims newer data than its oldest figure. `nextTickAt` is the one instant at
 * which the line, or the Refresh usage button, next changes with no new data: the card arms a
 * single timer for it.
 *
 * Display only. Nothing here feeds routing, an alert or a cost (invariant 4).
 */
import type {
  PlanUsageBillingDto,
  PlanUsageDto,
  PlanUsageRefreshDto,
  PlanUsageSpanDto,
  PlanUsageWindowDto,
} from './api';
import { fmtAsOf, fmtReset } from './format';

/** The longest the card waits on one timer. A usage reset can be a month or a year away, beyond
 * `setTimeout`'s 2^31-1 ms limit, where a browser fires at once and the card would spin or lose
 * the transition. The card re-arms when the timer fires, so the wait is bounded and the flip still
 * lands at the reset's own instant. */
export const MAX_USAGE_TICK_MS = 24 * 3_600_000;

/** Every string the line says, in one place (design D10, FD4; confirmed with /ss-copy). */
export const PLAN_USAGE_COPY = {
  /** A missing percent or reset. Never `0%`, never a lone dash. */
  unknown: 'unknown',
  /** After a window's label, once its reset has passed: `5h reset · awaiting new data`. */
  awaiting: 'reset · awaiting new data',
  /** Paid overflow, stated. Ink 2: a fact about billing, not a provider fault. */
  extraUsage: 'Plan is now billing extra usage at the provider’s paid rates',
  /** ChatGPT's inference: the window is full and credits exist, so they MAY be in use. */
  extraUsagePossible: 'Plan window is full, so credits may be in use',
  /** A window whose length is not known at all (Kimi's `usage` summary). */
  planWindow: 'plan window',
} as const;

export interface PlanUsageWindowView {
  readonly key: string;
  /** The window's name in the line: `5h`, `weekly Fable`, `1h window`, or a model bucket's name. */
  readonly label: string;
  /** The window as one phrase: `5h 62% · resets 14:10 UTC`, or `5h reset · awaiting new data`. */
  readonly text: string;
  /** The reset has passed, so the percent is no longer shown. */
  readonly awaiting: boolean;
}

export interface PlanUsageView {
  /** The whole line as one string, read by a screen reader as one line of text. */
  readonly text: string;
  /** The billing phrase that leads the line (Ink 2), or null. */
  readonly billingPhrase: string | null;
  /** The line without its billing phrase: the windows, then `as of <time>`. */
  readonly body: string;
  /** Account windows, in order. */
  readonly windows: readonly PlanUsageWindowView[];
  /** Model buckets, for the disclosure. */
  readonly buckets: readonly PlanUsageWindowView[];
  /** The oldest observation among the figures the line shows, as a clock time. */
  readonly asOf: string;
  /** The next instant the view changes with no new data, or null. */
  readonly nextTickAt: number | null;
}

/** What the view reads of a provider. */
export interface PlanUsageSource {
  readonly planUsage?: PlanUsageDto | null;
  readonly planUsageRefresh?: PlanUsageRefreshDto | null;
}

const SPAN_ORDER: Readonly<Record<PlanUsageSpanDto, number>> = {
  '5h': 0,
  daily: 1,
  weekly: 2,
  monthly: 3,
  annual: 4,
};
/** A window of unnamed length sorts after every named span. */
const UNNAMED_ORDER = 5;

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** A named span is its label; an unnamed length is labelled by its minutes (`1h window`,
 * `90-min window`); a window with no length at all is a `plan window`. A scoped account window
 * names its scope (`weekly Fable`). */
function windowLabel(w: PlanUsageWindowDto): string {
  let base: string;
  if (w.span !== null) base = w.span;
  else if (w.minutes !== null && w.minutes > 0) {
    base =
      w.minutes % 60 === 0
        ? `${String(w.minutes / 60)}h window`
        : `${String(w.minutes)}-min window`;
  } else base = PLAN_USAGE_COPY.planWindow;
  return w.group === 'account' && w.scope !== null ? `${base} ${w.scope}` : base;
}

/** A model bucket is named by its allowlisted scope (or the id the server derived). */
function bucketLabel(w: PlanUsageWindowDto): string {
  return w.scope ?? w.key.replace(/^model:/, '');
}

function windowView(
  w: PlanUsageWindowDto,
  label: string,
  now: number,
  timeZone: string | undefined,
): PlanUsageWindowView {
  const reset = ms(w.resetAt);
  const awaiting = reset !== null && reset <= now;
  if (awaiting) {
    return { key: w.key, label, text: `${label} ${PLAN_USAGE_COPY.awaiting}`, awaiting };
  }
  const percent =
    w.usedPercent === null ? PLAN_USAGE_COPY.unknown : `${String(Math.round(w.usedPercent))}%`;
  const resetText =
    w.resetAt === null
      ? PLAN_USAGE_COPY.unknown
      : (fmtReset(w.resetAt, now, timeZone) ?? PLAN_USAGE_COPY.unknown);
  return { key: w.key, label, text: `${label} ${percent} · resets ${resetText}`, awaiting };
}

/** Account windows by span (5h, daily, weekly with the unscoped one first, monthly, annual),
 * then windows of unnamed length, shortest first. */
function byOrder(a: PlanUsageWindowDto, b: PlanUsageWindowDto): number {
  const oa = a.span === null ? UNNAMED_ORDER : SPAN_ORDER[a.span];
  const ob = b.span === null ? UNNAMED_ORDER : SPAN_ORDER[b.span];
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

/** The earliest FUTURE reset of any shown window, or the refresh cooldown's end, whichever is
 * first: the one instant at which the line, or the Refresh usage button, changes by itself.
 * Exported separately because a provider with a cooldown and no usage yet has no line but still
 * has a button to re-enable. */
export function nextTickAt(p: PlanUsageSource, now: number): number | null {
  let next: number | null = null;
  const consider = (t: number | null): void => {
    if (t === null || t <= now) return;
    if (next === null || t < next) next = t;
  };
  for (const w of p.planUsage?.windows ?? []) consider(ms(w.resetAt));
  consider(ms(p.planUsageRefresh?.availableAt ?? null));
  return next;
}

/** The billing phrase for a state, or null for the plan itself. */
function billingText(state: PlanUsageBillingDto): string | null {
  if (state === 'extra_usage') return PLAN_USAGE_COPY.extraUsage;
  if (state === 'extra_usage_possible') return PLAN_USAGE_COPY.extraUsagePossible;
  return null;
}

/**
 * The line for one provider, or null when there is nothing to say (`planUsage = null`, or only
 * the plan's own billing state with no window). `now` and `timeZone` are injectable for tests.
 *
 * - A window with no percent or no reset says `unknown` in that slot.
 * - A window whose reset has passed reads `<label> reset · awaiting new data`.
 * - The billing phrase leads the line, and is omitted once the reset of a window on the line, which
 *   fell after the billing state was observed, has passed: the state may have ended with it.
 * - `asOf` is the OLDEST observation among the figures shown (the windows still showing a
 *   percent, the buckets, and the billing phrase when shown), so the line never claims newer data
 *   than its oldest figure. When every window reads `awaiting`, the oldest of them.
 */
export function planUsageView(
  p: PlanUsageSource,
  now: number,
  timeZone?: string,
): PlanUsageView | null {
  const usage = p.planUsage ?? null;
  if (usage === null) return null;

  const accounts = usage.windows.filter((w) => w.group === 'account').sort(byOrder);
  const models = usage.windows.filter((w) => w.group === 'model').sort(byOrder);
  const windows = accounts.map((w) => windowView(w, windowLabel(w), now, timeZone));
  const buckets = models.map((w) => windowView(w, bucketLabel(w), now, timeZone));

  let billingPhrase: string | null = null;
  const billing = usage.billing;
  if (billing !== null) {
    const phrase = billingText(billing.state);
    const seen = ms(billing.observedAt);
    const endedWithReset =
      seen !== null &&
      accounts.some((w) => {
        const reset = ms(w.resetAt);
        return reset !== null && reset > seen && reset <= now;
      });
    if (phrase !== null && !endedWithReset) billingPhrase = phrase;
  }

  if (windows.length === 0 && buckets.length === 0 && billingPhrase === null) return null;

  const all = [...accounts, ...models];
  const shown = [...windows, ...buckets];
  // The windows still showing a percent: one reading `awaiting` states no figure.
  const observed: number[] = [];
  all.forEach((w, i) => {
    const t = ms(w.observedAt);
    if (t !== null && shown[i]?.awaiting !== true) observed.push(t);
  });
  const billingSeen = billingPhrase !== null && billing !== null ? ms(billing.observedAt) : null;
  if (billingSeen !== null) observed.push(billingSeen);
  let times = observed;
  if (times.length === 0) {
    times = all.map((w) => ms(w.observedAt)).filter((t): t is number => t !== null);
  }
  const oldest = times.length === 0 ? null : Math.min(...times);
  const asOf =
    (oldest === null ? null : fmtAsOf(new Date(oldest).toISOString(), now, timeZone)) ??
    PLAN_USAGE_COPY.unknown;

  const body = [...windows.map((w) => w.text), `as of ${asOf}`].join(' · ');
  return {
    text: billingPhrase === null ? body : `${billingPhrase} · ${body}`,
    billingPhrase,
    body,
    windows,
    buckets,
    asOf,
    nextTickAt: nextTickAt(p, now),
  };
}
