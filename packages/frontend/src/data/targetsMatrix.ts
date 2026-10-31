import { isNonRoutableVariant, type WorkloadClass } from '@polyrouter/shared';
import type { AutoPerformance, RuleDto } from './api';
import {
  bandVms,
  scopedBandVms,
  type BandKey,
  type BandTargetState,
  type BandVm,
  type ScopedBandVm,
  type TargetCatalog,
} from './bandTargets';
import { unsetCopy, workloadVms, type WorkloadVm } from './workloadTargets';
import type { Model, Range } from '../types';

/** View-model for the Auto routing tab's TARGETS MATRIX
 * (redesign-auto-routing-pipeline D7). Pure — composes `bandVms`,
 * `scopedBandVms` and `workloadVms` into rows × cells: an "Any request" row
 * (the GENERIC band rules), then one row per workload class in
 * `WORKLOAD_ROW_ORDER`. Read left to right a row states the proxy's
 * precedence: a usable, live claim first, else the class-scoped band target,
 * else the generic one. Every target guarantee stays with the composed
 * view-models; this file only adds what the matrix needs on top — the
 * `inherit` and `claimed` states, the claim's `live` check, and the
 * loading / failure discipline of the measured figures. */

/** What a target cell presents — exactly one per cell.
 * - `set`: an effective rule resolving to something routable.
 * - `inherit`: a class row's band cell with no scoped rule — the proxy falls
 *   back to the Any request row's target, which the cell names.
 * - `unset`: no rule — a generic band falls through to default; a claim
 *   leaves the class on the complexity path (the normal state).
 * - `unresolved` / `empty`: a rule whose target no longer resolves, or a tier
 *   with no models. A set-but-unusable scoped cell is one of these, never
 *   `inherit`: it is unroutable for the class, with no fall-back.
 * - `readonly`: a reserved class's claim while the semantic workload source
 *   is not effective — an API-created rule is still carried for disclosure.
 * - `na`: the Any request row's Claim cell (a claim needs a class). */
export type TargetCellKind =
  'set' | 'inherit' | 'unset' | 'unresolved' | 'empty' | 'readonly' | 'na';

export type TargetColumn = 'claim' | 'strong' | 'cheap';

/** A measured figure under the tab's designed states: a neutral placeholder
 * while the aggregation has no data for the range, nothing while it has
 * failed (no figure from an earlier load is shown as current), else the
 * value. `none` is also what a cell renders when the figure does not apply. */
export type Measured<T> = { kind: 'placeholder' } | { kind: 'none' } | { kind: 'value'; value: T };

/** The Detected column: requests seen, and how many the class's claim routed
 * (null on the Any request row, which has no claim) — framed to `range`. */
export interface DetectedFigure {
  requests: number;
  routed: number | null;
  range: Range;
}

export interface TargetCellNotes {
  /* No `unlisted` note here: an unlisted model target is worded by TargetSummary
   * itself (add-live-subscription-models), so the cell never prints it twice. */
  /** The cell targets a batch-only variant that cannot serve — worded by the
   * page's `nonRoutableNote(model)` (add-model-variant-detection). */
  nonRoutable: Model | null;
  /** The target tier has no models: the cell steers nothing. */
  emptyTier: boolean;
  /** The late-binding guidance for an unresolved target, else null. */
  unresolvedHint: string | null;
}

