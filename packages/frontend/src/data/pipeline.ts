import type { AutoLayers, AutoPerformance, RuleDto } from './api';
import {
  layerSwitchState,
  structuralLayers,
  type LayerRow,
  type LayerSwitchState,
} from './autoLayerHints';
import { toAutoPerfVm, type AutoPerfVm } from './autoPerf';
import {
  bandVms,
  scopedBandVms,
  type ScopedBandVm,
  type ScopedBandsVm,
  type TargetCatalog,
} from './bandTargets';
import { toCalibrationVm } from './calibration';
import { share } from './figures';
import { targetLabel } from './targetsMatrix';
import { workloadVms } from './workloadTargets';
import type { Range } from '../types';

/** View-model for the Auto routing tab's PIPELINE (redesign-auto-routing-pipeline
 * D7; split-auto-routing-readout-setup D1): the six stages in the order the proxy runs
 * them, each one's status now, routed-here figure and proportional bar. Pure — the arithmetic (shares,
 * the zero and absent-`exits` cases, the Default reconciliation) is owned by the
 * unit tests, not the view.
 *
 * Two rules shape every output:
 * - configuration (status-now phrases, switch states) renders from routing state alone and
 *   never waits on the aggregation;
 * - no measured figure is fabricated, stale-as-current, or `NaN`: a set `error`
 *   emits none at all, even though the store keeps the last data on a failure. */

export type StageId = 'classify' | 'workload' | 'band' | 'semantic' | 'cascade' | 'default';

/** The keys of the aggregation's `exits` block — one per stage after Classify. */
export type ExitKey = 'workload' | 'structural' | 'semantic' | 'cascade' | 'default';

/** Which designed state the measured figures are in.
 * - `absent` — the structural capability is off instance-wide: no figure renders;
 * - `error` — the load failed: a notice and Retry, and no per-stage figure at all, from
 *   this load or an earlier one;
 * - `loading` — no data for the selected range yet: placeholders;
 * - `zero` — no evaluated rows in the range: zero counts, `not applicable` shares, no bar;
 * - `unavailable` — loaded, but the server sent no `exits` (an older server): stages 2–6
 *   render no per-stage figure (never a zero, never a lone dash) and the panel's notice
 *   says the counts are unavailable, while every other figure renders;
 * - `ready` — every figure renders. */
export type MeasuredState = 'absent' | 'error' | 'loading' | 'zero' | 'unavailable' | 'ready';

/** A stage row's routed-here figure. */
export type StageFigure =
  /** `share` is of evaluated — `not applicable` when nothing was evaluated, never `NaN%`
   * or a dash; null on Classify, whose count IS the evaluated total. */
  | { kind: 'count'; count: number; share: string | null }
  | { kind: 'placeholder' }
  /** The row carries no figure slot at all, visible or hidden: the capability is absent,
   * the load failed, or the server sent no stage breakdown. The panel-level notice names
   * the state (adopt-figure-states D5), so no stage draws a lone dash for it. */
  | { kind: 'none' };

/** Why a stage is not running, stated in text — never as a dimming style.
 * `paused`: Layer 1 is off, so stages 2–5 get no verdicts. `off`: the stage's own
 * layer is off; `caution` only for Layer 1 (it pauses its dependants) — an opt-in
 * L2/L3 being off is a normal configuration and reads `neutral`. */
export type StageStatus =
  { kind: 'paused'; label: string } | { kind: 'off'; tone: 'caution' | 'neutral' };

