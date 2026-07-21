import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  ANCHOR_SET_ID,
  HIGH_ANCHORS,
  LOW_ANCHORS,
  SEMANTIC_EXTRACTOR_VERSION,
  extractSemanticInput,
  validateCentroids,
  type Embedder,
  type SemanticCentroids,
} from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import {
  computeRevision,
  hashAnchorContent,
  type ClassificationSourceProvider,
  type ClassificationState,
  type LearningGate,
} from './classification-source';
import { SemanticRuntimeService } from './semantic-runtime.service';
import type { SemanticConfig } from './semantic.config';

/**
 * The classifier-side inputs to the LEARNING-evidence revision + the bundled
 * centroids the sweep folds against (add-semantic-learning task 4.2). It carries
 * everything the digest needs EXCEPT the two routing-owned inputs — the
 * quality-gate threshold and the per-tenant resolved `auto_low` chain — which the
 * sweep supplies. `null` when Layer 2 is unavailable, so the sweep no-ops.
 */
export interface LearningProvenance {
  readonly bundled: SemanticCentroids;
  readonly embedderId: string;
  readonly dims: number;
  readonly anchorSetId: string;
  readonly extractorVersion: number;
  readonly highThreshold: number;
  readonly lowThreshold: number;
}

/**
 * The Layer-2 classifier lifecycle (add-semantic-routing D5). A distinct
 * bootstrap phase AFTER the embedder runtime: it awaits the runtime's
 * readiness, serializes the bundled anchors through the SAME extractor live
 * requests use, embeds them, averages per-band centroids, VALIDATES them
 * (unit-norm, non-cancelling — a broken anchor set fails boot), and computes
 * the provenance revision. `available` means the WHOLE classifier is ready,
 * not merely a loaded embedder. Bundled-only source in this change; change 3
 * decorates the `ClassificationSourceProvider` seam with learned state.
 */
