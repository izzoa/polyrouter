import { Inject, Injectable } from '@nestjs/common';
import {
  evaluateQuality,
  bandRuleIsScoped,
  resolveBandTarget,
  type NormalizedResponse,
  type RouteDecision,
  type RoutingSnapshot,
} from '@polyrouter/data-plane';
import { ROUTING_CONFIG, type RoutingConfig } from '../routing.config';

/** The cheap + strong band targets a cascade tries, in order. */
export interface CascadePlan {
  readonly cheap: RouteDecision;
  readonly strong: RouteDecision;
  /** The request's deciding workload class the plan was resolved under
   * (add-workload-scoped-bands), or null. */
  readonly scope: string | null;
  /** Per-leg provenance: was the SELECTED cheap / strong rule class-scoped?
   * (a generic-cheap + scoped-strong hybrid is `cheapScoped=false`,
   * `strongScoped=true`). The learning contributor keys on `cheapScoped`. */
  readonly cheapScoped: boolean;
  readonly strongScoped: boolean;
}

/**
 * Layer-3 cascade policy (#14, spec §7.2). Resolves the cheap (`auto_low`) and
 * strong (`auto_high`) band targets and evaluates whether a cheap answer should
 * escalate. Pure policy — the proxy owns the orchestration (cheap-first buffered,
 * gate, escalate, replay) and the reliable-core rescue.
 */
@Injectable()
export class CascadeRouter {
  constructor(@Inject(ROUTING_CONFIG) private readonly cfg: RoutingConfig) {}

  get enabled(): boolean {
    return this.cfg.cascade.enabled;
  }

  get cheapTimeoutMs(): number {
    return this.cfg.cascade.cheapTimeoutMs;
  }

  /** Resolve the cheap + strong targets; `null` when either is missing or
   * unresolvable → the caller keeps the Layer-0 default (invariant 1). */
  plan(snapshot: RoutingSnapshot, scope?: string | null): CascadePlan | null {
    // Each band resolves with the request's class scope independently
    // (add-workload-scoped-bands): a class with only a scoped cheap rule
    // cascades scoped-cheap → generic-strong, and vice versa.
    const cheap = resolveBandTarget(snapshot, 'auto_low', 'cascade', 'cascade cheap tier', scope);
    const strong = resolveBandTarget(
      snapshot,
      'auto_high',
      'cascade',
      'cascade strong tier',
      scope,
    );
    if (cheap === null || strong === null) return null;
    return {
      cheap,
      strong,
      scope: scope ?? null,
      cheapScoped: bandRuleIsScoped(snapshot, 'auto_low', scope),
      strongScoped: bandRuleIsScoped(snapshot, 'auto_high', scope),
    };
  }

  /** Escalate when the cheap answer's quality score is below the threshold. A
   * quality-eval throw fails open (deliver cheap; `score = null`, not a false 1).
   * `structuredDemand` is the request's declared machine-parseable-output flag
   * (computed once pre-cheap-call by the proxy). */
  shouldEscalate(
    response: NormalizedResponse,
    structuredDemand: boolean,
  ): { score: number | null; escalate: boolean } {
    let score: number;
    try {
      score = evaluateQuality(response, { structuredDemand });
    } catch {
      return { score: null, escalate: false };
    }
    return { score, escalate: score < this.cfg.cascade.qualityThreshold };
  }
}