export interface TargetCellVm {
  column: TargetColumn;
  kind: TargetCellKind;
  /** A FLAG beside the kind, never a kind: this band cell is not consulted
   * while the row's claim stands. True only on a class row's Strong/Cheap
   * cells when that class's claim is usable AND live; the cell still
   * presents its own target, disclosures, picker, Clear and cleanup, so a
   * broken scoped rule never hides under a claim. Always false on a Claim
   * cell (the row's `claimed` carries the row annotation). */
  claimed: boolean;
  /** The rule type this cell reads and writes: `setBandTarget(band, v,
   * scope)` for a band, `setWorkloadTarget(scope, v)` for `auto_workload`. */
  band: BandKey | 'auto_workload';
  /** The class the cell's rules carry; null = the generic rules (and the
   * `na` claim). */
  scope: WorkloadClass | null;
  target: BandTargetState;
  /** The rule the PROXY would use: priority DESC, then createdAt, then id. */
  effective: RuleDto | null;
  /** Every other rule of this band and scope — what cleanup removes. */
  shadowed: RuleDto[];
  /** The cell's OWN target is routable (not unset/empty/unresolved). */
  usable: boolean;
  /** `inherit` cells only: the generic target the proxy falls back to. */
  inherits: { target: BandTargetState; label: string; usable: boolean } | null;
  /** The cell carries live controls (picker, Clear, cleanup). Busy and
   * unverified stay the store's runtime state, applied at render. */
  editable: boolean;
  /** The copy a cell with no rule of its own shows (TargetSummary's `unset`). */
  unsetText: string;
  notes: TargetCellNotes;
  /** The band's range-scoped unroutable count — only on an Any request band
   * cell whose target is not usable (the aggregation is not scope-aware);
   * `none` when it does not apply or the loaded count is zero. */
  unroutable: Measured<{ count: number; range: Range }>;
}

export interface TargetsRowVm {
  id: 'any' | WorkloadClass;
  label: string;
  /** A semantic-only class (research / writing). */
  reserved: boolean;
  /** The row's claim is live: every structural class, and a reserved class
   * exactly when the semantic workload source is effective. */
  live: boolean;
  /** The class's claim is usable AND live — it takes the class first. */
  claimed: boolean;
  /** The row's claim annotation for a configured-but-unusable claim on a live row
   * (it does not claim; the bands apply). A usable claim is annotated on its band
   * cells instead (`claimed`), and an inert reserved row never says the bands apply. */
  claimNote: { kind: 'unusable'; text: string } | null;
  /** A reserved row whose source is not effective: its claim and bands are
   * inert — never "the bands apply". */
  inertNote: string | null;
  claim: TargetCellVm;
  strong: TargetCellVm;
  cheap: TargetCellVm;
  detected: Measured<DetectedFigure>;
}

export interface TargetsMatrixInput {
  catalog: TargetCatalog & { rules: RuleDto[] };
  autoPerf: { data: AutoPerformance | null; error: string | null; range: Range };
  /** The EFFECTIVE semantic workload source (auto-layers `semanticWorkload`). */
  semanticWorkload: boolean;
  /** Which half of the semantic workload source is missing — precomputed
   * copy, empty when effective. */
  missingHalf: string;
  /** The EFFECTIVE cascade flag (capability × preference). */
  cascadeEffective: boolean;
}

export interface TargetsMatrixVm {
  rows: TargetsRowVm[];
  /** Cascade is on but fewer than two GENERIC bands are usable. */
  cascadeNeedsBoth: boolean;
  /** Both GENERIC bands usable and resolving to one destination. */
  sameDestination: boolean;
}

/** Target-unresolved guidance (moved from the Routing page; text unchanged).
 * Null for a target that is not unresolved. */
export function unresolvedHint(t: BandTargetState): string | null {
  if (t.kind !== 'unresolved') return null;
  return t.parsed === 'tier'
    ? 'Recreating the tier key rebinds this rule.'
    : t.parsed === 'model'
      ? 'The model no longer exists — pick a new target.'
      : 'The stored target is malformed — pick a new target.';
}

const PLACEHOLDER = { kind: 'placeholder' } as const;
const NONE = { kind: 'none' } as const;

type MatrixPerf = TargetsMatrixInput['autoPerf'];

/** Failure first: the store keeps the previous data on error, and a stale
 * figure must never read as current. */
function measured<T>(perf: MatrixPerf, pick: (data: AutoPerformance) => T): Measured<T> {
  if (perf.error !== null) return NONE;
  if (perf.data === null) return PLACEHOLDER;
  return { kind: 'value', value: pick(perf.data) };
}

