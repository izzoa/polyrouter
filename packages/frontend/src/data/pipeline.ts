import type { AutoLayers, AutoPerformance, RuleDto } from './api';
import {
  layerSwitchState,
  structuralLayers,
  type LayerRow,
  type LayerSwitchState,
} from './autoLayerHints';
import { toAutoPerfVm, type AutoPerfVm } from './autoPerf';
import { bandVms, scopedBandVms, type BandTargetState, type TargetCatalog } from './bandTargets';
import { toCalibrationVm } from './calibration';
import { WORKLOAD_ROW_ORDER, workloadVms } from './workloadTargets';
import type { Range } from '../types';

/** View-model for the Auto routing tab's PIPELINE (redesign-auto-routing-pipeline
 * D7): the six stages in the order the proxy runs them, each one's routed-here
 * figure, and the summary bar of disjoint exits. Pure — the arithmetic (shares,
 * the zero and absent-`exits` cases, the Default reconciliation) is owned by the
 * unit tests, not the view.
 *
 * Two rules shape every output:
 * - configuration (switches, setup summaries) renders from routing state alone and
 *   never waits on the aggregation;
 * - no measured figure is fabricated, stale-as-current, or `NaN`: a set `error`
 *   emits none at all, even though the store keeps the last data on a failure. */

export type StageId = 'classify' | 'workload' | 'band' | 'semantic' | 'cascade' | 'default';

/** The keys of the aggregation's `exits` block — one per stage after Classify. */
export type ExitKey = 'workload' | 'structural' | 'semantic' | 'cascade' | 'default';

/** Which designed state the measured figures are in.
 * - `absent` — the structural capability is off instance-wide: no figure renders;
 * - `error` — the load failed: a notice and Retry, no figure from an earlier load;
 * - `loading` — no data for the selected range yet: placeholders;
 * - `zero` — no evaluated rows in the range: zero counts, "—" shares, no bar;
 * - `unavailable` — loaded, but the server sent no `exits` (an older server): the
 *   per-stage counts are unavailable, never zero, while every other figure renders;
 * - `ready` — every figure renders. */
export type MeasuredState = 'absent' | 'error' | 'loading' | 'zero' | 'unavailable' | 'ready';

/** A stage row's routed-here figure. */
export type StageFigure =
  /** `share` is of evaluated — "—" when nothing was evaluated, never `NaN%`;
   * null on Classify, whose count IS the evaluated total. */
  | { kind: 'count'; count: number; share: string | null }
  | { kind: 'placeholder' }
  /** No figure can be shown (a failed load, or no `exits` block). */
  | { kind: 'unavailable' }
  /** The capability is absent — the row carries no figure slot at all. */
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
  /** The Setup column: a configuration summary while the stage runs, or the
   * statement of where its traffic goes while its own layer is off. Never a
   * measured figure. */
  setup: string;
  /** A setup line that is a list of "X routes to Y" pairs (Workload claim,
   * Confident band). The view draws each arrow as artwork — the bundled fonts
   * carry no arrow character — so the pairs travel as data, and `setup` holds the
   * same line in words for anything that reads it as text. Null for prose. */
  setupRoutes: SetupRoute[] | null;
  setupSub: string | null;
  status: StageStatus | null;
}

export interface SetupRoute {
  from: string;
  to: string;
}

export interface ExitEntryVm {
  exit: ExitKey;
  stage: StageId;
  number: 2 | 3 | 4 | 5 | 6;
  /** The stage's name — the legend states it in text, so no exit is told apart
   * by color alone. */
  label: string;
  count: number;
  share: string;
}

export interface ExitBarVm {
  /** = evaluated — the five exits partition it. */
  total: number;
  /** Non-zero exits only: a zero exit draws no segment. */
  segments: ExitEntryVm[];
  /** All five in stage order, zeros included. */
  legend: ExitEntryVm[];
}

/** The Default detail's figures. On proxy-written rows `total = unroutable.high +
 * unroutable.low + fallthrough`; `other` holds any remainder. */
export interface DefaultDetailVm {
  /** `exits.default`; null when the server sent no `exits` block. */
  total: number | null;
  /** Confident bands retained on default for want of a usable target. */
  unroutable: { high: number; low: number };
  /** Ambiguous requests no later stage took (`fallthrough` ⊆ `exits.default`). */
  fallthrough: number;
  /** Banded rows recorded at a layer the proxy never writes on the auto path
   * (`total` minus the three above) — 0 on proxy-written rows; null with `total`. */
  other: number | null;
}

