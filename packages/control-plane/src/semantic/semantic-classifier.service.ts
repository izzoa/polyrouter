import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  ANCHOR_SET_ID,
  HIGH_ANCHORS,
  LOW_ANCHORS,
  SEMANTIC_EXTRACTOR_VERSION,
  WORKLOAD_ANCHORS,
  WORKLOAD_ANCHOR_CONTENT_HASH,
  WORKLOAD_ANCHOR_SET_ID,
  extractSemanticInput,
  semanticWorkloadRevision,
  validateCentroids,
  validateWorkloadCentroids,
  type Embedder,
  type SemanticCentroids,
  type SemanticWorkloadRails,
  type WorkloadCentroids,
} from '@polyrouter/data-plane';
import { WORKLOAD_CLASSES, type WorkloadClass } from '@polyrouter/shared';
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

/** The semantic WORKLOAD source's boot-built state (add-semantic-workloads). */
export interface SemanticWorkloadState {
  readonly centroids: WorkloadCentroids;
  readonly rails: SemanticWorkloadRails;
  readonly revision: string;
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
/**
 * Per-phase anchor-build budget (fix-semantic-boot-embed-budget). PROVISIONAL
 * and validated by measurement, not derived: the published image's healthcheck
 * grace is ~70-80s, while the KNOWN startup bound (unbounded session creation +
 * up to `BOOT_EMBED_TIMEOUT_MS` warmup + both phases) does not close on paper.
 * 20s is ~4-5× the observed 4s/5s per phase and keeps a typical slow boot well
 * inside the probe window. Internal on purpose — the defect this fixes was an
 * operator needing to know a knob to get advertised default behaviour, and a
 * second knob is not the cure.
 */
export const ANCHOR_PHASE_BUDGET_MS = 20_000;

/** The phase budget ran out. Distinct from a degenerate-anchor failure so the
 * boot log names a host-speed fault, whose remedy is nothing like a bad bundle. */
export class PhaseBudgetError extends Error {
  constructor(
    readonly phase: string,
    readonly budgetMs: number,
  ) {
    super(`${phase} anchor build exceeded its ${String(budgetMs)}ms boot budget`);
    this.name = 'PhaseBudgetError';
  }
}

/** The abort reason the phase timer raises — tagged so ONLY this cause becomes
 * a `PhaseBudgetError`; a caller's own abort stays what it was. */
const PHASE_BUDGET_ABORT = Symbol('polyrouter:phase-budget');

@Injectable()
export class SemanticClassifierService
  implements OnApplicationBootstrap, ClassificationSourceProvider
{
  private readonly logger = new Logger('SemanticClassifier');
  private state: ClassificationState | null = null;
  /** The semantic WORKLOAD source (add-semantic-workloads D4): five per-class
   * centroids + rails + revision, built in its OWN boot boundary — `null` when
   * the module is absent or the workload anchors did not build/validate. */
  private workload: SemanticWorkloadState | null = null;
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

  /** The semantic WORKLOAD source is ready (embedder ∧ five validated workload
   * centroids) — independent of the band classifier's readiness. */
  get workloadReady(): boolean {
    return this.workload !== null;
  }

  /** The workload centroids, rails, and revision; `null` when not ready. */
  get workloadState(): SemanticWorkloadState | null {
    return this.workload;
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
    const requestSeam = await this.runtime.whenReady();
    if (requestSeam === null) return; // module absent — nothing to build

    // Anchor building runs on the BOOT seam (fix-semantic-boot-embed-budget):
    // no request waits on these embeds, so `SEMANTIC_TIMEOUT_MS` — the rail
    // that exists so no request stalls — must not decide whether the whole
    // capability exists. Same session, same admission gate, same id/dims.
    const embedder = this.runtime.bootEmbedder ?? requestSeam;

    const cfg = this.runtime.config;
    try {
      const { value: centroids, elapsedMs } = await this.runPhase(
        'bundled',
        embedder,
        cfg,
        (embed) => this.buildBundledCentroids(embed, embedder.dims),
      );
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
      // Elapsed on the SUCCESS path so an operator sees headroom BEFORE it is
      // an outage (the reporting instance ran at ~1x margin and had no way to
      // know). Timings only — never anchor text, never vector values.
      this.logger.log(
        `semantic classifier ready: anchors=${ANCHOR_SET_ID} high=${String(HIGH_ANCHORS.length)} low=${String(LOW_ANCHORS.length)} revision=${revision} built=${String(elapsedMs)}ms/${String(ANCHOR_PHASE_BUDGET_MS)}ms`,
      );
    } catch (err) {
      this.state = null;
      // Name the BUDGET when that is the cause: a host-speed fault and a bad
      // bundle have nothing in common as remedies.
      this.logger.error(
        err instanceof PhaseBudgetError
          ? `semantic classifier UNAVAILABLE — ${err.message} under embedder ${embedder.id}; the host is slower than the anchor budget allows, the bundle is fine; Layer 2 is off, all other routing is unaffected`
          : `semantic classifier UNAVAILABLE — bundled centroids did not build/validate under embedder ${embedder.id} (${err instanceof Error ? err.message : 'unknown'}); Layer 2 is off, all other routing is unaffected`,
      );
    }
    // The WORKLOAD source builds in its OWN boundary (add-semantic-workloads D4,
    // clink r2 M1): any failure here — an anchor embed throw, validation, the
    // revision — disables ONLY the workload source with a loud line; the band
    // classifier keeps exactly the state the block above produced.
    try {
      const { value: centroids, elapsedMs } = await this.runPhase(
        'workload',
        embedder,
        cfg,
        (embed) => this.buildWorkloadCentroids(embed, embedder.dims),
      );
      validateWorkloadCentroids(centroids, embedder.dims);
      const rails: SemanticWorkloadRails = {
        margin: cfg.workload.margin,
        minSim: cfg.workload.minSim,
      };
      const revision = semanticWorkloadRevision({
        embedderId: embedder.id,
        anchorSetId: WORKLOAD_ANCHOR_SET_ID,
        anchorContentHash: WORKLOAD_ANCHOR_CONTENT_HASH,
        extractorVersion: SEMANTIC_EXTRACTOR_VERSION,
        margin: rails.margin,
        minSim: rails.minSim,
      });
      this.workload = { centroids, rails, revision };
      this.logger.log(
        `semantic workload source ready: anchors=${WORKLOAD_ANCHOR_SET_ID} classes=${String(WORKLOAD_CLASSES.length)}×${String(WORKLOAD_ANCHORS.code.length)} margin=${String(rails.margin)} minSim=${String(rails.minSim)} revision=${revision} built=${String(elapsedMs)}ms/${String(ANCHOR_PHASE_BUDGET_MS)}ms`,
      );
    } catch (err) {
      this.workload = null;
      this.logger.error(
        err instanceof PhaseBudgetError
          ? `semantic workload source UNAVAILABLE — ${err.message} under embedder ${embedder.id}; the host is slower than the anchor budget allows — research/writing stay reserved; Layer-2 band classification unaffected`
          : `semantic workload source UNAVAILABLE — workload centroids did not build/validate under embedder ${embedder.id} (${err instanceof Error ? err.message : 'unknown'}) — research/writing stay reserved; Layer-2 band classification unaffected`,
      );
    }
  }

  /** Embed each class's anchors SEQUENTIALLY (the band discipline) into one
   * unit-norm centroid per taxonomy class. */
  private async buildWorkloadCentroids(
    embedAnchor: (text: string) => Promise<Float32Array>,
    dims: number,
  ): Promise<Partial<Record<WorkloadClass, Float32Array>>> {
    const out: Partial<Record<WorkloadClass, Float32Array>> = {};
    for (const cls of WORKLOAD_CLASSES) {
      out[cls] = await this.centroidOf(WORKLOAD_ANCHORS[cls], embedAnchor, dims);
    }
    return out;
  }

  /**
   * Run one anchor phase under a TOTAL wall-clock budget. The budget bounds the
   * PHASE, not each embed: `onApplicationBootstrap` blocks `listen()`, so a
   * per-embed bound would trade a lost capability for a boot hang. Enforcement
   * is CANCELLATION — a tagged `AbortController` — never a shrinking per-embed
   * timeout, which would still admit one more inference through the seam's
   * `Math.max(1, …)` floor. The remaining budget is checked before admitting
   * the next anchor, and the seam re-checks the signal immediately before
   * dispatch, so an expired phase starts no native work.
   */
  private async runPhase<T>(
    phase: string,
    embedder: Embedder,
    cfg: SemanticConfig,
    build: (embed: (text: string) => Promise<Float32Array>) => Promise<T>,
  ): Promise<{ value: T; elapsedMs: number }> {
    const budgetMs = ANCHOR_PHASE_BUDGET_MS;
    const ctrl = new AbortController();
    const deadline = Date.now() + budgetMs;
    const started = Date.now();
    const timer = setTimeout(() => {
      ctrl.abort(PHASE_BUDGET_ABORT);
    }, budgetMs);
    timer.unref();
    // The phase is bounded by its OWN timer, not by the seam's cooperation.
    // A seam that ignores the abort would otherwise hang `onApplicationBootstrap`
    // — and that blocks `listen()`, so a dead instance would be the cost of a
    // wedged embed. Racing makes "boot completes" unconditional; the abandoned
    // inference is then exactly the in-flight case the shared gate bounds.
    const budgetExpired = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener(
        'abort',
        () => {
          reject(new PhaseBudgetError(phase, budgetMs));
        },
        { once: true },
      );
    });
    try {
      const building = build(async (text: string) => {
        // Never admit an anchor the budget can no longer pay for.
        const remaining = deadline - Date.now();
        if (ctrl.signal.aborted || remaining <= 0) {
          throw new PhaseBudgetError(phase, budgetMs);
        }
        // A seam bounded by the budget REMAINING, so its entry deadline IS the
        // phase deadline: the pipeline's own before-dispatch check then refuses
        // to start an inference whose tokenizing crossed the line — a window a
        // signal cannot cover, because a timer callback cannot interrupt
        // synchronous work. Same session, same admission gate.
        const seam = this.runtime.boundEmbedder(remaining) ?? embedder;
        return this.anchorEmbedder(seam, cfg, ctrl.signal)(text);
      });
      // A lost race leaves nobody awaiting `building`; consume its settlement.
      building.catch(() => undefined);
      const value = await Promise.race([building, budgetExpired]);
      return { value, elapsedMs: Date.now() - started };
    } catch (err) {
      // Only OUR tagged reason becomes a budget error; anything else — a
      // degenerate vector, a saturated gate, a runtime fault — keeps its own
      // identity so the boot log names the real cause.
      if (err instanceof PhaseBudgetError) throw err;
      if (ctrl.signal.aborted && ctrl.signal.reason === PHASE_BUDGET_ABORT) {
        throw new PhaseBudgetError(phase, budgetMs);
      }
      // The seam refused at its own entry deadline — which, by construction
      // above, IS this phase's deadline. Same cause, so same error.
      if (Date.now() >= deadline) throw new PhaseBudgetError(phase, budgetMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Serialize an anchor exactly as a live request is (the SAME extractor,
   * the SAME caps) before embedding it. */
  private anchorEmbedder(
    embedder: Embedder,
    cfg: SemanticConfig,
    signal?: AbortSignal,
  ): (text: string) => Promise<Float32Array> {
    const caps = { totalChars: cfg.maxInputChars };
    return (text: string): Promise<Float32Array> =>
      embedder.embed(
        extractSemanticInput(
          {
            model: 'auto',
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
            params: {},
          },
          caps,
        ),
        signal === undefined ? undefined : { signal },
      );
  }

  private async buildBundledCentroids(
    embedAnchor: (text: string) => Promise<Float32Array>,
    dims: number,
  ): Promise<SemanticCentroids> {
    // Build the two bands SEQUENTIALLY (clink r2 Med-1): concurrent chains
    // would issue two embeds at once and deterministically saturate a
    // `SEMANTIC_CONCURRENCY=1` no-queue embedder, disabling the classifier.
    const high = await this.centroidOf(HIGH_ANCHORS, embedAnchor, dims);
    const low = await this.centroidOf(LOW_ANCHORS, embedAnchor, dims);
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
