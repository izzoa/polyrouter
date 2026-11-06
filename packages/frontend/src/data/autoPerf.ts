import { STRUCTURAL_WORKLOAD_CLASSES, WORKLOAD_CLASSES } from '@polyrouter/shared';
import type { AutoLayers, AutoPerformance } from './api';
import { microsOfUsd, money, share, UNKNOWN, wordParts, type FigurePart } from './figures';
import { WORKLOAD_ROW_ORDER } from './workloadTargets';

/** View-model for the Routing page's AUTO PERFORMANCE section
 * (add-auto-performance-view). Pure — every display rule unit-testable. */
export interface AutoPerfVm {
  evaluated: number;
  /** Shares of evaluated requests (whole percent), or `not applicable` when nothing was
   * evaluated (adopt-figure-states D5): a share of nothing is never `0%`. */
  ambiguousPct: string;
  declaredPct: string;
  /** The DISJOINT cascade outcome rates — shares of cascade.requests, `not applicable`
   * when the range holds no cascade requests. */
  passedPct: string;
  escalatedPct: string;
  unknownPct: string;
  failedPct: string;
  cascadeRequests: number;
  /** True when L2 OR the workload stage actually routed traffic: every
   * cascade-derived figure is then RESIDUAL-only, since semantically- and
   * workload-routed requests never cascade (add-semantic-dashboard D4,
   * add-workload-routing). Drives the denominator footnote. */
  cascadeIsResidual: boolean;
  /** Which pre-emptive layers make the cascade residual (footnote wording). */
  residualCauses: { semantic: boolean; workload: boolean };
  /** Requests the WORKLOAD stage served in range (add-workload-routing):
   * when > 0 the band figures include classified-but-claimed rows, and the
   * card discloses it. */
  workloadRouted: number;
  /** The L2 semantic slice — null when nothing was evaluated (legacy/never-run
   * rows show the section's honest empty affordance, never fabricated zeros). */
  semantic: {
    evaluated: number;
    routedHigh: number;
    routedLow: number;
    routed: number;
    /** DISJOINT + EXHAUSTIVE outcome shares of the routed total (sum to 100%);
     * `not applicable` when nothing was routed. */
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
    /** add-workload-scoped-bands: class-scoped band rules exist — the basis is the
     * generic strong target and does not separate class-scoped traffic. */
    basisScoped: boolean;
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
      /** Share of evaluated (a zero share when attempt-only: the workload-mix contract pins
       * it, so it is not `not applicable`; adopt-figure-states notes/flags.md F3). */
      sharePct: string;
      /** Formatted dollars at four decimals; null = no costable component → the bare word
       * `unpriced`, with no dash. */
      spend: string | null;
      /** "n unpriced" (parent + attempt components), or null when fully priced. */
      unpricedNote: string | null;
      /** How many of `requests` the workload stage ROUTED (add-workload-routing);
       * `none` is never routed. */
      routed: number;
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
      /** `detail` as figure parts: an `unknown` score or share is Ink 3, never the amber of
       * the flagged line it sits in (adopt-figure-states D1). */
      detailParts: readonly FigurePart[];
      distinctScores: number;
    }[];
    /** "3 of 5 agents have enough evaluated traffic to assess", or null
     * when every agent met the floor. */
    coverage: string | null;
  };
}

/** A savings amount (split-auto-routing-readout-setup D6) at the savings line's adaptive
 * precision, from an API dollar figure's MAGNITUDE — the sign travels separately, so a
 * negative net is never clamped. Cents from $0.01 up, four decimals from $0.0001, and
 * `<$0.0001` below that, with no space (adopt-figure-states D2): a non-zero amount is
 * never printed as zero. */
const savingsMoney = (usd: number): string => money(Math.abs(microsOfUsd(usd)), 'adaptive');

