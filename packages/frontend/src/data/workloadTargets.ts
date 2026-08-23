import {
  STRUCTURAL_WORKLOAD_CLASSES,
  WORKLOAD_CLASSES,
  type WorkloadClass,
} from '@polyrouter/shared';
import type { AutoPerformance, RuleDto } from './api';
import {
  effectiveRuleOrder,
  resolveTargetState,
  targetUsable,
  type BandTargetState,
  type TargetCatalog,
} from './bandTargets';
import type { Range } from '../types';

/** View-model for the Routing page's WORKLOAD TARGETS card
 * (add-workload-routing D6). Pure — every display rule unit-testable. One row
 * per taxonomy class; the LIVE rows (a structural source exists) carry a
 * picker, the RESERVED rows (semantic-only classes) are disclosed but inert. */

/** Display order: the live structural classes first, then the reserved ones. */
export const WORKLOAD_ROW_ORDER: readonly WorkloadClass[] = [
  ...STRUCTURAL_WORKLOAD_CLASSES,
  ...WORKLOAD_CLASSES.filter(
    (c) => !(STRUCTURAL_WORKLOAD_CLASSES as readonly string[]).includes(c),
  ),
];

export const WORKLOAD_LABELS: Record<WorkloadClass, string> = {
  code: 'Code',
  vision: 'Vision',
  structured: 'Structured output',
  research: 'Research',
  writing: 'Writing',
};

/** What the structural source keys each live class on (the W-1 classifier). */
export const WORKLOAD_SIGNALS: Record<WorkloadClass, string> = {
  code: 'fenced code above the configured code thresholds (default: 30% of the window, 200+ chars)',
  vision: 'an image in the request',
  structured: 'a declared JSON output format',
  research: 'detected by the semantic workload source (embedding vs bundled anchors)',
  writing: 'detected by the semantic workload source (embedding vs bundled anchors)',
};

export interface WorkloadVm {
  cls: WorkloadClass;
  label: string;
  /** A semantic-only class (research / writing): its source is the flag-gated
   * semantic module, so the row is LIVE only while that source is effective. */
  reserved: boolean;
  /** The row carries live controls: every structural class, and a reserved
   * class exactly when the semantic workload source is effective
   * (add-semantic-workloads D5). */
  live: boolean;
  /** The rule the PROXY would use: priority DESC, then createdAt, then id. */
  effective: RuleDto | null;
  /** Every other rule of the class — dead weight the cleanup action removes. */
  shadowed: RuleDto[];
  target: BandTargetState;
  /** The class steers something routable (not unset/empty/unresolved). */
  usable: boolean;
  /** Range-scoped figures from the Auto-performance workload mix (null until
   * that section has loaded): requests carrying the class, and how many of
   * them the workload stage actually routed. */
  routed: { count: number; requests: number; range: Range } | null;
}

export interface WorkloadTargetsInput extends TargetCatalog {
  rules: RuleDto[];
  autoPerf: { data: AutoPerformance | null; range: Range };
  /** The EFFECTIVE semantic workload source (auto-layers `semanticWorkload`):
   * flips the reserved rows live. */
  semanticWorkload: boolean;
}

export interface WorkloadTargetsVm {
  rows: WorkloadVm[];
  /** Any live class currently steers something (a usable target). */
  anyUsable: boolean;
  /** Workload routing served requests in the loaded range — the Auto-
   * performance band figures then include claimed rows (disclosure). */
  routedTotal: number;
}

export function isReservedWorkload(cls: WorkloadClass): boolean {
  return !(STRUCTURAL_WORKLOAD_CLASSES as readonly string[]).includes(cls);
}

/** The empty-state copy for ONE class — what happens to its requests today.
 * A reserved class reads as live only when its semantic source is effective. */
export function unsetCopy(cls: WorkloadClass, live = !isReservedWorkload(cls)): string {
  if (isReservedWorkload(cls) && !live) {
    return `${WORKLOAD_LABELS[cls]} requests are not detected on this instance yet (${WORKLOAD_SIGNALS[cls]} — not effective here); a target here stays inert until it is.`;
  }
  return `${WORKLOAD_LABELS[cls]} requests (${WORKLOAD_SIGNALS[cls]}) follow the complexity path: band targets, then L2 and the cascade where enabled, then default.`;
}

function workloadVm(input: WorkloadTargetsInput, cls: WorkloadClass): WorkloadVm {
  const ofClass = input.rules
    .filter((r) => r.matchType === 'auto_workload' && r.workloadClass === cls)
    .sort(effectiveRuleOrder);
  const effective = ofClass[0] ?? null;
  const shadowed = ofClass.slice(1);
  const target: BandTargetState =
    effective === null ? { kind: 'unset' } : resolveTargetState(input, effective.target);
  const perf = input.autoPerf.data;
  const mixRow = perf?.workloadMix.classes.find((c) => c.class === cls);
  const routed =
    perf === null
      ? null
      : {
          count: mixRow?.routed ?? 0,
          requests: mixRow?.requests ?? 0,
          range: input.autoPerf.range,
        };
  const reserved = isReservedWorkload(cls);
  return {
    cls,
    label: WORKLOAD_LABELS[cls],
    reserved,
    live: !reserved || input.semanticWorkload,
    effective,
    shadowed,
    target,
    usable: targetUsable(target),
    routed,
  };
}

export function workloadVms(input: WorkloadTargetsInput): WorkloadTargetsVm {
  const rows = WORKLOAD_ROW_ORDER.map((cls) => workloadVm(input, cls));
  return {
    rows,
    anyUsable: rows.some((r) => r.live && r.usable),
    routedTotal: rows.reduce((a, r) => a + (r.routed?.count ?? 0), 0),
  };
}
