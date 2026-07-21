import type { Embedder } from '@polyrouter/data-plane';
import {
  BundleError,
  meanPoolNormalize,
  validateVector,
  type BundleManifest,
  type WordPieceTokenizer,
} from './bundle';
import { TrySemaphore } from './semaphore';

/** Typed embed failure. `message` carries timings/dimensions/reasons ONLY —
 * never input text, never vector values (D9). */
export class EmbedError extends Error {
  constructor(
    public readonly kind:
      | 'saturated'
      | 'timeout'
      | 'aborted'
      | 'invalid_output'
      | 'runtime',
    message: string,
  ) {
    super(message);
    this.name = 'EmbedError';
  }
}

/** The narrow slice of an ORT session the embed path uses — fake-able in tests. */
export interface InferenceLike {
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike | undefined>>;
}

export interface TensorLike {
  readonly data: ArrayLike<number | bigint>;
  readonly dims: readonly number[];
}

export type TensorFactory = (
  ids: readonly number[],
  name: 'input_ids' | 'attention_mask' | 'token_type_ids',
) => TensorLike;

export interface EmbedCoreOptions {
  readonly id: string;
  readonly manifest: BundleManifest;
  readonly tokenizer: WordPieceTokenizer;
  readonly session: InferenceLike;
  readonly makeTensor: TensorFactory;
  readonly timeoutMs: number;
  readonly maxInputChars: number;
  readonly concurrency: number;
}

/**
 * The bounded embed pipeline (D6): deadline opens on ENTRY (before
 * tokenization); admission is tryAcquire/no-queue; the permit is released
 * only when the RAW inference settles; late settlement is consumed; timers
 * and abort listeners are always cleared. Output is validated (declared
 * dims, finite, unit norm) before it reaches the caller.
 */
export function buildEmbedder(opts: EmbedCoreOptions): Embedder & { readonly saturated: boolean } {
  const sem = new TrySemaphore(opts.concurrency);
  const { manifest, tokenizer } = opts;
  const dims = manifest.model.dims;

  const runOnce = (
    text: string,
    deadline: number,
  ): { raw: Promise<Float32Array>; release: () => void } | null => {
    const release = sem.tryAcquire();
    if (release === null) return null;
    try {
      const capped = text.length > opts.maxInputChars ? text.slice(0, opts.maxInputChars) : text;
      const enc = tokenizer.encode(capped);
      // Deadline accounting covers preprocessing (impl-clink Med-1): when
      // tokenization ate the whole budget, no native call ever starts.
      if (Date.now() > deadline) {
        throw new EmbedError('timeout', 'deadline exceeded during preprocessing');
      }
      const feeds: Record<string, TensorLike> = {
        [manifest.model.inputNames.inputIds]: opts.makeTensor(enc.ids, 'input_ids'),
        [manifest.model.inputNames.attentionMask]: opts.makeTensor(
          enc.attentionMask,
          'attention_mask',
        ),
      };
      const tt = manifest.model.inputNames.tokenTypeIds;
      if (tt !== undefined) {
        feeds[tt] = opts.makeTensor(enc.ids.map(() => 0), 'token_type_ids');
      }
      const raw = opts.session.run(feeds).then((results) => {
        const out = results[manifest.model.outputName];
        if (out === undefined) {
          throw new EmbedError(
            'invalid_output',
            `model output "${manifest.model.outputName}" missing from results`,
          );
        }
        // Exact-shape enforcement (impl-clink High-1): a wrong layout must
        // never pool into a plausible unit vector — dims AND data length are
        // checked against the encoded sequence before any math runs.
        const seq = enc.ids.length;
        const shape = out.dims;
        if (manifest.model.outputKind === 'token_embeddings') {
          if (shape.length !== 3 || shape[0] !== 1 || shape[1] !== seq || shape[2] !== dims) {
            throw new EmbedError(
              'invalid_output',
              `expected output shape [1,${String(seq)},${String(dims)}], got [${shape.join(',')}]`,
            );
          }
        } else if (shape.length !== 2 || shape[0] !== 1 || shape[1] !== dims) {
          throw new EmbedError(
            'invalid_output',
            `expected pooled output shape [1,${String(dims)}], got [${shape.join(',')}]`,
          );
        }
        const expectedLen = manifest.model.outputKind === 'token_embeddings' ? seq * dims : dims;
        if (out.data.length !== expectedLen) {
          throw new EmbedError(
            'invalid_output',
            `output data length ${String(out.data.length)} does not match shape (expected ${String(expectedLen)})`,
          );
        }
        const data = Float32Array.from(out.data as ArrayLike<number>);
        const vec =
          manifest.model.outputKind === 'token_embeddings'
            ? meanPoolNormalize(data, seq, dims, enc.attentionMask)
            : data;
        validateVector(vec, dims);
        return vec;
      });
      // Permit follows the RAW settle — a timed-out caller unbinds, the
      // permit does not (orphaned native work capped at semaphore width).
      raw.then(release, release);
      return { raw, release };
    } catch (err) {
      // Tokenization/feed construction failed before any native call started.
      release();
      throw err;
    }
  };

  return {
    id: opts.id,
    dims,
    get saturated(): boolean {
      return sem.saturated;
    },
    embed(text: string, embedOpts?: { signal?: AbortSignal }): Promise<Float32Array> {
      const deadline = Date.now() + opts.timeoutMs;
      const signal = embedOpts?.signal;

      return new Promise<Float32Array>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined = undefined;
        const onAbort = (): void => {
          finish(() => {
            reject(new EmbedError('aborted', 'aborted by caller'));
          });
        };
        const finish = (act: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          act();
        };
        // Listener BEFORE any work (impl-clink Med-1): an abort landing
        // between admission and the race can never be missed.
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          finish(() => {
            reject(new EmbedError('aborted', 'aborted before start'));
          });
          return;
        }

        let admitted;
        try {
          admitted = runOnce(text, deadline);
        } catch (err) {
          finish(() => {
            reject(
              err instanceof EmbedError
                ? err
                : new EmbedError('runtime', `embed setup failed: ${reasonOf(err)}`),
            );
          });
          return;
        }
        if (admitted === null) {
          finish(() => {
            reject(
              new EmbedError(
                'saturated',
                `inference saturated (width ${String(opts.concurrency)})`,
              ),
            );
          });
          return;
        }
        const { raw } = admitted;
        // If the race is lost, nobody awaits `raw` — consume the late rejection.
        raw.catch(() => undefined);
        if (settled) return; // aborted during admission — raw settles on its own

        timer = setTimeout(
          () => {
            finish(() => {
              reject(
                new EmbedError('timeout', `embed exceeded ${String(opts.timeoutMs)}ms bound`),
              );
            });
          },
          Math.max(1, deadline - Date.now()),
        );
        raw.then(
          (vec) => {
            finish(() => {
              resolve(vec);
            });
          },
          (err: unknown) => {
            finish(() => {
              reject(
                err instanceof EmbedError
                  ? err
                  : err instanceof BundleError
                    ? new EmbedError('invalid_output', err.message)
                    : new EmbedError('runtime', `inference failed: ${reasonOf(err)}`),
              );
            });
          },
        );
      });
    },
  };
}

/** Extract a loggable reason WITHOUT ever including model inputs/outputs. */
function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err;
}
