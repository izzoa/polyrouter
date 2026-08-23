import { parseRoutingTarget } from '@polyrouter/shared';
import type { AutoPerformance, RuleDto, TierDto, TierEntryDto } from './api';
import type { Model, Provider, Range } from '../types';

/** View-model for the Routing page's BAND TARGETS section
 * (add-band-target-ui). Pure — every display rule unit-testable. */

export type BandKey = 'auto_high' | 'auto_low';

export type BandTargetState =
  | { kind: 'unset' }
  | {
      kind: 'tier';
      key: string;
      isDefault: boolean;
      /** Position-0 model label, null while the tier is empty. */
      primary: string | null;
      fallbacks: number;
      empty: boolean;
    }
  | { kind: 'model'; label: string; provider: string | null; model: Model }
  | { kind: 'unresolved'; literal: string; parsed: 'tier' | 'model' | 'malformed' };

export interface BandVm {
  band: BandKey;
  /** The rule the PROXY would use: priority DESC, then createdAt, then id. */
  effective: RuleDto | null;
  /** Every other rule of the band — dead weight the cleanup action removes. */
  shadowed: RuleDto[];
  target: BandTargetState;
  /** The band steers something routable (not unset/empty/unresolved) —
   * mirrors the cascade planner's resolve success condition. */
  usable: boolean;
  /** Range-scoped unroutable count from the Auto-performance data (null
   * until that section has loaded). Cause-agnostic by construction. */
  unroutable: { count: number; range: Range } | null;
}

export interface BandTargetsInput {
  rules: RuleDto[];
  tiers: TierDto[];
  tierEntries: Record<string, TierEntryDto[]>;
  models: Model[];
  providers: Provider[];
  /** The EFFECTIVE cascade flag (capability × preference). */
  cascadeEffective: boolean;
  autoPerf: { data: AutoPerformance | null; range: Range };
}

export interface BandTargetsVm {
  high: BandVm;
  low: BandVm;
  /** Cascade is on but fewer than two bands are USABLE. */
  cascadeNeedsBoth: boolean;
  /** Both bands usable and resolving to one destination — the cascade
   * would retry the same chain. */
  sameDestination: boolean;
}

/** The proxy's deterministic resolution order (routing-config contract):
 * priority DESC, ties by createdAt then id — a total order. */
export function effectiveRuleOrder(a: RuleDto, b: RuleDto): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function modelLabel(m: Model): string {
  return m.displayName ?? m.externalModelId;
}

/** The catalog slice a target literal resolves against (shared by the band
 * and workload cards — add-workload-routing). */
export interface TargetCatalog {
  tiers: TierDto[];
  tierEntries: Record<string, TierEntryDto[]>;
  models: Model[];
  providers: Provider[];
}

/** Resolve ONE `tier:<key>` / `model:<id>` literal to its display state —
 * the same rules for every rule-backed target on the Routing page. */
export function resolveTargetState(input: TargetCatalog, literal: string): BandTargetState {
  const parsed = parseRoutingTarget(literal);
  if (parsed === null) return { kind: 'unresolved', literal, parsed: 'malformed' };
  if (parsed.kind === 'tier') {
    const tier = input.tiers.find((t) => t.key === parsed.key);
    // Late-bound by key (routing-config contract): recreating the key
    // rebinds — until then the literal is shown.
    if (tier === undefined) return { kind: 'unresolved', literal, parsed: 'tier' };
    const entries = [...(input.tierEntries[tier.id] ?? [])].sort((a, b) => a.position - b.position);
    const primaryEntry = entries[0];
    const primaryModel =
      primaryEntry === undefined
        ? undefined
        : (input.models.find((m) => m.id === primaryEntry.modelId) ?? undefined);
    return {
      kind: 'tier',
      key: parsed.key,
      isDefault: parsed.key === 'default',
      primary:
        primaryEntry === undefined
          ? null
          : primaryModel !== undefined
            ? modelLabel(primaryModel)
            : (primaryEntry.model?.externalModelId ?? primaryEntry.modelId),
      fallbacks: Math.max(0, entries.length - 1),
      empty: entries.length === 0,
    };
  }
  const model = input.models.find((m) => m.id === parsed.id);
  if (model === undefined) return { kind: 'unresolved', literal, parsed: 'model' };
  return {
    kind: 'model',
    label: modelLabel(model),
    provider: input.providers.find((p) => p.id === model.providerId)?.name ?? null,
    model,
  };
}

/** A target steers something routable (not unset/empty/unresolved) — mirrors
 * the resolver's success condition. */
export function targetUsable(target: BandTargetState): boolean {
  return (target.kind === 'tier' && !target.empty) || target.kind === 'model';
}