export interface PipelineInput {
  autoLayers: AutoLayers | null;
  autoPerf: { data: AutoPerformance | null; error: string | null; range: Range };
  catalog: TargetCatalog & { rules: RuleDto[] };
}

export interface PipelineVm {
  measured: MeasuredState;
  /** The range every figure is framed to. */
  range: Range;
  stages: StageRowVm[];
  /** Only in `ready`: a zero range has no bar, and a failed or unexported load
   * has no figures to draw. */
  exitBar: ExitBarVm | null;
  /** Null while loading, after a failure, and when the capability is absent. */
  defaultDetail: DefaultDetailVm | null;
  /** The auto-performance view-model behind the stage details and the focal
   * savings — gated exactly like the figures (null unless `zero`, `unavailable`
   * or `ready`), so a detail can never render a stale figure as current. */
  perf: AutoPerfVm | null;
}

const PAUSED: StageStatus = { kind: 'paused', label: 'paused · needs L1' };
const OFF_HISTORY = 'Any count shown is history from when it was on';
const LOADING_SETUP = 'Loading…';

/** The words form of a routes setup line: `code: tier:premium · …`. */
function routesLine(routes: SetupRoute[]): string {
  return routes.map((r) => `${r.from}: ${r.to}`).join(' · ');
}

/** Share of evaluated, whole percent — "—" when nothing was evaluated. */
function shareOf(n: number, evaluated: number): string {
  return evaluated === 0 ? '—' : `${((n / evaluated) * 100).toFixed(0)}%`;
}

/** A band or claim target in one short phrase, for a setup line. */
export function targetLabel(t: BandTargetState): string {
  switch (t.kind) {
    case 'unset':
      return 'unset';
    case 'tier':
      return t.empty ? `tier:${t.key} (empty)` : `tier:${t.key}`;
    case 'model':
      return t.label;
    case 'unresolved':
      return `${t.literal} (unresolved)`;
  }
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
      return { kind: 'none' };
    case 'error':
      return { kind: 'unavailable' };
    case 'loading':
      return { kind: 'placeholder' };
    case 'zero':
      // The exits partition `evaluated`, so with nothing evaluated every exit
      // is a true 0 — whether or not the server sent the block.
      return { kind: 'count', count: 0, share: exit === null ? null : '—' };
    case 'unavailable':
    case 'ready': {
      if (data === null) return { kind: 'placeholder' };
      if (exit === null) return { kind: 'count', count: data.evaluated, share: null };
      if (data.exits === undefined) return { kind: 'unavailable' };
      const count = data.exits[exit];
      return { kind: 'count', count, share: shareOf(count, data.evaluated) };
    }
  }
}

const EXIT_STAGES: readonly {
  exit: ExitKey;
  stage: StageId;
  number: ExitEntryVm['number'];
  label: string;
}[] = [
  { exit: 'workload', stage: 'workload', number: 2, label: 'Workload claim' },
  { exit: 'structural', stage: 'band', number: 3, label: 'Confident band' },
  { exit: 'semantic', stage: 'semantic', number: 4, label: 'Semantic' },
  { exit: 'cascade', stage: 'cascade', number: 5, label: 'Cascade' },
  { exit: 'default', stage: 'default', number: 6, label: 'Default' },
];

function exitBarVm(data: AutoPerformance): ExitBarVm | null {
  const exits = data.exits;
  if (exits === undefined) return null;
  const legend = EXIT_STAGES.map((s) => ({
    ...s,
    count: exits[s.exit],
    share: shareOf(exits[s.exit], data.evaluated),
  }));
  return { total: data.evaluated, segments: legend.filter((e) => e.count > 0), legend };
}

