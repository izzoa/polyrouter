import { totalCostMicros, type RequestRow } from './api';

/** The figure-state vocabulary (adopt-figure-states design D1, D2, D4, D8; DESIGN.md
 * Components → Figures and their states).
 *
 * One pure module owns every figure-state string and every display-precision rule, so a
 * state cannot be spelled two ways on two pages. Components render what these return and
 * never format money, durations or token counts themselves.
 *
 * Display only: nothing here changes a stored or computed value. A recorded cost and its
 * price snapshots are read, never recomputed (invariant 4), and callers compare exact
 * micro-dollars, never the rounded text. No function mutates its input. */

/** `· est.` follows a money figure, or a price label, priced from an estimate. */
export const EST = '· est.';
/** `· est. usage` follows a token count the provider did not report. Never merged with
 * `EST`: estimated usage never marks money, and an estimated price never marks a count. */
export const EST_USAGE = '· est. usage';
/** A request no provider billed: a known zero, never an estimate. */
export const NOT_BILLED = '$0 · not billed';
/** `NOT_BILLED` under its old name. The one-release re-export from `data/analytics.ts`
 * was removed by add-route-trace-inspector (task 3.6); import from here. */
export const NOT_BILLED_LABEL = NOT_BILLED;
/** A zero-priced figure. `free` is its green word; the `$0` keeps the slot's ink. */
export const FREE = '$0 free';
/** An unknown price or cost. A bare word: never a dash, never `$0.00`. */
export const UNPRICED = 'unpriced';
/** An unknown measurement, such as a null signal-quality score. */
export const UNKNOWN = 'unknown';
/** A ratio whose denominator is zero. Never `0%`, `NaN%` or a dash. */
export const NOT_APPLICABLE = 'not applicable';
/** The only meaning of a lone dash in a figure slot: work still in flight. */
export const PENDING = '—';
/** The fixed label beneath a batch job's reserved ceiling. */
export const RESERVED_LABEL = 'reserved, not spent';
/** Retained data from a period that has ended. */
export const EXPIRED = 'expired · awaiting refresh';

/** The `$0` and the `free` of `FREE`, split so each takes its own tone. */
const FREE_AMOUNT = '$0';
const FREE_WORD = 'free';
/** The two no-wrap halves of `NOT_BILLED`. The cost track is narrower than the phrase, so
 * it may wrap only at the dot, never mid-phrase (`$0 · not` / `billed`). */
const NOT_BILLED_HALVES = ['$0 ·', 'not billed'] as const;

/* ---- figure parts ---------------------------------------------------------------- */

/** How a part of a figure is coloured. `slot` has no colour of its own and inherits the
 * slot's ink (an amount, the `$0` before `free`); `green` is the `free` word; `ink3` the
 * estimate markers and `unpriced`; `ink2` both halves of `$0 · not billed`. Colour only
 * repeats the words: every state is named in the text. */
export type FigureTone = 'slot' | 'ink2' | 'ink3' | 'green';

/** One no-wrap unit of a figure. A figure wraps only between its parts. */
export interface FigurePart {
  readonly text: string;
  readonly tone: FigureTone;
}

/** A figure's string form: its parts' texts joined by single spaces. Plain-text sinks (a
 * native `<option>`, an `aria-label`, a `title`) take this; everything else renders the
 * parts through `components/FigureText.tsx`. */
export function partsText(parts: readonly FigurePart[]): string {
  return parts.map((p) => p.text).join(' ');
}

const toned = (text: string, tone: FigureTone): FigurePart => ({ text, tone });

function withEstimate(parts: readonly FigurePart[], estimated: boolean): readonly FigurePart[] {
  return estimated ? [...parts, toned(EST, 'ink3')] : parts;
}

/** The `· est. usage` marker as parts: one Ink 3 unit that never splits. */
export const EST_USAGE_PARTS: readonly FigurePart[] = [toned(EST_USAGE, 'ink3')];
/** The `· est.` marker alone, for a figure whose own words are not parts (the savings
 * caution): one Ink 3 unit, never in a status colour such as amber. */