export interface StageRowVm {
  id: StageId;
  number: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  /** The layer name on stages 1, 4 and 5 (`L1 · Structural` …); null elsewhere. */
  layer: string | null;
  /** The mono sub-label: the layer's tag, or the rule kinds the stage reads. */
  tag: string;
  /** The layer's switch row (stages 1, 4 and 5 only): its `id` drives the toggle,
   * its `name` the accessible label (`Toggle L1 · Structural`). */
  layerRow: LayerRow | null;
  /** What the switch presents — loading wins, so a switch never reads as "off
   * instance-wide" before the auto-layers view arrives. Null without a switch. */
  switchState: LayerSwitchState | null;
  /** Every stage except Confident band opens a detail (five expanders). */
  expandable: boolean;
  /** Confident band has no detail: it points at the Targets matrix's Strong and
   * Cheap columns instead. */
  targetsLink: boolean;
  /** The exit this row counts; null on Classify (it shows `evaluated`). */
  exit: ExitKey | null;
  figure: StageFigure;
  status: StageStatus | null;
  /** STATUS NOW (split-auto-routing-readout-setup D3): what the stage does under the
   * CURRENT configuration, from routing state alone — never a measured figure, and
   * identical whether the aggregation is loading, failed or ready. */
  statusNow: StatusNowVm;
  /** The words beside the row's count — `evaluated` / `routed here`, or a HISTORY
   * caption when the stage is not running now, so a count from when it ran never
   * contradicts its status. Null while the auto-layers view loads (stages 1–5). */
  caption: string | null;
  /** Classify only: the band verdict counts and the workload-claim line, under the
   * figures' designed states. Null on every other stage. */
  verdicts: VerdictsVm | null;
  /** The row's proportional bar (stages 2–6): a placeholder while loading, a track
   * whose fill is the exit's share of evaluated — an EMPTY track for a zero exit —
   * and null where no bar is drawn (Classify, the zero range, no `exits`, a failure,
   * the capability absent). */
  bar: StageBarVm | null;
}

export type StageBarVm = { kind: 'placeholder' } | { kind: 'track'; ratio: number };

/** The Confident band row's unroutable alert (D5): confident verdicts that went to
 * Default for want of a usable target. The count is not scope-aware, so the copy and
 * the controls name the COLUMN, never the Any request target, as the cause. */
export interface BandAlertVm {
  text: string;
  /** One control per affected band, Strong first. */
  columns: ('strong' | 'cheap')[];
}

export type StatusTone = 'neutral' | 'caution';

export interface StatusLine {
  text: string;
  tone: StatusTone;
}

export interface StatusNowVm {
  /** The auto-layers view has not loaded: the phrase shows a loading state, never
   * "unavailable" or "off". Default (stage 6) never loads. */
  loading: boolean;
  /** The first line in words — also what a text-only reader gets. */
  text: string;
  tone: StatusTone;
  /** "X to Y" pairs the view draws with an arrow icon (no bundled font carries the
   * arrow); `text` holds the same line in words. Null for prose. */
  routes: SetupRoute[] | null;
  /** Later lines, each with its own tone (the unverified notice is one). */
  lines: StatusLine[];
}

export type VerdictsVm =
  | { kind: 'placeholder' }
  | { kind: 'none' }
  | {
      kind: 'value';
      /** `verdicts: 3 high · 1 low · 2 ambiguous` — worded as verdicts so they cannot
       * be read as thresholds. */
      text: string;
      /** How many of the evaluated requests a Workload claim served instead of a band
       * target; null when none did. */
      claimed: string | null;
    };

/** Which requests can cascade under the current targets (D3 "Cascade pair
 * resolution", after the proxy's cascade-within-a-class contract): each leg resolves
 * on its own — an unclaimed class's own rule for a band when one is set, even if it
 * is unusable (no fall-back), else the generic rule. */
export interface CascadePairs {
  /** Requests with no class of their own — and classes without scoped rules — have a
   * usable generic pair. */
  generic: boolean;
  /** Live, unclaimed classes carrying scoped rules whose resolved pair is usable. */
  classes: string[];
}

export interface CascadeClassInput {
  cls: string;
  /** The class is detected now (a reserved class only with the semantic source). */
  live: boolean;
  /** A usable, live claim takes the class first — it never reaches the cascade. */
  claimed: boolean;
  scoped: ScopedBandsVm;
}

