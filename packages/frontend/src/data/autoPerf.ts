import type { AutoLayers, AutoPerformance } from './api';
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
  /** Workload mix (add-workload-telemetry D7) — null = the block's EMPTY state
   * (no classified parents AND no classes); attempt-only classes are NOT empty
   * (`attemptOnly`, rendered with zero share + spend + a note). Headed as
   * "workload-classified auto requests" — never "all traffic". */
  workload: {
    evaluated: number;
    /** Rows in the aggregation's order (requests desc, then slug). */
    rows: {
      class: string;
      /** `none` reads as plain language. */
      label: string;
      requests: number;
      /** Share of evaluated (0% when attempt-only). */
      sharePct: string;
      /** Formatted dollars; null = no costable component → a dash + "unpriced". */
      spend: string | null;
      /** "n unpriced" (parent + attempt components), or null when fully priced. */
      unpricedNote: string | null;
    }[];
    /** evaluated === 0 but attempt-derived classes exist. */
    attemptOnly: boolean;
    /** "n of n+m structurally evaluated auto requests carry workload telemetry" or null. */
    coverage: string | null;
    /** "request figures span N classifier revisions" or null. */
    revisionNote: string | null;
  } | null;
  /** When `workload` is null: keyed on the WORKLOAD-specific `since` (never the
   * structural telemetrySince). */
  workloadZero: 'preCapture' | 'empty';
  workloadSince: string | null;
  /** Signal quality (add-auto-signal-honesty). Two INDEPENDENT parts — a
   * flagged list and a coverage disclosure — so a flag never hides that
   * other agents are unassessed; `show` is false only when BOTH are empty
   * (all assessed healthy → no section, no empty scaffolding). */
  signalQuality: {
    show: boolean;
    flagged: {
      label: string;
      /** "score 0.45 · 85% of 272 ambiguous requests" */
      detail: string;
      distinctScores: number;
    }[];
    /** "3 of 5 agents have enough evaluated traffic to assess", or null
     * when every agent met the floor. */
    coverage: string | null;
  };
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
    signalQuality: toSignalQualityVm(data.signalQuality ?? []),
    workload: toWorkloadVm(data.workloadMix ?? EMPTY_WORKLOAD_MIX),
    workloadZero: (data.workloadMix ?? EMPTY_WORKLOAD_MIX).since !== null ? 'preCapture' : 'empty',
    workloadSince: (data.workloadMix ?? EMPTY_WORKLOAD_MIX).since,
  };
}

const EMPTY_WORKLOAD_MIX: AutoPerformance['workloadMix'] = {
  evaluated: 0,
  unclassified: 0,
  since: null,
  revisions: [],
  classes: [],
};

/** Pure workload-mix view derivation (add-workload-telemetry D7). Exported for
 * tests. EMPTY (null) ONLY when there are no classified parents AND no classes
 * — attempt-only classes render. Spend honesty: null → dash + "unpriced", a
 * numeric 0 → "$0" with no qualifier, any unpriced parent OR attempt component
 * → "n unpriced". Coverage names STRUCTURALLY evaluated requests (legacy rows
 * were never workload-evaluated); the revision note scopes itself to request
 * figures (attempt spend may come from out-of-range parents). */
export function toWorkloadVm(wm: AutoPerformance['workloadMix']): AutoPerfVm['workload'] {
  if (wm.evaluated === 0 && wm.classes.length === 0) return null;
  return {
    evaluated: wm.evaluated,
    rows: wm.classes.map((c) => {
      const unpriced = c.unpricedRequests + c.unpricedAttempts;
      return {
        class: c.class,
        label: c.class === 'none' ? 'no specialist workload' : c.class,
        requests: c.requests,
        sharePct: pct(c.requests, wm.evaluated),
        spend: c.spendUsd === null ? null : fmtMicros(Math.round(c.spendUsd * 1_000_000)),
        unpricedNote: unpriced > 0 ? `${String(unpriced)} unpriced` : null,
      };
    }),
    attemptOnly: wm.evaluated === 0,
    coverage:
      wm.unclassified > 0
        ? `${String(wm.evaluated)} of ${String(wm.evaluated + wm.unclassified)} structurally evaluated auto requests carry workload telemetry`
        : null,
    revisionNote:
      wm.revisions.length > 1
        ? `request figures span ${String(wm.revisions.length)} classifier revisions`
        : null,
  };
}

/** Pure signal-quality view derivation (add-auto-signal-honesty): flagged
 * rows + the below-floor coverage line are INDEPENDENT (a flag never hides
 * unassessed agents); both empty → section hidden. Exported for tests. */
export function toSignalQualityVm(
  list: AutoPerformance['signalQuality'],
): AutoPerfVm['signalQuality'] {
  const flagged = list
    .filter((a) => a.collapsed === true)
    .map((a) => ({
      label: a.label ?? '(no agent)',
      detail: `score ${a.modalScore === null ? '—' : a.modalScore.toFixed(2)} · ${
        a.modalShare === null ? '—' : `${(a.modalShare * 100).toFixed(0)}%`
      } of ${String(a.ambiguousRows)} ambiguous requests`,
      distinctScores: a.distinctScores,
    }));
  const assessed = list.filter((a) => a.collapsed !== null).length;
  const coverage =
    list.length > 0 && assessed < list.length
      ? `${String(assessed)} of ${String(list.length)} agents have enough evaluated traffic to assess`
      : null;
  return { show: flagged.length > 0 || coverage !== null, flagged, coverage };
}

/** The availability-aware guidance line for a flagged agent
 * (add-auto-signal-honesty). TRUTHFUL under every state (codex r1-High-3):
 * with semantic unavailable it names the whole configuration surface —
 * never asserting WHICH piece is missing (capability = layer token + model
 * path + a ready classifier); with L2 active it claims evaluation, never
 * success. A null `layers` (not yet loaded) uses the unavailable variant —
 * the only one that recommends nothing the instance might lack. */
export function signalQualityGuidance(layers: AutoLayers | null): string {
  const pin = 'Pin it to a tier';
  if (layers === null || !layers.semanticAvailable) {
    return `L1 sees near-constant structure in this agent's ambiguous traffic. ${pin}, or configure the semantic layer (ROUTING_AUTO_LAYERS + SEMANTIC_MODEL_PATH, and a valid model bundle) to let L2 read content.`;
  }
  if (!layers.semantic) {
    return `L1 sees near-constant structure in this agent's ambiguous traffic. ${pin}, or enable L2 · Semantic — it evaluates exactly this ambiguous slice.`;
  }
  return `L1 sees near-constant structure in this agent's ambiguous traffic; L2 · Semantic evaluates it. ${pin} if you'd rather route it explicitly.`;
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