export const EST_PARTS: readonly FigurePart[] = [toned(EST, 'ink3')];

/** A sentence-like figure line as parts: each word its own unit in the slot's ink, so the
 * line still wraps at any space, with the `unknown` word in Ink 3 (design D1). The parts'
 * texts joined by spaces are the line itself. */
export function wordParts(text: string): readonly FigurePart[] {
  return text
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => toned(w, w === UNKNOWN ? 'ink3' : 'slot'));
}

/* ---- money ----------------------------------------------------------------------- */

/** A money slot's declared display precision (design D2):
 * - `cents`: Overview, Costs and breakdown spend, Agents spend, Limits amounts;
 * - `four`: a request's served, attempt and total cost, workload spend, a batch job's
 *   settled cost, an estimate-priced portion;
 * - `adaptive`: the cascade savings line only (cents from $0.01, four decimals below).
 * Unit prices keep `fmtUsd`'s six significant digits and reserved ceilings use
 * `ceilingMoney`. */
export type MoneyPrecision = 'cents' | 'four' | 'adaptive';

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** A positive amount at a fixed number of places, rounded half up on whole units (integer
 * arithmetic, so `$1.005` cannot read `$1.00` through a binary-float `toFixed`). */
function fixed(micros: number, places: 2 | 4): string {
  const step = places === 2 ? 10_000 : 100;
  const scale = places === 2 ? 100 : 10_000;
  const units = Math.round(micros / step);
  return `$${String(Math.floor(units / scale))}.${pad(units % scale, places)}`;
}

/** Formats an amount in micro-dollars at a slot's declared precision.
 *
 * A positive amount below the precision reads `<` plus one unit of it, with no space
 * (`<$0.01`, `<$0.0001`): a non-zero amount never prints as zero. An exact zero is a
 * measured zero (`$0.00`, `$0.0000`). The amount may be fractional (a Limits threshold is
 * entered in dollars and can sit below one micro-dollar), so it is never rounded to whole
 * micro-dollars before the below-precision test.
 *
 * A negative amount formats its magnitude after a leading `-` (`-$1.50`). A negative amount
 * whose magnitude is below the precision reads `>-` plus one unit (`>-$0.01`, `>-$0.0001`):
 * -$0.004 is greater than -$0.01, so `-<$0.01` would state the wrong bound. No figure slot
 * passes a negative today (signed callers such as the savings line format the magnitude and
 * say the sign in words). */
export function money(micros: number, precision: MoneyPrecision): string {
  if (!Number.isFinite(micros)) return UNKNOWN;
  if (micros < 0) {
    const magnitude = money(-micros, precision);
    return magnitude.startsWith('<') ? `>-${magnitude.slice(1)}` : `-${magnitude}`;
  }
  if (micros === 0) return precision === 'four' ? '$0.0000' : '$0.00';
  switch (precision) {
    case 'cents':
      return micros < 10_000 ? '<$0.01' : fixed(micros, 2);
    case 'four':
      return micros < 100 ? '<$0.0001' : fixed(micros, 4);
    case 'adaptive':
      if (micros >= 10_000) return fixed(micros, 2);
      return micros >= 100 ? fixed(micros, 4) : '<$0.0001';
  }
}

/** A reserved ceiling at cents, rounded UP (design D2): a ceiling is a bound, so rounding
 * it down would understate it. `3,004,000` µ$ reads `$3.01`, and any positive ceiling below
 * a cent reads `$0.01`. The caller adds the `≤`. */
export function ceilingMoney(micros: number): string {
  if (!Number.isFinite(micros)) return UNKNOWN;
  if (micros <= 0) return '$0.00';
  const cents = Math.ceil(micros / 10_000);
  return `$${String(Math.floor(cents / 100))}.${pad(cents % 100, 2)}`;
}

/** An analytics dollar figure back in micro-dollars. The summary, breakdown and agent
 * figures are whole micro-dollars divided by 1e6 on the server, so rounding to the nearest
 * whole micro-dollar recovers the recorded sum exactly and drops the division's binary-float
 * error (which would otherwise round `$1.005` down). Never for an amount a user typed in
 * dollars, such as a Limits threshold, which can sit below one micro-dollar. */
