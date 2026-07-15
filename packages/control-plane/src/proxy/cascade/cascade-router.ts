import { Inject, Injectable } from '@nestjs/common';
import {
  evaluateQuality,
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
  plan(snapshot: RoutingSnapshot): CascadePlan | null {
    const cheap = resolveBandTarget(snapshot, 'auto_low', 'cascade', 'cascade cheap tier');
    const strong = resolveBandTarget(snapshot, 'auto_high', 'cascade', 'cascade strong tier');
    return cheap !== null && strong !== null ? { cheap, strong } : null;
  }

  /** Escalate when the cheap answer's quality score is below the threshold. A
   * quality-eval throw fails open (deliver cheap; `score = null`, not a false 1). */
  shouldEscalate(response: NormalizedResponse): { score: number | null; escalate: boolean } {
    let score: number;
    try {
      score = evaluateQuality(response);
    } catch {
      return { score: null, escalate: false };
    }
    return { score, escalate: score < this.cfg.cascade.qualityThreshold };
  }
}
