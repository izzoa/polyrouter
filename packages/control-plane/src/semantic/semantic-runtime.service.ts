import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Embedder } from '@polyrouter/data-plane';
import { SEMANTIC_LOADER, SemanticLoadError, type SemanticLoader } from './onnx-loader';
import { SEMANTIC_CONFIG, type SemanticConfig } from './semantic.config';

/**
 * The semantic-runtime holder (add-semantic-embedder D5). Constructed cheap
 * during DI; the awaited `onApplicationBootstrap` hook performs the load —
 * dynamic import → bundle load → content hash → warmup — and THROWS on
 * failure, which prevents `app.listen()` from ever binding: an operator who
 * explicitly opted in gets a loud failure, never a silently-inert layer.
 * Unset path → a no-op hook, one boot line, `available=false`.
 */
@Injectable()
export class SemanticRuntimeService implements OnApplicationBootstrap {
  private readonly logger = new Logger('SemanticRuntime');
  private loaded: (Embedder & { readonly saturated: boolean }) | null = null;
  /** Resolves after this service's own bootstrap completes (the embedder or
   * null) — the classifier (add-semantic-routing) AWAITS this rather than
   * assuming Nest ordered the two bootstrap hooks. Rejects if load fails
   * (which also fails boot). */
  private resolveReady!: (embedder: Embedder | null) => void;
  private rejectReady!: (err: unknown) => void;
  private readonly readyPromise = new Promise<Embedder | null>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });

  constructor(
    @Inject(SEMANTIC_CONFIG) private readonly cfg: SemanticConfig,
    @Inject(SEMANTIC_LOADER) private readonly loader: SemanticLoader,
  ) {
    // A rejection with no awaiter (e.g. the runtime tested without the
    // classifier wired) must not crash the process — the real consumer
    // (`whenReady()`) still receives it through its own handler.
    void this.readyPromise.catch(() => undefined);
  }

  /** True once the embedder loaded and warmed (the runtime capability). */
  get available(): boolean {
    return this.loaded !== null;
  }

  /** The seam consumers use (change 2's classifier); null = unavailable. */
  get embedder(): Embedder | null {
    return this.loaded;
  }

  /** Saturation is a visible health signal (D6). */
  get saturated(): boolean {
    return this.loaded?.saturated ?? false;
  }

  /** Await this service's bootstrap; resolves the embedder (or null when the
   * module is absent). The classifier chains off this for correct ordering. */
  whenReady(): Promise<Embedder | null> {
    return this.readyPromise;
  }

  /** The resolved semantic config (thresholds, caps) — the classifier reads
   * it rather than re-injecting the token. */
  get config(): SemanticConfig {
    return this.cfg;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.cfg.modelPath === undefined) {
      this.logger.log('semantic embedder absent (SEMANTIC_MODEL_PATH unset) — Layer 2 unavailable');
      this.resolveReady(null);
      return;
    }
    try {
      const { embedder, warmupMs } = await this.loader(this.cfg);
      this.loaded = embedder;
      this.logger.log(
        `semantic embedder ready: ${embedder.id} dims=${String(embedder.dims)} warmup=${String(warmupMs)}ms timeout=${String(this.cfg.timeoutMs)}ms concurrency=${String(this.cfg.concurrency)}`,
      );
      this.resolveReady(embedder);
    } catch (err) {
      // Fail fast, naming the variable + file basename + reason — never the
      // full operator-supplied path value (clink r1 Low-1).
      const detail =
        err instanceof SemanticLoadError
          ? `${err.file}: ${err.reason}`
          : err instanceof Error
            ? err.message
            : 'unknown error';
      const wrapped = new Error(
        `SEMANTIC_MODEL_PATH: model bundle failed to load (${detail}) — fix the bundle or unset SEMANTIC_MODEL_PATH to disable the semantic layer`,
        { cause: err },
      );
      this.rejectReady(wrapped);
      throw wrapped;
    }
  }
}