export function microsOfUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/* ---- aggregate disclosures (design D3, D11) --------------------------------------- */

/** A partly priced aggregate's qualifier, `· 4 unpriced`, in Ink 3, from the count of
 * unpriced components its aggregation reports. No parts at zero: a fully priced sum carries
 * no qualifier. It follows the figure outside the Display role, so the Display figure's text
 * stays the amount alone. */
export function unpricedCountParts(count: number): readonly FigurePart[] {
  return count > 0 ? [toned(`· ${String(count)} ${UNPRICED}`, 'ink3')] : [];
}

/** An aggregate's estimated-usage disclosure, `12 requests with estimated usage`, or null at
 * zero, when no caption is shown. Never `~`. */
export function estimatedUsageText(count: number): string | null {
  if (count <= 0) return null;
  return `${String(count)} ${count === 1 ? 'request' : 'requests'} with estimated usage`;
}

/** An aggregate's estimate-priced disclosure, `includes $0.0042 estimate-priced`, at four
 * decimals (design D2), or null when the aggregation reports none. */
export function estimatePricedText(micros: number): string | null {
  return micros > 0 ? `includes ${money(micros, 'four')} estimate-priced` : null;
}

/* ---- a request's cost state (design D4) ------------------------------------------ */

/** The row fields a request's cost state reads. */
export type CostStateRow = Pick<
  RequestRow,
  | 'billed'
  | 'attemptCostMicros'
  | 'cost'
  | 'inputPriceSnapshot'
  | 'outputPriceSnapshot'
  | 'priceEstimated'
>;

/** What a request's cost reads as. `free` and `amount` carry `priceEstimated`, so a zero
 * price taken from `listed` or `native_family` still reads as an estimate. */
export type RequestCostState =
  | { readonly kind: 'not-billed' }
  | { readonly kind: 'unpriced' }
  | { readonly kind: 'free'; readonly priceEstimated: boolean }
  | {
      readonly kind: 'amount';
      readonly micros: number;
      readonly text: string;
      readonly priceEstimated: boolean;
    };

/** Resolves a request's cost state, in this order:
 * 1. `not-billed`: `billed === false` and no attempt-ledger cost. A cascade whose
 *    superseded cheap call cost real money keeps its normal total.
 * 2. `unpriced`: the served cost is null, whatever the attempt cost. A single request's
 *    total is not an aggregate, so it is never a priced sum with a `· 1 unpriced` qualifier.
 * 3. `free`: a zero cost, zero input and output price snapshots, and no attempt cost.
 * 4. `amount`: everything else, at four decimals. A zero cost with non-zero prices (no
 *    tokens consumed) is a measured `$0.0000`, and a legacy row with null snapshots cannot
 *    prove its model was free, so it reads the same.
 *
 * The table's cost cell and the inspector's total both render this, so they cannot drift. */
export function requestCostState(row: CostStateRow): RequestCostState {
  if (row.billed === false && row.attemptCostMicros === 0) return { kind: 'not-billed' };
  if (row.cost === null) return { kind: 'unpriced' };
  if (
    row.cost === 0 &&
    row.inputPriceSnapshot === 0 &&
    row.outputPriceSnapshot === 0 &&
    row.attemptCostMicros === 0
  ) {
    return { kind: 'free', priceEstimated: row.priceEstimated };
  }
  const micros = totalCostMicros(row);
  return {
    kind: 'amount',
    micros,
    text: money(micros, 'four'),
    priceEstimated: row.priceEstimated,
  };
}

/** A cost state's parts: `$0 · not billed` in Ink 2 throughout, `unpriced` in Ink 3,
 * `$0 free` with only `free` green, and an amount in the slot's ink, each followed by an
 * Ink 3 `· est.` when its price was estimated. `$0 · not billed` never carries `· est.`. */
export function costParts(state: RequestCostState): readonly FigurePart[] {
  switch (state.kind) {
    case 'not-billed':
      return NOT_BILLED_HALVES.map((t) => toned(t, 'ink2'));
    case 'unpriced':
      return [toned(UNPRICED, 'ink3')];
    case 'free':
      return priceLabelParts({ kind: 'free', estimated: state.priceEstimated });
    case 'amount':
      return withEstimate([toned(state.text, 'slot')], state.priceEstimated);
  }
}

