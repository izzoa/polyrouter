import { Inject, Injectable } from '@nestjs/common';
import {
  classifySemantic,
  extractSemanticInput,
  resolveBandTarget,
  type NormalizedRequest,
  type RouteDecision,
  type RoutingSnapshot,
  type SemanticBand,
} from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import {
  CLASSIFICATION_SOURCE,
  type ClassificationSourceProvider,
} from './classification-source';
import { SemanticClassifierService } from './semantic-classifier.service';
import { SemanticRuntimeService } from './semantic-runtime.service';

/** The Layer-2 verdict (add-semantic-routing). Carried on `Prepared` and
 * projected into telemetry centrally; `reason` is numbers-only. */
export interface SemanticVerdict {
  readonly band: SemanticBand;
  readonly score: number;
  readonly simHigh: number;
  readonly simLow: number;
  readonly source: 'bundled' | 'learned';
  readonly revision: string;
  readonly reason: string;
}

/** Mirrors StructuralEvaluation exactly: `route` = confident band with a
 * resolvable target; `ambiguous` = between thresholds (hands to cascade/
 * default); `unroutable` = confident band whose target is missing (verdict is
 * still telemetry); `skip` = disabled or ANY fault (no verdict — never
 * fabricated). */
export type SemanticEvaluation =
  | { readonly kind: 'route'; readonly decision: RouteDecision; readonly verdict: SemanticVerdict }
  | { readonly kind: 'ambiguous'; readonly verdict: SemanticVerdict }
  | { readonly kind: 'unroutable'; readonly verdict: SemanticVerdict }
  | { readonly kind: 'skip' };

/**
 * Layer-2 semantic router. Mirrors StructuralRouter's contract. EVERY fault —
 * not ready, embed timeout, caller cancellation, a degenerate/`invalid`
 * classification — degrades to `skip` (invariant 1: the smart path never
 * fails or stalls a request, and never fabricates telemetry).
 */
@Injectable()
export class SemanticRouter {
  constructor(
    private readonly runtime: SemanticRuntimeService,
    // Readiness gate (bundled classifier built); the SOURCE of centroids is
    // the injected seam so change 3 can layer learned state without touching
    // this router (clink r2 Med-4).
    private readonly classifier: SemanticClassifierService,
    @Inject(CLASSIFICATION_SOURCE) private readonly source: ClassificationSourceProvider,
  ) {}

  /** True when the whole classifier is ready (skip cheaply otherwise). */
  get enabled(): boolean {
    return this.classifier.available;
  }

  async evaluate(
    principal: Principal,
    ir: NormalizedRequest,
    snapshot: RoutingSnapshot,
    opts?: { signal?: AbortSignal },
  ): Promise<SemanticEvaluation> {
    const embedder = this.runtime.embedder;
    if (!this.classifier.available || embedder === null) return { kind: 'skip' };

    let verdict: SemanticVerdict;
    try {
      const cfg = this.runtime.config;
      const text = extractSemanticInput(ir, { totalChars: cfg.maxInputChars });
      // No non-system evidence (e.g. a system-only request) → skip: embedding
      // an empty string and classifying it would be a fabricated verdict
      // (clink r2 Med-2).
      if (text.trim().length === 0) return { kind: 'skip' };
      const vector = await embedder.embed(text, opts?.signal ? { signal: opts.signal } : undefined);
      const state = this.source.forPrincipal(principal);
      const result = classifySemantic(vector, state.centroids, {
        high: cfg.highThreshold,
        low: cfg.lowThreshold,
      });
      if (result.kind === 'invalid') return { kind: 'skip' }; // degenerate = fault, no telemetry
      verdict = {
        band: result.band,
        score: round4(result.score),
        simHigh: round4(result.simHigh),
        simLow: round4(result.simLow),
        source: state.source,
        revision: state.revision,
        reason: `semantic:${result.band} s=${round4(result.score).toFixed(4)} hi=${round4(result.simHigh).toFixed(4)} lo=${round4(result.simLow).toFixed(4)} src=${state.source}`,
      };
    } catch {
      // Timeout, abort, embedder saturation, or any internal throw: fail open.
      return { kind: 'skip' };
    }

    if (verdict.band === 'ambiguous') return { kind: 'ambiguous', verdict };
    const matchType = verdict.band === 'high' ? 'auto_high' : 'auto_low';
    const decision = resolveBandTarget(snapshot, matchType, 'semantic', verdict.reason);
    if (decision === null) return { kind: 'unroutable', verdict };
    return { kind: 'route', decision, verdict };
  }
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