@Injectable()
export class SemanticClassifierService
  implements OnApplicationBootstrap, ClassificationSourceProvider
{
  private readonly logger = new Logger('SemanticClassifier');
  private state: ClassificationState | null = null;
  private provenance: LearningProvenance | null = null;
  /** The `computeRevision` inputs (minus source/sourceRevision) captured at
   * bootstrap, so a LEARNED classification can be stamped with a distinct,
   * generation-versioned provenance digest (add-semantic-learning). */
  private revisionInputs: Omit<
    Parameters<typeof computeRevision>[0],
    'source' | 'sourceRevision'
  > | null = null;

  constructor(private readonly runtime: SemanticRuntimeService) {}

  /** The whole classifier is ready (embedder loaded ∧ centroids built). */
  get available(): boolean {
    return this.state !== null;
  }

  /** The bundled centroids + revision provenance the learning sweep folds
   * against (add-semantic-learning). `null` when Layer 2 is unavailable. */
  get learningProvenance(): LearningProvenance | null {
    return this.provenance;
  }

  /** The bundled classification state (add-semantic-learning): the learned
   * decorator's fall-back when a gate fails. `null` when unavailable. */
  bundledState(): ClassificationState | null {
    return this.state;
  }

  /** The provenance digest for a LEARNED classification at `(epoch, generation)`
   * — distinct from bundled so telemetry attributes the verdict. `null` when
   * unavailable. */
  learnedRevision(epoch: number, generation: number): string | null {
    if (this.revisionInputs === null) return null;
    return computeRevision({
      ...this.revisionInputs,
      source: 'learned',
      sourceRevision: `${String(epoch)}.${String(generation)}`,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async resolve(_principal: Principal, _gate: LearningGate): Promise<ClassificationState> {
    if (this.state === null) throw new Error('semantic classifier not ready');
    return this.state; // the base source is always bundled; the decorator layers learned
  }

  async onApplicationBootstrap(): Promise<void> {
    // Correct ordering without assuming Nest sequenced the two hooks (D5).
    // The embedder LOAD already succeeded or failed boot in the runtime; here
    // we build centroids from it. A degenerate result (the anchors do not
    // separate under THIS embedder) leaves the classifier UNAVAILABLE with a
    // loud error — NOT a boot crash: the embedder opt-in succeeded, and a
    // smart-layer quality fault must degrade to Layer-2-off (invariant 1),
    // never take down an operator's instance. `available` stays false, so the
    // capability honestly reports the incomplete classifier (clink r1 High-4).
    const embedder = await this.runtime.whenReady();
    if (embedder === null) return; // module absent — nothing to build

    const cfg = this.runtime.config;
    try {
      const centroids = await this.buildBundledCentroids(embedder, cfg);
      validateCentroids(centroids, embedder.dims);
      this.revisionInputs = {
        embedderId: embedder.id,
        dims: embedder.dims,
        anchorSetId: ANCHOR_SET_ID,
        anchorContentHash: hashAnchorContent(HIGH_ANCHORS, LOW_ANCHORS),
        extractorVersion: SEMANTIC_EXTRACTOR_VERSION,
        highThreshold: cfg.highThreshold,
        lowThreshold: cfg.lowThreshold,
      };
      const revision = computeRevision({
        ...this.revisionInputs,
        source: 'bundled',
        sourceRevision: ANCHOR_SET_ID,
      });
      this.state = { centroids, source: 'bundled', revision };
      this.provenance = {
        bundled: centroids,
        embedderId: embedder.id,
        dims: embedder.dims,
        anchorSetId: ANCHOR_SET_ID,
        extractorVersion: SEMANTIC_EXTRACTOR_VERSION,
        highThreshold: cfg.highThreshold,
        lowThreshold: cfg.lowThreshold,
      };
      this.logger.log(
        `semantic classifier ready: anchors=${ANCHOR_SET_ID} high=${String(HIGH_ANCHORS.length)} low=${String(LOW_ANCHORS.length)} revision=${revision}`,
      );
    } catch (err) {
      this.state = null;
      this.logger.error(
        `semantic classifier UNAVAILABLE — bundled centroids did not build/validate under embedder ${embedder.id} (${err instanceof Error ? err.message : 'unknown'}); Layer 2 is off, all other routing is unaffected`,
      );
    }
  }

  private async buildBundledCentroids(
    embedder: Embedder,
    cfg: SemanticConfig,
  ): Promise<SemanticCentroids> {
    const caps = { totalChars: cfg.maxInputChars };
    const embedAnchor = (text: string): Promise<Float32Array> =>
      embedder.embed(
        extractSemanticInput(
          {
            model: 'auto',
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
            params: {},
          },
          caps,
        ),
      );
    // Build the two bands SEQUENTIALLY (clink r2 Med-1): concurrent chains
    // would issue two embeds at once and deterministically saturate a
    // `SEMANTIC_CONCURRENCY=1` no-queue embedder, disabling the classifier.
    const high = await this.centroidOf(HIGH_ANCHORS, embedAnchor, embedder.dims);
    const low = await this.centroidOf(LOW_ANCHORS, embedAnchor, embedder.dims);
    return { high, low };
  }

  private async centroidOf(
    anchors: readonly string[],
    embed: (t: string) => Promise<Float32Array>,
    dims: number,
  ): Promise<Float32Array> {
    const acc = new Float32Array(dims);
    // Sort so the float accumulation order matches hashAnchorContent's sorted
    // order — reordering the anchor list can never change the centroid without
    // changing the revision (clink r2 Low-1).
    for (const text of [...anchors].sort()) {
      const v = await embed(text);
      for (let i = 0; i < dims; i += 1) acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
    }
    let norm = 0;
    for (const x of acc) norm += x * x;
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm === 0) {
      throw new Error('bundled anchor centroid is zero or non-finite');
    }
    for (let i = 0; i < dims; i += 1) acc[i] = (acc[i] ?? 0) / norm;
    return acc;
  }
}
