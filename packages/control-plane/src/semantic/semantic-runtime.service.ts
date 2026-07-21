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

  constructor(
    @Inject(SEMANTIC_CONFIG) private readonly cfg: SemanticConfig,
    @Inject(SEMANTIC_LOADER) private readonly loader: SemanticLoader,
  ) {}

  /** True once the embedder loaded and warmed (the capability input). */
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

  async onApplicationBootstrap(): Promise<void> {
    if (this.cfg.modelPath === undefined) {
      this.logger.log('semantic embedder absent (SEMANTIC_MODEL_PATH unset) — Layer 2 unavailable');
      return;
    }
    try {
      const { embedder, warmupMs } = await this.loader(this.cfg);
      this.loaded = embedder;
      this.logger.log(
        `semantic embedder ready: ${embedder.id} dims=${String(embedder.dims)} warmup=${String(warmupMs)}ms timeout=${String(this.cfg.timeoutMs)}ms concurrency=${String(this.cfg.concurrency)}`,
      );
    } catch (err) {
      // Fail fast, naming the variable + file basename + reason — never the
      // full operator-supplied path value (clink r1 Low-1).
      const detail =
        err instanceof SemanticLoadError
          ? `${err.file}: ${err.reason}`
          : err instanceof Error
            ? err.message
            : 'unknown error';
      throw new Error(
        `SEMANTIC_MODEL_PATH: model bundle failed to load (${detail}) — fix the bundle or unset SEMANTIC_MODEL_PATH to disable the semantic layer`,
        { cause: err },
      );
    }
  }
}
