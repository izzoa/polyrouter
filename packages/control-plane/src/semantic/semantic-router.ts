import { Inject, Injectable } from '@nestjs/common';
import {
  classifySemantic,
  classifySemanticWorkload,
  extractSemanticInput,
  resolveBandTarget,
  semanticWorkloadVerdict,
  type NormalizedRequest,
  type RouteDecision,
  type RoutingSnapshot,
  type SemanticBand,
  type SemanticWorkloadVerdict,
} from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import {
  CLASSIFICATION_SOURCE,
  type ClassificationSourceProvider,
  type LearningGate,
} from './classification-source';
import { SemanticClassifierService, type LearningProvenance } from './semantic-classifier.service';
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
  | {
      readonly kind: 'ambiguous';
      readonly verdict: SemanticVerdict;
      /** The request's IN-MEMORY embedding (add-semantic-learning D1). Rides this
       * ephemeral field ONLY — never a telemetry column, writer draft, or log —
       * to the recorder's learning contributor at cascade-settle, then dropped. */
      readonly evidence: Float32Array;
    }
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

  /** True when the semantic WORKLOAD source is ready (add-semantic-workloads):
   * embedder ∧ five validated workload centroids — independent of `enabled`. */
  get workloadEnabled(): boolean {
    return this.runtime.embedder !== null && this.classifier.workloadReady;
  }

  /** The bundled centroids + revision provenance for the learning-evidence
   * revision (add-semantic-learning); `null` when Layer 2 is unavailable. */
  get provenance(): LearningProvenance | null {
    return this.classifier.learningProvenance;
  }

  /**
   * EMBED ONLY (add-semantic-workloads D2): serialize + embed the request once.
   * `null` = no usable vector — the embedder is absent, the request carries no
   * non-system evidence, or the vector is DEGENERATE (non-finite / zero-norm —
   * an embed-quality fault, never reusable evidence). Timeouts / aborts /
   * saturation REJECT (the caller's fault boundary decides what a failed embed
   * means for its stage). Never classifies.
   */
  async embed(
    ir: NormalizedRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<{ text: string; vector: Float32Array } | null> {
    const embedder = this.runtime.embedder;
    if (embedder === null) return null;
    const text = extractSemanticInput(ir, { totalChars: this.runtime.config.maxInputChars });
    // No non-system evidence (e.g. a system-only request): embedding an empty
    // string and classifying it would be a fabricated verdict (clink r2 Med-2).
    if (text.trim().length === 0) return null;
    const vector = await embedder.embed(text, opts?.signal ? { signal: opts.signal } : undefined);
    let norm = 0;
    for (const x of vector) {
      if (!Number.isFinite(x)) return null;
      norm += x * x;
    }
    if (norm === 0) return null;
    return { text, vector };
  }

  /**
   * BAND classification over an already-embedded vector (the second half of
   * the pre-split `evaluate`): learned-or-bundled centroids under the gate,
   * the three-band verdict, and the band-target resolution. Any fault → skip.
   */
  async classifyBand(
    vector: Float32Array,
    principal: Principal,
    snapshot: RoutingSnapshot,
    gate: LearningGate,
  ): Promise<SemanticEvaluation> {
    if (!this.classifier.available) return { kind: 'skip' };
    let verdict: SemanticVerdict;
    try {
      const cfg = this.runtime.config;
      // Learned centroids supersede bundled ONLY under the decision-time gate;
      // ANY failure (incl. Redis) returns bundled, never skip (D4).
      const state = await this.source.resolve(principal, gate);
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
      return { kind: 'skip' }; // any internal throw: fail open
    }
    if (verdict.band === 'ambiguous') return { kind: 'ambiguous', verdict, evidence: vector };
    const matchType = verdict.band === 'high' ? 'auto_high' : 'auto_low';
    const decision = resolveBandTarget(snapshot, matchType, 'semantic', verdict.reason);
    if (decision === null) return { kind: 'unroutable', verdict };
    return { kind: 'route', decision, verdict };
  }

  /**
   * The pre-split contract (add-semantic-routing): embed, then classify the
   * band. EVERY fault — not ready, empty evidence, embed timeout, caller
   * cancellation, a degenerate/`invalid` classification — degrades to `skip`
   * (invariant 1: the smart path never fails or stalls a request, and never
   * fabricates telemetry).
   */
  async evaluate(
    principal: Principal,
    ir: NormalizedRequest,
    snapshot: RoutingSnapshot,
    gate: LearningGate,
    opts?: { signal?: AbortSignal },
  ): Promise<SemanticEvaluation> {
    if (!this.classifier.available || this.runtime.embedder === null) return { kind: 'skip' };
    let embedded: { text: string; vector: Float32Array } | null;
    try {
      embedded = await this.embed(ir, opts);
    } catch {
      return { kind: 'skip' }; // timeout, abort, saturation, or any internal throw: fail open
    }
    if (embedded === null) return { kind: 'skip' };
    return this.classifyBand(embedded.vector, principal, snapshot, gate);
  }

  /**
   * The semantic WORKLOAD verdict over an already-embedded vector
   * (add-semantic-workloads D1/D3): `null` when the workload source is not
   * ready or the pure classifier reports a degenerate input. Throws only on an
   * unexpected internal fault — the proxy's stage boundary catches it.
   */
  classifyWorkload(vector: Float32Array): SemanticWorkloadVerdict | null {
    const wl = this.classifier.workloadState;
    if (wl === null) return null;
    const result = classifySemanticWorkload(vector, wl.centroids, wl.rails);
    if (result.kind === 'invalid') return null;
    return semanticWorkloadVerdict(result, wl.revision);
  }
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