export function cascadePairs(
  generic: { high: { usable: boolean }; low: { usable: boolean } },
  classes: CascadeClassInput[],
): CascadePairs {
  const leg = (own: ScopedBandVm, fallback: { usable: boolean }): boolean =>
    own.effective !== null ? own.usable : fallback.usable;
  return {
    generic: generic.high.usable && generic.low.usable,
    classes: classes
      .filter((c) => c.live && !c.claimed && c.scoped.anyScoped)
      .filter((c) => leg(c.scoped.high, generic.high) && leg(c.scoped.low, generic.low))
      .map((c) => c.cls),
  };
}

export interface SetupRoute {
  from: string;
  to: string;
}

/** The Default detail's figures (split-auto-routing-readout-setup D4). The routed-here
 * total is the Default ROW's count, so the detail does not repeat it; on proxy-written
 * rows that count = `unroutable.high + unroutable.low + fallthrough`, and `other` holds
 * any remainder. */
export interface DefaultDetailVm {
  /** Confident bands retained on default for want of a usable target. */
  unroutable: { high: number; low: number };
  /** Ambiguous requests no later stage took (`fallthrough` ⊆ `exits.default`). */
  fallthrough: number;
  /** Banded rows recorded at a layer the proxy never writes on the auto path (the
   * Default count minus the three above) — 0 on proxy-written rows; null when the server
   * sent no `exits` block, so the count is unknown. */
  other: number | null;
}

export interface PipelineInput {
  autoLayers: AutoLayers | null;
  autoPerf: { data: AutoPerformance | null; error: string | null; range: Range };
  catalog: TargetCatalog & { rules: RuleDto[] };
  /** A Targets column a write may have changed but whose re-list failed (the store's
   * `bt.unverified` / `wt.unverified`). While either is raised the rules snapshot may
   * be stale, so the stages reading it say so and draw no conclusion from it. */
  unverified?: { bands: boolean; claims: boolean };
}

export interface PipelineVm {
  measured: MeasuredState;
  /** The range every figure is framed to. */
  range: Range;
  stages: StageRowVm[];
  /** Null while loading, after a failure, and when the capability is absent. */
  defaultDetail: DefaultDetailVm | null;
  /** The auto-performance view-model behind the stage details and the focal
   * savings — gated exactly like the figures (null unless `zero`, `unavailable`
   * or `ready`), so a detail can never render a stale figure as current. */
  perf: AutoPerfVm | null;
  /** The cascade is not running now (Layer 1 or Layer 3 off, or no usable pair under
   * verified targets), so the savings line covers cascades EARLIER in the range. */
  cascadeHistory: boolean;
  /** Absent while loading, after a failure, and at zero — never a placeholder: an
   * alert that may not appear reserves no space. */
  bandAlert: BandAlertVm | null;
}

const PAUSED: StageStatus = { kind: 'paused', label: 'paused · needs L1' };

const NEEDS_L1 = 'Needs L1 — unavailable on this instance';
const UNAVAILABLE = 'Unavailable on this instance';
const UNVERIFIED_LINE: StatusLine = {
  text: 'Last loaded targets — routing may have changed; see Targets',
  tone: 'caution',
};
const STATUS_LOADING: StatusNowVm = {
  loading: true,
  text: 'Loading…',
  tone: 'neutral',
  routes: null,
  lines: [],
};

function statusNow(
  text: string,
  tone: StatusTone = 'neutral',
  lines: StatusLine[] = [],
  routes: SetupRoute[] | null = null,
): StatusNowVm {
  return { loading: false, text, tone, routes, lines };
}

const neutral = (text: string): StatusLine => ({ text, tone: 'neutral' });

/** `code`, `code and vision`, `code, vision and structured`. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** The words form of a routes setup line: `code: tier:premium · …`. */
function routesLine(routes: SetupRoute[]): string {
  return routes.map((r) => `${r.from}: ${r.to}`).join(' · ');
}

function measuredState(input: PipelineInput): MeasuredState {
  const { autoLayers, autoPerf } = input;
  if (autoLayers !== null && !autoLayers.structuralAvailable) return 'absent';
  if (autoPerf.error !== null) return 'error';
  if (autoPerf.data === null) return 'loading';
  if (autoPerf.data.evaluated === 0) return 'zero';
  if (autoPerf.data.exits === undefined) return 'unavailable';
  return 'ready';
}