function kindOf(target: BandTargetState, whenUnset: 'unset' | 'inherit'): TargetCellKind {
  switch (target.kind) {
    case 'unset':
      return whenUnset;
    case 'unresolved':
      return 'unresolved';
    case 'tier':
      return target.empty ? 'empty' : 'set';
    case 'model':
      return 'set';
  }
}

function notesFor(target: BandTargetState): TargetCellNotes {
  return {
    nonRoutable:
      target.kind === 'model' && isNonRoutableVariant(target.model.variant) ? target.model : null,
    emptyTier: target.kind === 'tier' && target.empty,
    unresolvedHint: unresolvedHint(target),
  };
}

/** The short name an inherit cell gives the generic target it falls back to. */
function targetLabel(t: BandTargetState): string {
  switch (t.kind) {
    case 'unset':
      return 'not set';
    case 'tier':
      return `tier: ${t.key}`;
    case 'model':
      return t.label;
    case 'unresolved':
      return t.literal;
  }
}

const columnOf = (band: BandKey): 'strong' | 'cheap' => (band === 'auto_high' ? 'strong' : 'cheap');
const verdictOf = (band: BandKey): string => (band === 'auto_high' ? 'high' : 'low');

function inheritText(cls: WorkloadClass, generic: BandVm): string {
  const base = `= any — ${cls} requests use the Any request ${columnOf(generic.band)} target`;
  const fallsThrough = `confident ${verdictOf(generic.band)} verdicts fall through to default`;
  if (generic.target.kind === 'unset') return `${base}, which is not set: ${fallsThrough}`;
  const label = targetLabel(generic.target);
  return generic.usable
    ? `${base}: ${label}`
    : `${base} (${label}), which is unusable: ${fallsThrough}`;
}

/** Generic cells only, and only while their target is not usable; a loaded
 * zero shows nothing (there is nothing to diagnose). */
function unroutableOf(b: BandVm, perf: MatrixPerf): Measured<{ count: number; range: Range }> {
  if (b.usable || perf.error !== null) return NONE;
  if (b.unroutable === null) return PLACEHOLDER;
  return b.unroutable.count === 0 ? NONE : { kind: 'value', value: b.unroutable };
}

function genericCell(b: BandVm, perf: MatrixPerf): TargetCellVm {
  return {
    column: columnOf(b.band),
    kind: kindOf(b.target, 'unset'),
    claimed: false,
    band: b.band,
    scope: null,
    target: b.target,
    effective: b.effective,
    shadowed: b.shadowed,
    usable: b.usable,
    inherits: null,
    editable: true,
    unsetText: `Not set — confident ${verdictOf(b.band)} verdicts fall through to default`,
    notes: notesFor(b.target),
    unroutable: unroutableOf(b, perf),
  };
}

/** A class row's band cell. Editable on every row — a reserved class's bands
 * may be pre-configured while its source is not effective (D9). */
function scopedCell(
  s: ScopedBandVm,
  cls: WorkloadClass,
  generic: BandVm,
  claimed: boolean,
): TargetCellVm {
  const kind = kindOf(s.target, 'inherit');
  return {
    column: columnOf(s.band),
    kind,
    claimed,
    band: s.band,
    scope: cls,
    target: s.target,
    effective: s.effective,
    shadowed: s.shadowed,
    usable: s.usable,
    inherits:
      kind === 'inherit'
        ? { target: generic.target, label: targetLabel(generic.target), usable: generic.usable }
        : null,
    editable: true,
    unsetText: inheritText(cls, generic),
    notes: notesFor(s.target),
    unroutable: NONE,
  };
}

