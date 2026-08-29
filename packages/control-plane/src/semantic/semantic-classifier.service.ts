import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
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
  CentroidValidationError,
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
import { PhaseBudgetError, classifyBuildFailure } from './recovery-classify';
import {
  RebuildLease,
  RecoveryGeneration,
  type GenerationEnd,
  type SlotOutcome,
} from './recovery-generation';
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

/** Re-exported from where the classification lives, so `instanceof` in
 * `classifyBuildFailure` and the error `runPhase` throws are ONE class. Two
 * same-named classes would make every spent budget classify as terminal —
 * silently disabling recovery for its commonest cause. */
export { PhaseBudgetError };

/** The abort reason the phase timer raises — tagged so ONLY this cause becomes
 * a `PhaseBudgetError`; a caller's own abort stays what it was. */
const PHASE_BUDGET_ABORT = Symbol('polyrouter:phase-budget');
/** Request traffic resumed under a quiet-gated slot — a DEFERRAL, not a failure. */
const PHASE_TRAFFIC_ABORT = Symbol('polyrouter:phase-traffic');
/** The instance is shutting down — closes the generation, re-arms nothing. */
const PHASE_SHUTDOWN_ABORT = Symbol('polyrouter:phase-shutdown');

/** Why a phase stopped, decided by the tagged abort cause rather than inferred. */
export type PhaseStop = 'budget' | 'traffic' | 'shutdown';

function stopOf(reason: unknown): PhaseStop | null {
  if (reason === PHASE_BUDGET_ABORT) return 'budget';
  if (reason === PHASE_TRAFFIC_ABORT) return 'traffic';
  if (reason === PHASE_SHUTDOWN_ABORT) return 'shutdown';
  return null;
}

/** Traffic resumed under a gated slot. Not a failure — the slot simply closes. */
export class PhaseAbandonedError extends Error {
  constructor(readonly phase: string) {
    super(`${phase} anchor build abandoned — request traffic resumed`);
    this.name = 'PhaseAbandonedError';
  }
}

/** Shutdown stopped the phase. Closes the generation; arms nothing. */
export class PhaseShutdownError extends Error {
  constructor(readonly phase: string) {
    super(`${phase} anchor build stopped by shutdown`);
    this.name = 'PhaseShutdownError';
  }
}

