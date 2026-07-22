import type { AutoPerformance } from './api';
import { fmtMicros } from './api';

/** View-model for the Routing page's AUTO PERFORMANCE section
 * (add-auto-performance-view). Pure — every display rule unit-testable. */
export interface AutoPerfVm {
  evaluated: number;
  /** Shares of evaluated requests (0–100, one decimal). */
  ambiguousPct: string;
  declaredPct: string;
  /** The DISJOINT cascade outcome rates — shares of cascade.requests. */
  passedPct: string;
  escalatedPct: string;
  unknownPct: string;
  failedPct: string;
  cascadeRequests: number;
  /** True when L2 actually routed traffic (routed > 0): every cascade-derived
   * figure is then RESIDUAL-only, since semantically-routed requests never
   * cascade (add-semantic-dashboard D4). Drives the denominator footnote. */
  cascadeIsResidual: boolean;
  /** The L2 semantic slice — null when nothing was evaluated (legacy/never-run
   * rows show the section's honest empty affordance, never fabricated zeros). */
  semantic: {
    evaluated: number;
    routedHigh: number;
    routedLow: number;
    routed: number;
    /** DISJOINT + EXHAUSTIVE outcome shares of the routed total (sum to 100%). */
    successPct: string;
    fallbackPct: string;
    errorPct: string;
    cancelledPct: string;
    /** Source shares of evaluated rows — provenance, NOT effectiveness. */
    bundled: number;
    learned: number;
    bundledPct: string;
    learnedPct: string;
  } | null;
  /** Total unroutable rows (confident bands with no target). */
  unroutable: number;
  savings: {
    /** Null when the endpoint reports unknown money (zero costable rows). */
    net: string | null;
    negative: boolean;
    excess: string | null;
    basisLabel: string;
    /** "based on N of M quality-passed requests" — the coverage contract. */
    coverage: string;
    incomplete: boolean;
    /** All eligible rows uncostable — show coverage, no money. */
    moneyless: boolean;
  } | null;
  /** Which zero state to render when evaluated === 0. */
  zeroState: 'none' | 'preCapture' | 'empty';
  telemetrySince: string | null;
}

const pct = (part: number, whole: number): string =>
  whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(0)}%`;

export function toAutoPerfVm(data: AutoPerformance | null): AutoPerfVm | null {
  if (data === null) return null;
  const c = data.cascade;
  const declared = data.bands.high.declared + data.bands.low.declared;
  const s = data.savings;
  const eligible = s === null ? 0 : s.rows + s.uncostedRows;
  const sem = data.semantic;
  const semRouted = sem.routed.high + sem.routed.low;
  return {
    evaluated: data.evaluated,
    ambiguousPct: pct(data.bands.ambiguous.requests, data.evaluated),
    declaredPct: pct(declared, data.evaluated),
    passedPct: pct(c.qualityPassed, c.requests),
    escalatedPct: pct(c.escalated, c.requests),
    unknownPct: pct(c.qualityUnknown, c.requests),
    failedPct: pct(c.failedOrCancelled, c.requests),
    cascadeRequests: c.requests,
    cascadeIsResidual: semRouted > 0,
    semantic:
      sem.evaluated === 0
        ? null
        : {
            evaluated: sem.evaluated,
            routedHigh: sem.routed.high,
            routedLow: sem.routed.low,
            routed: semRouted,
            successPct: pct(sem.outcomes.success, semRouted),
            fallbackPct: pct(sem.outcomes.fallback, semRouted),
            errorPct: pct(sem.outcomes.error, semRouted),
            cancelledPct: pct(sem.outcomes.cancelled, semRouted),
            bundled: sem.source.bundled,
            learned: sem.source.learned,
            bundledPct: pct(sem.source.bundled, sem.evaluated),
            learnedPct: pct(sem.source.learned, sem.evaluated),
          },
    unroutable: data.bands.high.unroutable + data.bands.low.unroutable,
    savings:
      s === null
        ? null
        : {
            net: s.netUsd === null ? null : fmtMicros(Math.round(Math.abs(s.netUsd) * 1_000_000)),
            negative: s.netUsd !== null && s.netUsd < 0,
            excess: s.excessUsd === null ? null : fmtMicros(Math.round(s.excessUsd * 1_000_000)),
            basisLabel: s.basis.label,
            coverage: `based on ${String(s.rows)} of ${String(eligible)} quality-passed requests`,
            incomplete: s.uncostedRows > 0,
            moneyless: s.rows === 0,
          },
    zeroState: data.evaluated > 0 ? 'none' : data.telemetrySince !== null ? 'preCapture' : 'empty',
    telemetrySince: data.telemetrySince,
  };
}

/** Chart arrays: epoch-second buckets zero-filled at the bucket interval
 * (A-31 — idle spans dip to the baseline, never interpolate). */
export function autoSeriesToChart(
  series: AutoPerformance['series'],
  bucketSecs: number,
): [number[], number[], number[], number[]] {
  if (series.length === 0) return [[], [], [], []];
  const bySec = new Map(series.map((p) => [Math.floor(Date.parse(p.bucket) / 1000), p]));
  const secs = [...bySec.keys()].sort((a, b) => a - b);
  const xs: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const ambiguous: number[] = [];
  for (let t = secs[0]!; t <= secs[secs.length - 1]!; t += bucketSecs) {
    const p = bySec.get(t);
    xs.push(t);
    high.push(p?.high ?? 0);
    low.push(p?.low ?? 0);
    ambiguous.push(p?.ambiguous ?? 0);
  }
  return [xs, high, low, ambiguous];
}