/** One stage's figure. `exit` null = Classify, which counts `evaluated`. */
function figureFor(
  measured: MeasuredState,
  data: AutoPerformance | null,
  exit: ExitKey | null,
): StageFigure {
  switch (measured) {
    case 'absent':
    case 'error':
      return { kind: 'none' };
    case 'loading':
      return { kind: 'placeholder' };
    case 'zero':
      // The exits partition `evaluated`, so with nothing evaluated every exit
      // is a true 0 — whether or not the server sent the block. Its share of
      // nothing is `not applicable`.
      return { kind: 'count', count: 0, share: exit === null ? null : share(0, 0) };
    case 'unavailable':
    case 'ready': {
      if (data === null) return { kind: 'placeholder' };
      if (exit === null) return { kind: 'count', count: data.evaluated, share: null };
      if (data.exits === undefined) return { kind: 'none' };
      const count = data.exits[exit];
      return { kind: 'count', count, share: share(count, data.evaluated) };
    }
  }
}

/** One stage's bar. Only a loaded range with evaluated traffic and an `exits` block
 * draws tracks; a zero range draws none, and a failure or no `exits` none either. */
function barFor(
  measured: MeasuredState,
  data: AutoPerformance | null,
  exit: ExitKey | null,
): StageBarVm | null {
  if (exit === null) return null;
  if (measured === 'loading') return { kind: 'placeholder' };
  if (measured !== 'ready' || data === null || data.exits === undefined) return null;
  return { kind: 'track', ratio: data.evaluated === 0 ? 0 : data.exits[exit] / data.evaluated };
}

function bandAlertVm(data: AutoPerformance): BandAlertVm | null {
  const high = data.bands.high.unroutable;
  const low = data.bands.low.unroutable;
  if (high === 0 && low === 0) return null;
  const where = 'on the Any request and class rows';
  if (high > 0 && low > 0)
    return {
      text: `${high.toLocaleString()} confident high and ${low.toLocaleString()} confident low verdicts had no usable target and went to Default — check the missing-or-unusable targets in the Targets matrix’s Strong and Cheap columns, ${where}`,
      columns: ['strong', 'cheap'],
    };
  const [n, verdict, column] = high > 0 ? [high, 'high', 'Strong'] : [low, 'low', 'Cheap'];
  return {
    text: `${n.toLocaleString()} confident ${verdict} verdict${n === 1 ? '' : 's'} had no usable ${column} target and went to Default — check the missing-or-unusable target in the Targets matrix’s ${column} column, ${where}`,
    columns: [high > 0 ? 'strong' : 'cheap'],
  };
}

function defaultDetailVm(data: AutoPerformance): DefaultDetailVm {
  const high = data.bands.high.unroutable;
  const low = data.bands.low.unroutable;
  // With nothing evaluated every exit is 0, so an absent block still totals 0.
  const total = data.exits?.default ?? (data.evaluated === 0 ? 0 : null);
  return {
    unroutable: { high, low },
    fallthrough: data.fallthrough,
    other: total === null ? null : total - (high + low + data.fallthrough),
  };
}