@Injectable()
export class SemanticClassifierService
  implements OnApplicationBootstrap, OnModuleDestroy, ClassificationSourceProvider
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

  /**
   * The controller of the phase currently executing, if any. `runPhase` owns
   * the controller, but traffic observation and the shutdown fence live
   * OUTSIDE it and must be able to stop a run — with a tagged cause, since a
   * budget stop, a traffic stop and a shutdown stop mean entirely different
   * things to the recovery state machine. Aborting only takes effect between
   * anchors: a dispatched native call cannot be interrupted.
   */
  private running: { readonly phase: string; readonly ctrl: AbortController } | null = null;
  /** ONE rebuild at a time across both sources — they share an admission gate
   * and an event loop, so concurrent chains would contend with each other. */
  private readonly lease = new RebuildLease();
  private readonly generations = new Map<string, RecoveryGeneration>();
  /** Set in `onModuleDestroy`. Nest runs `onApplicationShutdown` AFTER the HTTP
   * server is disposed, and this project's stream drain runs in the earlier
   * phase — a late fence would let a slot start during a drain. */
  private shuttingDown = false;
  /** How long the model must be free of request-path embeds before a gated
   * slot may start. Long enough that back-to-back traffic does not look like a
   * gap; short enough that an ordinary lull qualifies. */
  private static readonly QUIET_MS = 2_500;

  constructor(private readonly runtime: SemanticRuntimeService) {}

  /** Stop the executing phase, if any, with a tagged cause. Shutdown wins any
   * race — a traffic stop never overrides a shutdown already requested. */
  private stopRunningPhase(cause: PhaseStop): void {
    const run = this.running;
    if (run === null || run.ctrl.signal.aborted) return;
    run.ctrl.abort(
      cause === 'shutdown'
        ? PHASE_SHUTDOWN_ABORT
        : cause === 'traffic'
          ? PHASE_TRAFFIC_ABORT
          : PHASE_BUDGET_ABORT,
    );
  }

  /**
   * Fence recovery EARLY (invariant 12). `onApplicationShutdown` fires after
   * the HTTP server is disposed, by which point the drain is already running;
   * a slot starting then would put 210 inferences in front of it.
   */
  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const gen of this.generations.values()) gen.close('shutdown');
    this.generations.clear();
    this.stopRunningPhase('shutdown');
  }

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

  /**
   * Arm bounded recovery for a source whose build failed RETRYABLY. A terminal
   * fault arms nothing: its inputs are fixed for the process's lifetime, so a
   * repeat is near-certain and would bury the error an operator must act on.
   */
  private armRecovery(
    source: string,
    err: unknown,
    rebuild: (ctx: { readonly final: boolean }) => Promise<void>,
  ): void {
    if (this.shuttingDown) return;
    if (classifyBuildFailure(err) !== 'retryable') return;
    if (this.generations.has(source)) return;

    const gen = new RecoveryGeneration(source, {
      // A gated slot runs only when nothing is in flight and no request-path
      // embed has been attempted recently. The final slot does not ask.
      isQuiet: () => this.runtime.activity?.isQuiet(SemanticClassifierService.QUIET_MS) ?? true,
      acquireLease: () => this.lease.acquire(),
      execute: rebuild,
      classify: (e) => {
        if (e instanceof PhaseShutdownError) return 'terminal';
        if (e instanceof PhaseAbandonedError) return 'abandoned';
        return classifyBuildFailure(e) === 'retryable' ? 'retryable' : 'terminal';
      },
      onSlot: (index, outcome, e) => {
        this.logSlot(source, index, outcome, e);
      },
      onEnd: (end) => {
        this.generations.delete(source);
        this.logGenerationEnd(source, end);
      },
    });
    this.generations.set(source, gen);
    gen.arm();
  }

  /** Timings and counts only — never anchor text, never vector values. */
  private logSlot(source: string, index: number, outcome: SlotOutcome, err?: unknown): void {
    const at = `slot ${String(index + 1)}`;
    if (outcome === 'succeeded') return; // the ready line already says it
    if (outcome === 'closed-unrun') {
      this.logger.log(
        `semantic ${source} recovery ${at}: closed unrun — the model was not embed-quiet`,
      );
      return;
    }
    const why = err instanceof Error ? err.message : 'unknown';
    this.logger.log(
      outcome === 'ran-abandoned'
        ? `semantic ${source} recovery ${at}: abandoned — request traffic resumed (${why})`
        : `semantic ${source} recovery ${at}: failed (${why})`,
    );
  }

  private logGenerationEnd(source: string, end: GenerationEnd): void {
    if (end === 'succeeded' || end === 'shutdown') return;
    this.logger.error(
      end === 'terminal'
        ? `semantic ${source} recovery stopped: the fault is not one a retry can clear — act on the error above`
        : `semantic ${source} recovery EXHAUSTED — no further attempts will be made; restart the instance to try again`,
    );
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
    // Each source installs through the SAME method a rebuild calls, so "a
    // rebuilt source computes what a boot build computes" holds by
    // construction rather than by two implementations agreeing (D5).
    await this.attempt('bundled', () => this.installBundled(embedder, cfg));
    await this.attempt('workload', () => this.installWorkload(embedder, cfg));
  }

  /**
   * Run one source's build, log its failure, and arm bounded recovery when the
   * fault is one a later execution could clear. Used by boot AND by every
   * recovery slot — a rebuild is this same call, with a fresh budget.
   */
  private async attempt(
    source: string,
    install: (opts?: { readonly abandonOnTraffic?: boolean }) => Promise<void>,
  ): Promise<void> {
    try {
      // Boot is never traffic-abandonable: no traffic exists yet, and giving
      // up the boot build would cost the capability for nothing.
      await install();
    } catch (err) {
      this.logBuildFailure(source, err);
      // A GATED slot abandons on resumed traffic; the final one does not.
      this.armRecovery(source, err, ({ final }) => install({ abandonOnTraffic: !final }));
    }
  }

  private async installBundled(
    embedder: Embedder,
    cfg: SemanticConfig,
    opts: { readonly abandonOnTraffic?: boolean } = {},
  ): Promise<void> {
    const { value: centroids, elapsedMs } = await this.runPhase(
      'bundled',
      embedder,
      cfg,
      (embed) => this.buildBundledCentroids(embed, embedder.dims),
      opts,
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
  }

  private async installWorkload(
    embedder: Embedder,
    cfg: SemanticConfig,
    opts: { readonly abandonOnTraffic?: boolean } = {},
  ): Promise<void> {
    const { value: centroids, elapsedMs } = await this.runPhase(
      'workload',
      embedder,
      cfg,
      (embed) => this.buildWorkloadCentroids(embed, embedder.dims),
      opts,
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
  }

  /** Name the CAUSE: a spent budget is a host-speed fault whose remedy is
   * nothing like a bad bundle's. */
  private logBuildFailure(source: string, err: unknown): void {
    const id = this.runtime.bootEmbedder?.id ?? this.runtime.embedder?.id ?? 'unknown';
    const why = err instanceof Error ? err.message : 'unknown';
    if (source === 'bundled') {
      this.logger.error(
        err instanceof PhaseBudgetError
          ? `semantic classifier UNAVAILABLE — ${err.message} under embedder ${id}; the host is slower than the anchor budget allows, the bundle is fine; Layer 2 is off, all other routing is unaffected`
          : `semantic classifier UNAVAILABLE — bundled centroids did not build/validate under embedder ${id} (${why}); Layer 2 is off, all other routing is unaffected`,
      );
      return;
    }
    this.logger.error(
      err instanceof PhaseBudgetError
        ? `semantic workload source UNAVAILABLE — ${err.message} under embedder ${id}; the host is slower than the anchor budget allows — research/writing stay reserved; Layer-2 band classification unaffected`
        : `semantic workload source UNAVAILABLE — workload centroids did not build/validate under embedder ${id} (${why}) — research/writing stay reserved; Layer-2 band classification unaffected`,
    );
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
    opts: { readonly abandonOnTraffic?: boolean } = {},
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
    const stopped = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener(
        'abort',
        () => {
          // Route by the TAGGED cause here too: this race is what settles a
          // phase whose seam never returns, so rejecting it as a budget error
          // regardless would relabel every traffic and shutdown stop as one.
          const stop = stopOf(ctrl.signal.reason);
          reject(
            stop === 'shutdown'
              ? new PhaseShutdownError(phase)
              : stop === 'traffic'
                ? new PhaseAbandonedError(phase)
                : new PhaseBudgetError(phase, budgetMs),
          );
        },
        { once: true },
      );
    });
    this.running = { phase, ctrl };
    try {
      const building = build(async (text: string) => {
        // Between anchors is the ONLY place either check can act: a dispatched
        // native call cannot be interrupted, so this is where a gated slot
        // notices traffic and where an expired budget stops.
        if (opts.abandonOnTraffic === true) {
          const last = this.runtime.activity?.lastRequestAttemptAt ?? null;
          if (last !== null && last >= started) {
            this.stopRunningPhase('traffic');
            throw new PhaseAbandonedError(phase);
          }
        }
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
      const value = await Promise.race([building, stopped]);
      return { value, elapsedMs: Date.now() - started };
    } catch (err) {
      // Only OUR tagged reason becomes a budget error; anything else — a
      // degenerate vector, a saturated gate, a runtime fault — keeps its own
      // identity so the boot log names the real cause.
      if (err instanceof PhaseBudgetError) throw err;
      // Route by the TAGGED cause, never by inspecting a message.
      const stop = ctrl.signal.aborted ? stopOf(ctrl.signal.reason) : null;
      if (stop === 'shutdown') throw new PhaseShutdownError(phase);
      if (stop === 'traffic') throw new PhaseAbandonedError(phase);
      if (stop === 'budget') throw new PhaseBudgetError(phase, budgetMs);
      // The seam refused at its own entry deadline — which, by construction
      // above, IS this phase's deadline. Same cause, so same error.
      if (Date.now() >= deadline) throw new PhaseBudgetError(phase, budgetMs);
      throw err;
    } finally {
      clearTimeout(timer);
      this.running = null;
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
      // Typed like the validators it precedes: a zero/non-finite accumulator is
      // the same class of deterministic fault, and recovery must not retry it.
      throw new CentroidValidationError('bundled anchor centroid is zero or non-finite');
    }
    for (let i = 0; i < dims; i += 1) acc[i] = (acc[i] ?? 0) / norm;
    return acc;
  }
}
