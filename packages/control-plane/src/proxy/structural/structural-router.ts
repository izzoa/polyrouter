import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalizeSystem,
  classifyStructural,
  extractStructuralFeatures,
  isRouteError,
  resolveTarget,
  ruleOrder,
  type NormalizedRequest,
  type RouteDecision,
  type RoutingSnapshot,
} from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import { ROUTING_CONFIG, type RoutingConfig } from '../routing.config';
import { StructuralBaselineStore } from './structural-baseline.store';

/**
 * Layer-1 structural router (#13, spec §7.2). Orchestrates the pure engine +
 * the learned baseline and maps a confident band to a configured `auto_high` /
 * `auto_low` tier target. `decide` returns a `RouteDecision` (decision_layer
 * `'structural'`) ONLY when confident with a resolvable target; otherwise `null`
 * so the caller keeps the Layer-0 `default` decision. The whole body degrades to
 * `null` on any error — the smart path never fails or stalls a request
 * (invariant 1).
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
  async decide(
    principal: Principal,
    agentId: string | null,
    ir: NormalizedRequest,
    snapshot: RoutingSnapshot,
  ): Promise<RouteDecision | null> {
    if (!this.enabled) return null;
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
      const verdict = classifyStructural(features, baseline, {
        high: this.cfg.structural.high,
        low: this.cfg.structural.low,
        weights: this.cfg.structural.weights,
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

      if (verdict.band === 'ambiguous') return null;
      const matchType = verdict.band === 'high' ? 'auto_high' : 'auto_low';
      const rule = snapshot.rules.filter((r) => r.matchType === matchType).sort(ruleOrder)[0];
      if (rule === undefined) return null; // no configured band target → Layer 0 default

      const decision = resolveTarget(snapshot, rule.target, 'structural', verdict.reason);
      return isRouteError(decision) ? null : decision;
    } catch {
      return null; // degrade to Layer 0 — never fail or stall
    }
  }
}