export function toPipelineVm(input: PipelineInput): PipelineVm {
  const { autoLayers: al, autoPerf, catalog } = input;
  const measured = measuredState(input);
  const data = autoPerf.data;
  const showFigures = measured === 'zero' || measured === 'unavailable' || measured === 'ready';

  const [l1, l2, l3] = structuralLayers(al) as [LayerRow, LayerRow, LayerRow];
  // Layer 1's EFFECTIVE flag; unknown (null) while the view loads, and then no
  // stage claims to be paused or off.
  const l1On = al === null ? null : al.structural;
  // Paused means "Layer 1 is OFF here": an instance that cannot run Layer 1 at all is
  // not paused — its stages need L1, which is unavailable (split-auto-routing D3).
  const paused = l1On === false && al?.structuralAvailable === true;

  // Configuration only — the measured slice is withheld here so no status phrase
  // can carry a figure (the matrix and the details read it themselves).
  const bands = bandVms({
    ...catalog,
    cascadeEffective: al?.cascade ?? false,
    autoPerf: { data: null, range: autoPerf.range },
  });
  const workload = workloadVms({
    ...catalog,
    autoPerf: { data: null, range: autoPerf.range },
    semanticWorkload: al?.semanticWorkload ?? false,
  });

  /* Status now and history captions (split-auto-routing-readout-setup D3). Status reads
   * routing state alone; a caption reads the status AND the row's own exit, so a count
   * from when a stage ran is never presented as what it does now. */
  const capable = al !== null && al.structuralAvailable;
  const l1Off = al !== null && al.structuralAvailable && !al.structural;
  const unverified = (input.unverified?.bands ?? false) || (input.unverified?.claims ?? false);
  const unverifiedLines: StatusLine[] = unverified ? [UNVERIFIED_LINE] : [];
  const classes: CascadeClassInput[] = workload.rows.map((r) => ({
    cls: r.cls,
    live: r.live,
    claimed: r.live && r.usable,
    scoped: scopedBandVms(catalog, r.cls),
  }));
  const pairs = cascadePairs(bands, classes);
  const cascadeCanRun = pairs.generic || pairs.classes.length > 0;
  /** Live, unclaimed classes with a band target of their own — a claimed class's
   * scoped targets are never named: its claim wins. */
  const ownBands = classes.filter((c) => c.live && !c.claimed && c.scoped.anyScoped);
  const bandCanRoute =
    bands.high.usable ||
    bands.low.usable ||
    ownBands.some((c) => c.scoped.high.usable || c.scoped.low.usable);
  const exitOf = (k: ExitKey): number => data?.exits?.[k] ?? 0;
  /** A stage whose own state is not running: L1 off pauses 2–5; then its own layer. */
  const routedCaption = (own: string | null): string | null =>
    al === null ? null : l1Off ? 'routed while L1 was on' : (own ?? 'routed here');
  const perfVm = showFigures ? toAutoPerfVm(data) : null;

  /* 1 · Classify */
  const cal = toCalibrationVm(al);
  const verdicts: VerdictsVm =
    measured === 'absent' || measured === 'error'
      ? { kind: 'none' }
      : measured === 'loading' || data === null
        ? { kind: 'placeholder' }
        : {
            kind: 'value',
            text: `${l1Off ? 'verdicts while L1 was on' : 'verdicts'}: ${data.bands.high.requests.toLocaleString()} high · ${data.bands.low.requests.toLocaleString()} low · ${data.bands.ambiguous.requests.toLocaleString()} ambiguous`,
            claimed:
              (perfVm?.workloadRouted ?? 0) > 0
                ? `${(perfVm?.workloadRouted ?? 0).toLocaleString()} of these were served by a Workload claim, not a band target`
                : null,
          };
  const classify: StageRowVm = {
    id: 'classify',
    number: 1,
    name: 'Classify',
    layer: l1.name,
    tag: l1.tag,
    layerRow: l1,
    switchState: layerSwitchState(l1),
    expandable: true,
    targetsLink: false,
    exit: null,
    figure: figureFor(measured, data, null),
    verdicts,
    bar: null,
    caption: al === null ? null : l1Off ? 'evaluated while L1 was on' : 'evaluated',
    statusNow:
      al === null || cal === null
        ? STATUS_LOADING
        : !al.structuralAvailable
          ? statusNow(UNAVAILABLE, 'caution', [
              { text: 'New auto requests go straight to the default tier', tone: 'caution' },
            ])
          : al.structural
            ? statusNow(`On · thresholds ${cal.thresholdsLine} · ${cal.tag}`)
            : statusNow('Off — new auto requests go straight to the default tier', 'caution', [
                neutral('Stages 2–5 pause without Layer 1’s verdicts'),
              ]),
    status: cal === null || l1On === true ? null : { kind: 'off', tone: 'caution' },
  };

  /* 2 · Workload claim — a class claims only with a usable target on a live row
   * (a reserved class is inert until the semantic workload source is effective). */
  const claims = workload.rows.filter((r) => r.live && r.usable);
  const dead = workload.rows.filter((r) => r.live && r.effective !== null && !r.usable).length;
  const claimRoutes =
    claims.length === 0 ? null : claims.map((r) => ({ from: r.cls, to: targetLabel(r.target) }));
  const workloadStage: StageRowVm = {
    id: 'workload',
    number: 2,
    name: 'Workload claim',
    layer: null,
    tag: 'auto_workload',
    layerRow: null,
    switchState: null,
    expandable: true,
    targetsLink: false,
    exit: 'workload',
    figure: figureFor(measured, data, 'workload'),
    verdicts: null,
    bar: barFor(measured, data, 'workload'),
    caption: routedCaption(
      !unverified && claims.length === 0 && exitOf('workload') > 0
        ? 'routed under earlier claims'
        : null,
    ),
    statusNow:
      al === null
        ? STATUS_LOADING
        : !capable
          ? statusNow(NEEDS_L1)
          : statusNow(
              claimRoutes === null ? 'No class claims now' : routesLine(claimRoutes),
              'neutral',
              [
                ...(claims.length > 0
                  ? [
                      neutral(
                        `${String(claims.length)} of ${String(workload.rows.length)} classes claim${claims.length === 1 ? 's' : ''} — the rest pass to stage 3`,
                      ),
                    ]
                  : []),
                ...(dead > 0
                  ? [
                      {
                        text: `${String(dead)} configured claim${dead === 1 ? ' steers' : 's steer'} nothing`,
                        tone: 'caution' as const,
                      },
                    ]
                  : []),
                ...unverifiedLines,
              ],
              claimRoutes,
            ),
    status: paused ? PAUSED : null,
  };

  /* 3 · Confident band — the generic pair, plus which unclaimed classes carry their own. */
  const bandRoutes: SetupRoute[] = [
    { from: 'Strong', to: targetLabel(bands.high.target) },
    { from: 'Cheap', to: targetLabel(bands.low.target) },
  ];
  const band: StageRowVm = {
    id: 'band',
    number: 3,
    name: 'Confident band',
    layer: null,
    tag: 'auto_high · auto_low',
    layerRow: null,
    switchState: null,
    expandable: false,
    targetsLink: true,
    exit: 'structural',
    figure: figureFor(measured, data, 'structural'),
    verdicts: null,
    bar: barFor(measured, data, 'structural'),
    caption: routedCaption(!unverified && !bandCanRoute ? 'routed under earlier targets' : null),
    statusNow:
      al === null
        ? STATUS_LOADING
        : !capable
          ? statusNow(NEEDS_L1)
          : statusNow(
              routesLine(bandRoutes),
              // A target that is set but unusable is a caution; unset is a choice.
              (bands.high.effective !== null && !bands.high.usable) ||
                (bands.low.effective !== null && !bands.low.usable)
                ? 'caution'
                : 'neutral',
              [
                neutral(
                  [
                    'For requests no claim took',
                    ...ownBands.map((c) => {
                      const own = [
                        c.scoped.high.effective !== null ? 'Strong' : null,
                        c.scoped.low.effective !== null ? 'Cheap' : null,
                      ].filter((b): b is string => b !== null);
                      return `${c.cls} uses its own ${own.join(' and ')}`;
                    }),
                  ].join(' · '),
                ),
                ...unverifiedLines,
              ],
              bandRoutes,
            ),
    status: paused ? PAUSED : null,
  };

  /* 4 · Semantic */
  const semantic: StageRowVm = {
    id: 'semantic',
    number: 4,
    name: 'Semantic',
    layer: l2.name,
    tag: l2.tag,
    layerRow: l2,
    switchState: layerSwitchState(l2),
    expandable: true,
    targetsLink: false,
    exit: 'semantic',
    figure: figureFor(measured, data, 'semantic'),
    verdicts: null,
    bar: barFor(measured, data, 'semantic'),
    caption: routedCaption(al !== null && !al.semantic ? 'routed while on' : null),
    statusNow:
      al === null
        ? STATUS_LOADING
        : !capable
          ? statusNow(NEEDS_L1)
          : !al.semanticAvailable
            ? statusNow(UNAVAILABLE, 'neutral', [
                neutral(
                  al.cascade
                    ? 'The ambiguous slice goes straight to the cascade'
                    : 'The ambiguous slice goes straight to the default tier',
                ),
              ])
            : al.semantic
              ? statusNow(`On · learning ${al.semanticLearning ? 'on' : 'off'}`)
              : statusNow(
                  l1Off
                    ? 'Off'
                    : al.cascade
                      ? 'Off — the ambiguous slice goes straight to the cascade'
                      : 'Off — the ambiguous slice goes straight to the default tier',
                ),
    // Its status follows the stage's OWN layer; Layer 1 being off adds the paused badge.
    status:
      al === null ? null : paused ? PAUSED : al.semantic ? null : { kind: 'off', tone: 'neutral' },
  };

  /* 5 · Cascade — its two legs are the generic band targets. */
  const cascade: StageRowVm = {
    id: 'cascade',
    number: 5,
    name: 'Cascade',
    layer: l3.name,
    tag: l3.tag,
    layerRow: l3,
    switchState: layerSwitchState(l3),
    expandable: true,
    targetsLink: false,
    exit: 'cascade',
    figure: figureFor(measured, data, 'cascade'),
    verdicts: null,
    bar: barFor(measured, data, 'cascade'),
    caption: routedCaption(
      al !== null && !al.cascade
        ? 'routed while on'
        : !unverified && !cascadeCanRun
          ? 'routed while it could run'
          : null,
    ),
    statusNow:
      al === null
        ? STATUS_LOADING
        : !capable
          ? statusNow(NEEDS_L1)
          : !al.cascadeAvailable
            ? statusNow(UNAVAILABLE, 'neutral', [
                neutral('Still-ambiguous requests use the default tier'),
              ])
            : !al.cascade
              ? statusNow(l1Off ? 'Off' : 'Off — still-ambiguous requests use the default tier')
              : cascadeCanRun
                ? statusNow(
                    `On · Cheap first (${targetLabel(bands.low.target)}), escalates to Strong (${targetLabel(bands.high.target)})`,
                    'neutral',
                    [
                      neutral(
                        pairs.generic
                          ? 'A class’s own Strong or Cheap target replaces that leg for the class'
                          : `Only ${listOf(pairs.classes)} can cascade — other ambiguous requests go to Default`,
                      ),
                      ...unverifiedLines,
                    ],
                  )
                : statusNow('On, but needs usable Strong and Cheap targets', 'caution', [
                    neutral(
                      `Cheap: ${targetLabel(bands.low.target)} · Strong: ${targetLabel(bands.high.target)}`,
                    ),
                    ...unverifiedLines,
                  ]),
    status:
      al === null ? null : paused ? PAUSED : al.cascade ? null : { kind: 'off', tone: 'neutral' },
  };

  /* 6 · Default */
  const fallback: StageRowVm = {
    id: 'default',
    number: 6,
    name: 'Default',
    layer: null,
    tag: 'Layer-0 default tier',
    layerRow: null,
    switchState: null,
    expandable: true,
    targetsLink: false,
    exit: 'default',
    figure: figureFor(measured, data, 'default'),
    verdicts: null,
    bar: barFor(measured, data, 'default'),
    caption: 'routed here',
    statusNow: statusNow('Always on', 'neutral', [
      neutral('Where auto lands when a stage is off or a target is unusable'),
    ]),
    status: null,
  };

  return {
    measured,
    range: autoPerf.range,
    stages: [classify, workloadStage, band, semantic, cascade, fallback],
    defaultDetail: showFigures && data !== null ? defaultDetailVm(data) : null,
    perf: perfVm,
    cascadeHistory:
      al !== null && capable && (l1Off || !al.cascade || (!unverified && !cascadeCanRun)),
    bandAlert: showFigures && data !== null ? bandAlertVm(data) : null,
  };
}
