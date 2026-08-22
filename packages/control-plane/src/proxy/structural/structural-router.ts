import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalizeSystem,
  classifyStructural,
  classifyWorkload,
  extractStructuralFeatures,
  resolveBandTarget,
  type NormalizedRequest,
  type RouteDecision,
  type RoutingSnapshot,
  type StructuralFeatures,
  type StructuralVerdict,
  type WorkloadVerdict,
} from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import { ROUTING_CONFIG, type RoutingConfig } from '../routing.config';
import { StructuralBaselineStore } from './structural-baseline.store';

/** The outcome of Layer-1 classification. `route` = confident band with a
 * resolvable target; `ambiguous` = classified between thresholds (the trigger
 * for Layer 3 cascade, #14); `unroutable` = successfully classified but no
 * resolvable target (verdict intact — telemetry); `skip` = disabled or a
 * classification degradation (no verdict — never fabricated). */
export type StructuralEvaluation =
  | {
      readonly kind: 'route';
      readonly decision: RouteDecision;
      readonly verdict: StructuralVerdict;
      /** The workload verdict from the SAME features (add-workload-telemetry
       * D1) — telemetry only; absent when the workload classifier faulted. */
      readonly workload?: WorkloadVerdict;
    }
  | {
      readonly kind: 'ambiguous';
      readonly verdict: StructuralVerdict;
      readonly workload?: WorkloadVerdict;
    }
  /** A CONFIDENT/declared band whose `auto_high`/`auto_low` target is missing
   * or unresolvable — classification succeeded; the default stands but the
   * verdict is corpus data (add-auto-decision-telemetry), never a bare skip. */
  | {
      readonly kind: 'unroutable';
      readonly verdict: StructuralVerdict;
      readonly workload?: WorkloadVerdict;
    }
  /** No successful classification: layer off, or the classify-throw
   * degradation — degradation never fabricates telemetry. */
  | { readonly kind: 'skip' };

/**
 * Layer-1 structural router (#13, spec §7.2). Orchestrates the pure engine + the
 * learned baseline and maps a confident band to a configured `auto_high` /
 * `auto_low` tier target. `evaluate` exposes the band verdict (so #14 cascade can
 * act on `ambiguous`); `decide` is the #13 adapter (`route → decision`, else
 * `null`). Any error degrades to `skip`/`null` — the smart path never fails or
 * stalls a request (invariant 1).
 */
@Injectable()
export class StructuralRouter {
  constructor(
    @Inject(ROUTING_CONFIG) private readonly cfg: RoutingConfig,
    private readonly baseline: StructuralBaselineStore,
  ) {}

  /** True when the structural layer is enabled at all (skip cheaply otherwise). */
  get enabled(): boolean {
    return this.cfg.autoLayers.has('structural');
  }

  // Async by contract: Layer 1 resolves synchronously (the baseline read is a
  // local-cache hit — no network on the hot path), but the deferred Layer 2
  // (semantic) will await a local embedding, so the interface stays async.
  // eslint-disable-next-line @typescript-eslint/require-await
  async evaluate(
    principal: Principal,
    agentId: string | null,
    ir: NormalizedRequest,
    snapshot: RoutingSnapshot,
    thresholds?: { high: number; low: number },
  ): Promise<StructuralEvaluation> {
    if (!this.enabled) return { kind: 'skip' };
    try {
      const tenantId = principal.kind === 'user' ? principal.userId : principal.orgId;
      const canonical = canonicalizeSystem(ir);
      const features = extractStructuralFeatures(ir);
      // The baseline store never throws by design; guard anyway so a store fault
      // degrades to raw-feature classification (no subtraction) — still a
      // decision — rather than dropping the whole smart path.
      let baseline = null;
      try {
        baseline = this.baseline.read(tenantId, agentId, canonical);
      } catch {
        baseline = null;
      }
      // Per-tenant calibrated thresholds (add-auto-threshold-calibration):
      // the caller passes the pre-resolved effective pair (zero extra reads);
      // absent → the instance config, byte-identical to the pre-change path.
      const verdict = classifyStructural(features, baseline, {
        high: thresholds?.high ?? this.cfg.structural.high,
        low: thresholds?.low ?? this.cfg.structural.low,
        weights: this.cfg.structural.weights,
        reasoningAdjust: this.cfg.structural.reasoningAdjust,
      });
      // Fire-and-forget learning update (off the response path).
      try {
        this.baseline.observe(
          tenantId,
          agentId,
          canonical,
          features.effectiveInputChars,
          this.cfg.structural.baselineAlpha,
        );
      } catch {
        /* best-effort */
      }

      // Workload verdict (add-workload-telemetry D1): the SAME feature object,
      // in its OWN try/catch — a workload fault drops ONLY the workload verdict;
      // the structural evaluation below is byte-identical either way. Telemetry
      // only: it decides nothing here.
      let workload: WorkloadVerdict | undefined;
      try {
        workload = this.workloadOf(features);
      } catch {
        workload = undefined; // degradation never fabricates a verdict
      }
      const wl = workload !== undefined ? { workload } : {};

      if (verdict.band === 'ambiguous') return { kind: 'ambiguous', verdict, ...wl };
      const matchType = verdict.band === 'high' ? 'auto_high' : 'auto_low';
      const decision = resolveBandTarget(snapshot, matchType, 'structural', verdict.reason);
      // A confident band with no configured/resolvable target degrades to Layer 0
      // — carrying its verdict (add-auto-decision-telemetry).
      return decision === null
        ? { kind: 'unroutable', verdict, ...wl }
        : { kind: 'route', decision, verdict, ...wl };
    } catch {
      return { kind: 'skip' }; // degrade to Layer 0 — never fail or stall
    }
  }

  /** The structural workload classifier over already-extracted features —
   * a protected seam so a fault can be injected in tests; production is the
   * pure `classifyWorkload` with the boot-time thresholds + revision. */
  protected workloadOf(features: StructuralFeatures): WorkloadVerdict {
    return classifyWorkload(features, this.cfg.workload.thresholds, this.cfg.workload.revision);
  }

  /** #13 adapter: the confident-band decision, else `null` (keep Layer-0 default). */
  async decide(
    principal: Principal,
    agentId: string | null,
    ir: NormalizedRequest,
    snapshot: RoutingSnapshot,
  ): Promise<RouteDecision | null> {
    const e = await this.evaluate(principal, agentId, ir, snapshot);
    return e.kind === 'route' ? e.decision : null;
  }
}
