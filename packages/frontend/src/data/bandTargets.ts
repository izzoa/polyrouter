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

function bandVm(input: BandTargetsInput, band: BandKey): BandVm {
  const ofBand = input.rules.filter((r) => r.matchType === band).sort(effectiveRuleOrder);
  const effective = ofBand[0] ?? null;
  const shadowed = ofBand.slice(1);

  let target: BandTargetState = { kind: 'unset' };
  if (effective !== null) {
    const parsed = parseRoutingTarget(effective.target);
    if (parsed === null) {
      target = { kind: 'unresolved', literal: effective.target, parsed: 'malformed' };
    } else if (parsed.kind === 'tier') {
      const tier = input.tiers.find((t) => t.key === parsed.key);
      if (tier === undefined) {
        // Late-bound by key (routing-config contract): recreating the key
        // rebinds — until then the literal is shown.
        target = { kind: 'unresolved', literal: effective.target, parsed: 'tier' };
      } else {
        const entries = [...(input.tierEntries[tier.id] ?? [])].sort(
          (a, b) => a.position - b.position,
        );
        const primaryEntry = entries[0];
        const primaryModel =
          primaryEntry === undefined
            ? undefined
            : (input.models.find((m) => m.id === primaryEntry.modelId) ?? undefined);
        target = {
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
    } else {
      const model = input.models.find((m) => m.id === parsed.id);
      if (model === undefined) {
        target = { kind: 'unresolved', literal: effective.target, parsed: 'model' };
      } else {
        target = {
          kind: 'model',
          label: modelLabel(model),
          provider: input.providers.find((p) => p.id === model.providerId)?.name ?? null,
          model,
        };
      }
    }
  }

  const usable = (target.kind === 'tier' && !target.empty) || target.kind === 'model';

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
