import { isNonRoutableVariant, type WorkloadClass } from '@polyrouter/shared';
import type { RuleDto } from './api';
import {
  bandVms,
  scopedBandVms,
  type BandKey,
  type BandTargetState,
  type BandVm,
  type ScopedBandVm,
  type TargetCatalog,
} from './bandTargets';
import { WORKLOAD_LABELS, workloadVms, type WorkloadVm } from './workloadTargets';
import type { Model } from '../types';

/** View-model for the Auto routing tab's TARGETS MATRIX
 * (redesign-auto-routing-pipeline D7). Pure — composes `bandVms`,
 * `scopedBandVms` and `workloadVms` into rows × cells: an "Any request" row
 * (the GENERIC band rules), then one row per workload class in
 * `WORKLOAD_ROW_ORDER`. Read left to right a row states the proxy's
 * precedence: a usable, live claim first, else the class-scoped band target,
 * else the generic one. Every target guarantee stays with the composed
 * view-models; this file only adds what the matrix needs on top — the
 * `inherit` and `claimed` states, the claim's `live` check, and the short
 * value copy. It reads NO aggregation (split-auto-routing-readout-setup D9):
 * the per-class counts live in the Workload claim detail and the unroutable
 * counts in the Pipeline, so the matrix never waits on a figure. */

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
  notes: TargetCellNotes;
  /** What the cell's value row says when it has no target of its own
   * (split-auto-routing-readout-setup D9): a short value, never a sentence — the
   * Any request target an inherit cell uses, flagged when it is not usable. */
  valueText: string;
  /** Beside — never instead of — the cell's own target state: this band cell is not
   * consulted while the row's claim stands. Null unless `claimed`. */
  claimedNote: string | null;
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
  claim: TargetCellVm;
  strong: TargetCellVm;
  cheap: TargetCellVm;
  /** The row label's sub-line: the signal that detects the class. Null on the Any
   * request row. */
  signal: string | null;
}

export interface TargetsMatrixInput {
  catalog: TargetCatalog & { rules: RuleDto[] };
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
  /** The Any request row's cascade note while `cascadeNeedsBoth` — scoped per leg:
   * a class whose own target fills the unusable band still cascades. */
  cascadeNote: string | null;
  /** ONE note the reserved rows share while their source is not effective; each inert
   * Claim cell points at it. Null when every reserved row is live. */
  reservedNote: string | null;
}

/** Each class's detection signal, short enough for a row label's sub-line. */
const ROW_SIGNALS: Record<WorkloadClass, string> = {
  code: 'fenced code above the code thresholds',
  vision: 'an image in the request',
  structured: 'a declared JSON format',
  research: 'the semantic workload source',
  writing: 'the semantic workload source',
};

const CASCADE_NOTE =
  'Cascade needs both Any request bands usable — ambiguous requests stay on the default tier unless their class sets its own target for the missing band';

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

/** The composed view-models also carry range-scoped figures; the matrix reads none of
 * them, so they are handed no aggregation at all (and their range is never shown). */
const NO_FIGURES = { data: null, range: '7d' } as const;

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

/** A band or claim target in one short phrase — the ONE label grammar the Targets
 * matrix and the Pipeline's status-now phrases share (split-auto-routing-readout-setup
 * D3), so a target reads the same wherever it is named. A degraded target keeps its
 * mark — `(empty)` for a tier with no models, `(unresolved)` for a literal that no
 * longer resolves — so no line presents an unusable target as healthy. */
export function targetLabel(t: BandTargetState): string {
  switch (t.kind) {
    case 'unset':
      return 'not set';
    case 'tier':
      return t.empty ? `tier:${t.key} (empty)` : `tier:${t.key}`;
    case 'model':
      return t.label;
    case 'unresolved':
      return `${t.literal} (unresolved)`;
  }
}

const columnOf = (band: BandKey): 'strong' | 'cheap' => (band === 'auto_high' ? 'strong' : 'cheap');
const verdictOf = (band: BandKey): string => (band === 'auto_high' ? 'high' : 'low');

function genericCell(b: BandVm): TargetCellVm {
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
    valueText: `Not set — confident ${verdictOf(b.band)} verdicts fall through to default`,
    claimedNote: null,
    notes: notesFor(b.target),
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
    valueText: `= Any request · ${targetLabel(generic.target)}${
      generic.usable ? '' : ` — confident ${verdictOf(generic.band)} verdicts go to Default`
    }`,
    claimedNote: claimed ? `Not consulted — the ${WORKLOAD_LABELS[cls]} claim wins` : null,
    notes: notesFor(s.target),
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
    valueText: w.live
      ? 'No claim — takes the complexity path (bands, then L2 and the cascade, then default)'
      : 'inert (read-only)',
    claimedNote: null,
    notes: notesFor(w.target),
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
    valueText: 'n/a — a claim needs a class',
    claimedNote: null,
    notes: notesFor(target),
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

function classRow(
  w: WorkloadVm,
  input: TargetsMatrixInput,
  generic: { high: BandVm; low: BandVm },
): TargetsRowVm {
  const scoped = scopedBandVms(input.catalog, w.cls);
  const claimed = w.live && w.usable;
  return {
    id: w.cls,
    label: w.label,
    reserved: w.reserved,
    live: w.live,
    claimed,
    claimNote: claimNoteOf(w),
    signal: ROW_SIGNALS[w.cls],
    claim: claimCell(w),
    strong: scopedCell(scoped.high, w.cls, generic.high, claimed),
    cheap: scopedCell(scoped.low, w.cls, generic.low, claimed),
  };
}

export function toTargetsMatrixVm(input: TargetsMatrixInput): TargetsMatrixVm {
  const { catalog } = input;
  const generic = bandVms({
    ...catalog,
    cascadeEffective: input.cascadeEffective,
    autoPerf: NO_FIGURES,
  });
  const workloads = workloadVms({
    ...catalog,
    autoPerf: NO_FIGURES,
    semanticWorkload: input.semanticWorkload,
  });
  const any: TargetsRowVm = {
    id: 'any',
    label: 'Any request',
    reserved: false,
    live: true,
    claimed: false,
    claimNote: null,
    signal: null,
    claim: naClaimCell(),
    strong: genericCell(generic.high),
    cheap: genericCell(generic.low),
  };
  const inert = workloads.rows.filter((w) => w.reserved && !w.live);
  const half = input.missingHalf === '' ? '' : ` (${input.missingHalf})`;
  return {
    rows: [any, ...workloads.rows.map((w) => classRow(w, input, generic))],
    cascadeNeedsBoth: generic.cascadeNeedsBoth,
    sameDestination: generic.sameDestination,
    cascadeNote: generic.cascadeNeedsBoth ? CASCADE_NOTE : null,
    reservedNote:
      inert.length === 0
        ? null
        : `${inert.map((w) => w.label).join(' and ')}: their claims and bands are inert until the semantic workload source is effective${half}.`,
  };
}