function defaultDetailVm(data: AutoPerformance): DefaultDetailVm {
  const high = data.bands.high.unroutable;
  const low = data.bands.low.unroutable;
  // With nothing evaluated every exit is 0, so an absent block still totals 0.
  const total = data.exits?.default ?? (data.evaluated === 0 ? 0 : null);
  return {
    total,
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
  const paused = l1On === false;

  // Configuration only — the measured slice is withheld here so no setup line
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

  /* 1 · Classify */
  const cal = toCalibrationVm(al);
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
    setupRoutes: null,
    ...(cal === null
      ? { setup: LOADING_SETUP, setupSub: null, status: null }
      : l1On === true
        ? {
            setup: `Thresholds ${cal.thresholdsLine}`,
            setupSub: `${cal.tag} · self-calibration ${cal.enabled ? 'on' : 'off'}`,
            status: null,
          }
        : {
            setup: 'Off — new auto requests go straight to the default tier',
            setupSub: 'Stages 2–5 pause without Layer 1’s verdicts',
            status: { kind: 'off', tone: 'caution' },
          }),
  };

  /* 2 · Workload claim — a class claims only with a usable target on a live row
   * (a reserved class is inert until the semantic workload source is effective). */
  const claims = workload.rows.filter((r) => r.live && r.usable);
  const dead = workload.rows.filter((r) => r.live && r.effective !== null && !r.usable).length;
  const claimSub = [
    claims.length > 0
      ? `${String(claims.length)} of ${String(workload.rows.length)} classes claim${claims.length === 1 ? 's' : ''} — the rest pass to stage 3`
      : null,
    dead > 0
      ? `${String(dead)} configured claim${dead === 1 ? ' steers' : 's steer'} nothing`
      : null,
  ].filter((p): p is string => p !== null);
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
    setup:
      claimRoutes === null
        ? 'No class claims — every request passes to stage 3'
        : routesLine(claimRoutes),
    setupRoutes: claimRoutes,
    setupSub: claimSub.length === 0 ? null : claimSub.join(' · '),
    status: paused ? PAUSED : null,
  };

  /* 3 · Confident band — the generic pair, plus which classes carry their own. */
  const scoped = WORKLOAD_ROW_ORDER.map((cls) => scopedBandVms(catalog, cls))
    .filter((s) => s.anyScoped)
    .map((s) => {
      const own = [
        s.high.effective !== null ? 'Strong' : null,
        s.low.effective !== null ? 'Cheap' : null,
      ].filter((b): b is string => b !== null);
      return `${s.cls} has its own ${own.join(' and ')} target${own.length === 1 ? '' : 's'}`;
    });
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
    setup: routesLine(bandRoutes),
    setupRoutes: bandRoutes,
    setupSub: scoped.length === 0 ? null : scoped.join(' · '),
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
    setupRoutes: null,
    // Copy follows the stage's OWN layer; Layer 1 being off adds the paused status on
    // top. Branching on `paused` first would describe a switched-off layer as routing.
    ...(al === null
      ? { setup: LOADING_SETUP, setupSub: null, status: null }
      : al.semantic
        ? {
            setup: 'Routes the ambiguous slice Layer 1 can’t read',
            setupSub: `learning ${al.semanticLearning ? 'on' : 'off'}`,
            status: paused ? PAUSED : null,
          }
        : {
            setup: paused
              ? 'Off'
              : al.cascade
                ? 'Off — the ambiguous slice goes straight to the cascade'
                : 'Off — the ambiguous slice goes straight to the default tier',
            setupSub: OFF_HISTORY,
            status: paused ? PAUSED : { kind: 'off', tone: 'neutral' },
          }),
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
    setupRoutes: null,
    ...(al === null
      ? { setup: LOADING_SETUP, setupSub: null, status: null }
      : al.cascade
        ? {
            setup: 'Tries cheap first, escalates on a failed quality check',
            setupSub: bands.cascadeNeedsBoth
              ? 'Needs usable Strong and Cheap targets — ambiguous requests stay on the default tier until both are'
              : `${targetLabel(bands.low.target)} first, then ${targetLabel(bands.high.target)}`,
            status: paused ? PAUSED : null,
          }
        : {
            setup: paused ? 'Off' : 'Off — still-ambiguous requests use the default tier',
            setupSub: OFF_HISTORY,
            status: paused ? PAUSED : { kind: 'off', tone: 'neutral' },
          }),
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
    setup: 'Where auto lands when a stage is off or a target is unusable',
    setupRoutes: null,
    setupSub: null,
    status: null,
  };

  return {
    measured,
    range: autoPerf.range,
    stages: [classify, workloadStage, band, semantic, cascade, fallback],
    exitBar: measured === 'ready' && data !== null ? exitBarVm(data) : null,
    defaultDetail: showFigures && data !== null ? defaultDetailVm(data) : null,
    perf: showFigures ? toAutoPerfVm(data) : null,
  };
}
