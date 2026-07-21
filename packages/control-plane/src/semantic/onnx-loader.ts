import { readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { Embedder } from '@polyrouter/data-plane';
import {
  BundleError,
  WordPieceTokenizer,
  contentHashId,
  parseManifest,
} from './bundle';
import { buildEmbedder, type TensorLike } from './embed-core';
import type { SemanticConfig } from './semantic.config';

/** Load failure carrying the offending file's BASENAME and a reason — the
 * boot error names `SEMANTIC_MODEL_PATH` + these, never the full supplied
 * path value (config-registry convention; clink r1 Low-1). */
export class SemanticLoadError extends Error {
  constructor(
    public readonly file: string,
    public readonly reason: string,
  ) {
    super(`${file}: ${reason}`);
    this.name = 'SemanticLoadError';
  }
}

export interface LoadedSemanticRuntime {
  readonly embedder: Embedder & { readonly saturated: boolean };
  readonly warmupMs: number;
}

export type SemanticLoader = (cfg: SemanticConfig) => Promise<LoadedSemanticRuntime>;

export const SEMANTIC_LOADER = 'polyrouter:semantic-loader';

/** The slice of the onnxruntime-node module surface the loader consumes —
 * injectable so the full pipeline is testable in-process (jest's VM realms
 * break `instanceof` checks inside real ORT output wrapping; the REAL native
 * path is proven by the child-process integration test). */
export interface OrtLike {
  InferenceSession: {
    create(
      bytes: Uint8Array,
      opts: { executionProviders: string[] },
    ): Promise<import('./embed-core').InferenceLike>;
  };
  Tensor: new (
    type: string,
    data: BigInt64Array,
    dims: number[],
  ) => TensorLike;
}

/**
 * The real loader (D5): read the bundle (read-once — the same bytes are
 * hashed and parsed), dynamically import onnxruntime-node (the optional peer
 * — reached ONLY here, ONLY when `SEMANTIC_MODEL_PATH` is set), create the
 * session from the in-memory model bytes, run one warmup inference (first
 * ONNX call JITs — a request must never pay it), and return the bounded
 * embedder with its content-derived id.
 */
export const loadOnnxRuntime: SemanticLoader = (cfg) =>
  loadWithOrt(cfg, () => {
    // The ONLY reach into the optional peer. An instance without the flag
    // never executes this load; one without the package installed fails with
    // a named reason. Lazy `require` IS the CJS dynamic load (this package is
    // CommonJS); a native `import()` would demand --experimental-vm-modules
    // under jest while resolving identically for a CJS dependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('onnxruntime-node') as OrtLike;
  });

export const loadWithOrt = async (cfg: SemanticConfig, getOrt: () => OrtLike): Promise<LoadedSemanticRuntime> => {
  const dir = cfg.modelPath;
  if (dir === undefined) throw new SemanticLoadError('(unset)', 'SEMANTIC_MODEL_PATH is not set');

  const readBundleFile = async (relPath: string): Promise<Buffer> => {
    // Manifest file names are schema-constrained to flat names; this belt
    // guarantees containment even if that ever regresses (impl-clink Med-3).
    const abs = resolve(dir, relPath);
    if (!abs.startsWith(resolve(dir) + sep)) {
      throw new SemanticLoadError(basename(relPath), 'path escapes the bundle directory');
    }
    try {
      return await readFile(join(dir, relPath));
    } catch (err) {
      throw new SemanticLoadError(
        basename(relPath),
        err instanceof Error && 'code' in err ? String((err as { code?: string }).code) : 'unreadable',
      );
    }
  };

  const manifestBytes = await readBundleFile('manifest.json');
  let manifest;
  try {
    manifest = parseManifest(manifestBytes);
  } catch (err) {
    throw new SemanticLoadError('manifest.json', err instanceof Error ? err.message : 'invalid');
  }
  const vocabBytes = await readBundleFile(manifest.tokenizer.vocabFile);
  const modelBytes = await readBundleFile(manifest.model.file);

  const id = contentHashId(manifestBytes, [
    { relPath: manifest.tokenizer.vocabFile, bytes: vocabBytes },
    { relPath: manifest.model.file, bytes: modelBytes },
  ]);

  let tokenizer: WordPieceTokenizer;
  try {
    tokenizer = new WordPieceTokenizer(vocabBytes.toString('utf8'), manifest.tokenizer);
  } catch (err) {
    throw new SemanticLoadError(
      basename(manifest.tokenizer.vocabFile),
      err instanceof BundleError ? err.message : 'tokenizer construction failed',
    );
  }

  let ort: OrtLike;
  try {
    ort = getOrt();
  } catch (err) {
    throw new SemanticLoadError(
      'onnxruntime-node',
      `runtime failed to load (${err instanceof Error ? err.message : String(err)}) — install the optional peer (see docs) or unset SEMANTIC_MODEL_PATH`,
    );
  }

  let session: import('./embed-core').InferenceLike;
  try {
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['cpu'],
    });
  } catch (err) {
    throw new SemanticLoadError(
      basename(manifest.model.file),
      `session create failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  const makeTensor = (ids: readonly number[]): TensorLike =>
    new ort.Tensor(
      'int64',
      BigInt64Array.from(ids, (n) => BigInt(n)),
      [1, ids.length],
    );

  const core = {
    id,
    manifest,
    tokenizer,
    session,
    makeTensor,
    maxInputChars: cfg.maxInputChars,
    concurrency: cfg.concurrency,
  };

  // Warmup outside the request-path 50ms bound: the first inference JITs and
  // may legitimately take hundreds of ms. Same pipeline, generous bound.
  const warmupStart = Date.now();
  const warmup = buildEmbedder({ ...core, timeoutMs: 30_000 });
  try {
    await warmup.embed('polyrouter semantic warmup');
  } catch (err) {
    throw new SemanticLoadError(
      basename(manifest.model.file),
      `warmup inference failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
  const warmupMs = Date.now() - warmupStart;

  return { embedder: buildEmbedder({ ...core, timeoutMs: cfg.timeoutMs }), warmupMs };
};