/** A cost state's string form (`partsText` of its parts). */
export function costText(state: RequestCostState): string {
  return partsText(costParts(state));
}

/** Whether a recorded price source is an estimate: the adjacent native channel or the
 * provider's own listed price (add-native-price-fallback, record-listed-price-fallback). */
export function isEstimateSource(source: string | null): boolean {
  return source === 'native_family' || source === 'listed';
}

/* ---- price labels ---------------------------------------------------------------- */

/** A price label: a unit price, the chain editor's and picker's model price, a Providers
 * price line. `priced` carries its already-formatted text (`$0.1 / 1M`). */
export type PriceLabel =
  | { readonly kind: 'unpriced' }
  | { readonly kind: 'free'; readonly estimated: boolean }
  | { readonly kind: 'priced'; readonly text: string; readonly estimated: boolean };

/** A price label's parts: `unpriced` in Ink 3, or `$0 free` (only `free` green) or the
 * priced text in the slot's ink, followed by an Ink 3 `· est.` when the price was
 * estimated. `free` is never a whole label on its own. */
export function priceLabelParts(label: PriceLabel): readonly FigurePart[] {
  switch (label.kind) {
    case 'unpriced':
      return [toned(UNPRICED, 'ink3')];
    case 'free':
      return withEstimate([toned(FREE_AMOUNT, 'slot'), toned(FREE_WORD, 'green')], label.estimated);
    case 'priced':
      return withEstimate([toned(label.text, 'slot')], label.estimated);
  }
}

/** A price label's string form, for plain-text sinks such as a native `<option>`. */
export function priceLabelText(label: PriceLabel): string {
  return partsText(priceLabelParts(label));
}

/* ---- shares, durations and token counts (design D5, D8) --------------------------- */

/** A part of a whole as a percentage, at the precision the surface's own requirement pins
 * (whole percent unless `decimals` says otherwise). A zero denominator reads
 * `not applicable`, never `0%`, `NaN%` or a dash. */
export function share(part: number, whole: number, decimals = 0): string {
  const ratio = part / whole;
  if (whole === 0 || !Number.isFinite(ratio)) return NOT_APPLICABLE;
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** A request's latency: whole milliseconds below one second (`412ms`), seconds to two
 * decimals below one minute (`1.24s`), then minutes and zero-padded seconds (`2m 05s`).
 * It rounds first and picks the unit after, so 999.6ms reads `1.00s` and 59,996ms reads
 * `1m 00s`, never `1000ms` or `60.00s`. A batch item keeps `fmtElapsed`'s wall time. */
export function fmtLatency(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const whole = Math.round(v);
  if (whole < 1000) return `${String(whole)}ms`;
  const centis = Math.round(v / 10);
  if (centis < 6000) return `${String(Math.floor(centis / 100))}.${pad(centis % 100, 2)}s`;
  const secs = Math.round(v / 1000);
  return `${String(Math.floor(secs / 60))}m ${pad(secs % 60, 2)}s`;
}

function compact(tenths: number, unit: 'k' | 'M' | 'B'): string {
  const rest = tenths % 10;
  return `${String(Math.floor(tenths / 10))}${rest === 0 ? '' : `.${String(rest)}`}${unit}`;
}

/** A token count in a list or readout: exact below 1,000, then `k`, `M` and `B` to one
 * decimal with a trailing `.0` dropped (`12.4k`, `1.2M`, `3.1B`). The unit is chosen after
 * rounding, so 999,950 reads `1M`, never `1000k`. `B` is the largest unit and is uncapped.
 * The inspector shows exact counts instead. */
export function fmtTokensCompact(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  if (v < 1000) return String(v);
  const k = Math.round(v / 100);
  if (k < 10_000) return compact(k, 'k');
  const m = Math.round(v / 100_000);
  if (m < 10_000) return compact(m, 'M');
  return compact(Math.round(v / 100_000_000), 'B');
}