export function toAutoPerfVm(data: AutoPerformance | null): AutoPerfVm | null {
  if (data === null) return null;
  const c = data.cascade;
  const declared = data.bands.high.declared + data.bands.low.declared;
  const s = data.savings;
  const eligible = s === null ? 0 : s.rows + s.uncostedRows;
  const sem = data.semantic;
  const semRouted = sem.routed.high + sem.routed.low;
  const wlRouted = (data.workloadMix ?? EMPTY_WORKLOAD_MIX).classes.reduce(
    (a, c) => a + (c.routed ?? 0),
    0,
  );
  return {
    evaluated: data.evaluated,
    ambiguousPct: share(data.bands.ambiguous.requests, data.evaluated),
    declaredPct: share(declared, data.evaluated),
    passedPct: share(c.qualityPassed, c.requests),
    escalatedPct: share(c.escalated, c.requests),
    unknownPct: share(c.qualityUnknown, c.requests),
    failedPct: share(c.failedOrCancelled, c.requests),
    cascadeRequests: c.requests,
    cascadeIsResidual: semRouted > 0 || wlRouted > 0,
    residualCauses: { semantic: semRouted > 0, workload: wlRouted > 0 },
    workloadRouted: wlRouted,
    semantic:
      sem.evaluated === 0
        ? null
        : {
            evaluated: sem.evaluated,
            routedHigh: sem.routed.high,
            routedLow: sem.routed.low,
            routed: semRouted,
            successPct: share(sem.outcomes.success, semRouted),
            fallbackPct: share(sem.outcomes.fallback, semRouted),
            errorPct: share(sem.outcomes.error, semRouted),
            cancelledPct: share(sem.outcomes.cancelled, semRouted),
            bundled: sem.source.bundled,
            learned: sem.source.learned,
            bundledPct: share(sem.source.bundled, sem.evaluated),
            learnedPct: share(sem.source.learned, sem.evaluated),
          },
    unroutable: data.bands.high.unroutable + data.bands.low.unroutable,
    savings:
      s === null
        ? null
        : {
            // Cents from $0.01, four decimals below, `<$0.0001` for a non-zero speck — a
            // magnitude, the sign rides `negative`, so a negative net is never clamped away.
            net: s.netUsd === null ? null : savingsMoney(s.netUsd),
            negative: s.netUsd !== null && s.netUsd < 0,
            excess: s.excessUsd === null ? null : savingsMoney(s.excessUsd),
            basisLabel: s.basis.label,
            basisScoped: s.basis.scoped === true,
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
 * — attempt-only classes render. Spend honesty: null → the bare word `unpriced`
 * (no dash), a numeric 0 → a `$0.0000` figure with no qualifier, any unpriced parent
 * OR attempt component → "n unpriced". Spend is at four decimals (adopt-figure-states
 * D2). Coverage names STRUCTURALLY evaluated requests (legacy rows were never
 * workload-evaluated); the revision note scopes itself to request figures (attempt
 * spend may come from out-of-range parents). */
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
        // An attempt-only block (nothing evaluated) keeps the zero share its contract pins
        // ("Attempt-only classes are not an empty state"); see notes/flags.md F3.
        sharePct: wm.evaluated === 0 ? '0%' : share(c.requests, wm.evaluated),
        spend: c.spendUsd === null ? null : money(microsOfUsd(c.spendUsd), 'four'),
        unpricedNote: unpriced > 0 ? `${String(unpriced)} unpriced` : null,
        routed: c.routed ?? 0,
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

/** The detectable classes with NO row in the loaded workload mix
 * (split-auto-routing-readout-setup D10), in the matrix's row order — so an absent class
 * reads as "no detections in this range", the guarantee the matrix's Detected column used
 * to carry. Structural classes are always detectable; `research` and `writing` only while
 * the semantic workload source is effective. A class present only through attempt spend
 * HAS a row, so it is never named. `none` is not a class to detect. */
export function undetectedClasses(
  rows: readonly { class: string }[],
  semanticWorkload: boolean,
): string[] {
  const present = new Set(rows.map((r) => r.class));
  return WORKLOAD_ROW_ORDER.filter(
    (c) => (semanticWorkload || !SEMANTIC_ONLY.has(c)) && !present.has(c),
  );
}

const SEMANTIC_ONLY: ReadonlySet<string> = new Set(
  WORKLOAD_CLASSES.filter((c) => !(STRUCTURAL_WORKLOAD_CLASSES as readonly string[]).includes(c)),
);

/** Pure signal-quality view derivation (add-auto-signal-honesty): flagged
 * rows + the below-floor coverage line are INDEPENDENT (a flag never hides
 * unassessed agents); both empty → section hidden. A null modal score or share
 * reads `unknown`, never a dash (adopt-figure-states D5). Exported for tests. */
export function toSignalQualityVm(
  list: AutoPerformance['signalQuality'],
): AutoPerfVm['signalQuality'] {
  const flagged = list
    .filter((a) => a.collapsed === true)
    .map((a) => {
      const detail = `score ${a.modalScore === null ? UNKNOWN : a.modalScore.toFixed(2)} · ${
        a.modalShare === null ? UNKNOWN : `${(a.modalShare * 100).toFixed(0)}%`
      } of ${String(a.ambiguousRows)} ambiguous requests`;
      return {
        label: a.label ?? '(no agent)',
        detail,
        detailParts: wordParts(detail),
        distinctScores: a.distinctScores,
      };
    });
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