/** The GENERIC (unscoped) rules of a band — add-workload-scoped-bands: a
 * class-scoped band rule (`workloadClass` set) belongs to its class's pair and
 * never shows as the generic effective/shadowed rule. */
export function isGenericRule(r: RuleDto): boolean {
  return r.workloadClass === null || r.workloadClass === undefined;
}

function bandVm(input: BandTargetsInput, band: BandKey): BandVm {
  const ofBand = input.rules
    .filter((r) => r.matchType === band && isGenericRule(r))
    .sort(effectiveRuleOrder);
  const effective = ofBand[0] ?? null;
  const shadowed = ofBand.slice(1);
  const target: BandTargetState =
    effective === null ? { kind: 'unset' } : resolveTargetState(input, effective.target);

  const usable = targetUsable(target);

  const perf = input.autoPerf.data;
  const unroutable =
    perf === null
      ? null
      : {
          count: band === 'auto_high' ? perf.bands.high.unroutable : perf.bands.low.unroutable,
          range: input.autoPerf.range,
        };

  return { band, effective, shadowed, target, usable, unroutable };
}

/** The resolved destination identity for the same-destination warning. */
function destinationOf(vm: BandVm): string | null {
  if (!vm.usable) return null;
  if (vm.target.kind === 'tier') return `tier:${vm.target.key}`;
  if (vm.target.kind === 'model') return `model:${vm.target.model.id}`;
  return null;
}

export function bandVms(input: BandTargetsInput): BandTargetsVm {
  const high = bandVm(input, 'auto_high');
  const low = bandVm(input, 'auto_low');
  const usableCount = (high.usable ? 1 : 0) + (low.usable ? 1 : 0);
  const dHigh = destinationOf(high);
  return {
    high,
    low,
    cascadeNeedsBoth: input.cascadeEffective && usableCount < 2,
    sameDestination: dHigh !== null && dHigh === destinationOf(low),
  };
}

/* ── Class-scoped bands (add-workload-scoped-bands) ──────────────────────────── */

/** A class's own STRONG/CHEAP pair: the rules of each band carrying
 * `workloadClass === cls`, resolved with the same rules as the generic rows.
 * Unroutable figures are not shown (the aggregation is not scope-aware). */
export interface ScopedBandVm {
  band: BandKey;
  cls: string;
  effective: RuleDto | null;
  shadowed: RuleDto[];
  target: BandTargetState;
  usable: boolean;
}

export interface ScopedBandsVm {
  cls: string;
  high: ScopedBandVm;
  low: ScopedBandVm;
  /** Either band of the class has a scoped rule. */
  anyScoped: boolean;
}

function scopedBandVm(
  input: TargetCatalog & { rules: RuleDto[] },
  band: BandKey,
  cls: string,
): ScopedBandVm {
  const ofBand = input.rules
    .filter((r) => r.matchType === band && r.workloadClass === cls)
    .sort(effectiveRuleOrder);
  const effective = ofBand[0] ?? null;
  const target: BandTargetState =
    effective === null ? { kind: 'unset' } : resolveTargetState(input, effective.target);
  return { band, cls, effective, shadowed: ofBand.slice(1), target, usable: targetUsable(target) };
}

export function scopedBandVms(
  input: TargetCatalog & { rules: RuleDto[] },
  cls: string,
): ScopedBandsVm {
  const high = scopedBandVm(input, 'auto_high', cls);
  const low = scopedBandVm(input, 'auto_low', cls);
  return { cls, high, low, anyScoped: high.effective !== null || low.effective !== null };
}

/** Whether ANY class-scoped band rule exists (the savings basis is then the
 * generic strong target and the card says so). */
export function anyScopedBandRule(rules: RuleDto[]): boolean {
  return rules.some(
    (r) => (r.matchType === 'auto_high' || r.matchType === 'auto_low') && !isGenericRule(r),
  );
}

/** The class's Workload-target CLAIM state (add-workload-scoped-bands, clink r1 M4):
 * `usable` — the effective `auto_workload` rule resolves to a usable target and
 * claims the class's requests FIRST (scoped bands stay dormant while it does);
 * `unusable` — a target is configured but empty/unresolved, so it does NOT claim
 * and the scoped bands apply; `none` — no rule. */
export type WorkloadClaimState = 'none' | 'usable' | 'unusable';

export function workloadClaimState(
  input: TargetCatalog & { rules: RuleDto[] },
  cls: string,
): WorkloadClaimState {
  const ofClass = input.rules
    .filter((r) => r.matchType === 'auto_workload' && r.workloadClass === cls)
    .sort(effectiveRuleOrder);
  const effective = ofClass[0];
  if (effective === undefined) return 'none';
  return targetUsable(resolveTargetState(input, effective.target)) ? 'usable' : 'unusable';
}