function claimCell(w: WorkloadVm): TargetCellVm {
  return {
    column: 'claim',
    kind: w.live ? kindOf(w.target, 'unset') : 'readonly',
    claimed: false,
    band: 'auto_workload',
    scope: w.cls,
    target: w.target,
    effective: w.effective,
    shadowed: w.shadowed,
    usable: w.usable,
    inherits: null,
    editable: w.live,
    unsetText: unsetCopy(w.cls, w.live),
    notes: notesFor(w.target),
    unroutable: NONE,
  };
}

function naClaimCell(): TargetCellVm {
  const target: BandTargetState = { kind: 'unset' };
  return {
    column: 'claim',
    kind: 'na',
    claimed: false,
    band: 'auto_workload',
    scope: null,
    target,
    effective: null,
    shadowed: [],
    usable: false,
    inherits: null,
    editable: false,
    unsetText: 'No claim — a claim needs a workload class.',
    notes: notesFor(target),
    unroutable: NONE,
  };
}

function claimNoteOf(w: WorkloadVm): TargetsRowVm['claimNote'] {
  // A usable claim needs no row note: its band cells carry the claimed annotation.
  // An inert reserved row says it is inert, never that the bands apply.
  if (!w.live || w.effective === null || w.usable) return null;
  const why = w.target.kind === 'unresolved' ? 'unresolved' : 'empty tier';
  return {
    kind: 'unusable',
    text: `The Workload target for ${w.cls} is set but unusable (${why}) — it does not claim; the bands apply.`,
  };
}

function inertNoteOf(w: WorkloadVm, missingHalf: string): string | null {
  if (!w.reserved || w.live) return null;
  const half = missingHalf === '' ? '' : ` (${missingHalf})`;
  return `This row's claim and bands are inert until the semantic workload source is effective${half}: ${w.cls} requests are not detected yet.`;
}

function classRow(
  w: WorkloadVm,
  input: TargetsMatrixInput,
  generic: { high: BandVm; low: BandVm },
): TargetsRowVm {
  const scoped = scopedBandVms(input.catalog, w.cls);
  const claimed = w.live && w.usable;
  const perf = input.autoPerf;
  const routed = w.routed;
  return {
    id: w.cls,
    label: w.label,
    reserved: w.reserved,
    live: w.live,
    claimed,
    claimNote: claimNoteOf(w),
    inertNote: inertNoteOf(w, input.missingHalf),
    claim: claimCell(w),
    strong: scopedCell(scoped.high, w.cls, generic.high, claimed),
    cheap: scopedCell(scoped.low, w.cls, generic.low, claimed),
    // `routed` is null exactly until the aggregation has loaded; once loaded
    // a class absent from the mix reads zero (workloadVms).
    detected:
      perf.error !== null
        ? NONE
        : routed === null
          ? PLACEHOLDER
          : {
              kind: 'value',
              value: { requests: routed.requests, routed: routed.count, range: routed.range },
            },
  };
}

export function toTargetsMatrixVm(input: TargetsMatrixInput): TargetsMatrixVm {
  const { catalog, autoPerf } = input;
  const perfSlice = { data: autoPerf.data, range: autoPerf.range };
  const generic = bandVms({
    ...catalog,
    cascadeEffective: input.cascadeEffective,
    autoPerf: perfSlice,
  });
  const workloads = workloadVms({
    ...catalog,
    autoPerf: perfSlice,
    semanticWorkload: input.semanticWorkload,
  });
  const any: TargetsRowVm = {
    id: 'any',
    label: 'Any request',
    reserved: false,
    live: true,
    claimed: false,
    claimNote: null,
    inertNote: null,
    claim: naClaimCell(),
    strong: genericCell(generic.high, autoPerf),
    cheap: genericCell(generic.low, autoPerf),
    detected: measured(autoPerf, (d) => ({
      requests: d.evaluated,
      routed: null,
      range: autoPerf.range,
    })),
  };
  return {
    rows: [any, ...workloads.rows.map((w) => classRow(w, input, generic))],
    cascadeNeedsBoth: generic.cascadeNeedsBoth,
    sameDestination: generic.sameDestination,
  };
}
