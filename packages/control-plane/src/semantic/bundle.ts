import { createHash } from 'node:crypto';
import { z } from '@polyrouter/shared';

/**
 * The v1 model-bundle contract (add-semantic-embedder D3). A bundle is a
 * directory: `manifest.json` + the files it declares. onnxruntime consumes
 * tensor feeds — nothing in it turns text into `input_ids` — so the manifest
 * carries the WHOLE preprocessing story: tokenizer algorithm (v1 supports
 * exactly `wordpiece`, the BERT-family algorithm MiniLM/bge-small use),
 * special tokens, truncation, tensor names, pooling and normalization.
 * Anything undeclarable fails load with a named reason — a BYO model with a
 * different tokenizer gets a loud error, never silently-wrong vectors.
 */
/** Declared files are FLAT names inside the bundle directory — no separators,
 * no traversal, no absolute paths (impl-clink Med-3). */
const bundleFileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'must be a flat bundle file name')
  .refine((n) => n !== 'manifest.json' && !n.includes('..'), {
    message: 'must not be manifest.json or contain ..',
  });

export const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    tokenizer: z.strictObject({
      type: z.literal('wordpiece'),
      vocabFile: bundleFileName,
      lowercase: z.boolean(),
      unkToken: z.string().min(1),
      clsToken: z.string().min(1),
      sepToken: z.string().min(1),
      padToken: z.string().min(1),
      maxTokens: z.number().int().min(8).max(512),
    }),
    model: z.strictObject({
      file: bundleFileName,
      inputNames: z.strictObject({
        inputIds: z.string().min(1),
        attentionMask: z.string().min(1),
        tokenTypeIds: z.string().min(1).optional(),
      }),
      outputName: z.string().min(1),
      /** `token_embeddings`: [batch, seq, dims] → mean-pool over the attention
       * mask. `pooled`: [batch, dims] used as-is. */
      outputKind: z.enum(['token_embeddings', 'pooled']),
      dims: z.number().int().min(8).max(4096),
      pooling: z.literal('mean'),
      normalize: z.literal(true),
    }),
  })
  // Distinct input tensor names (impl-clink High-1): identical names would
  // let one feed silently overwrite another.
  .refine(
    (m) => {
      const names = [
        m.model.inputNames.inputIds,
        m.model.inputNames.attentionMask,
        ...(m.model.inputNames.tokenTypeIds === undefined ? [] : [m.model.inputNames.tokenTypeIds]),
      ];
      return new Set(names).size === names.length;
    },
    { message: 'model.inputNames must be distinct', path: ['model', 'inputNames'] },
  )
  .refine((m) => m.tokenizer.vocabFile !== m.model.file, {
    message: 'tokenizer.vocabFile and model.file must differ',
    path: ['model', 'file'],
  });

export type BundleManifest = z.infer<typeof manifestSchema>;

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/** Parse + validate manifest bytes; errors name the field, never file contents. */
export function parseManifest(bytes: Buffer): BundleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new BundleError('manifest.json is not valid JSON');
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new BundleError(`manifest.json is not a valid v1 bundle manifest — ${issues}`);
  }
  return result.data;
}

/**
 * Content-derived embedder revision (D4, clink r1 Med-5): a versioned
 * canonical SHA-256 construction — schema-version prefix, then the manifest,
 * then every declared file sorted by relative path; each contribution is
 * `relPath \0 byteLength \0 bytes`. Same bytes at a different mount path hash
 * identically; any byte change anywhere changes the id.
 */
export function contentHashId(
  manifestBytes: Buffer,
  files: ReadonlyArray<{ relPath: string; bytes: Buffer }>,
): string {
  const h = createHash('sha256');
  h.update('polyrouter-embedder-bundle-v1\0');
  const entry = (relPath: string, bytes: Buffer): void => {
    h.update(relPath);
    h.update('\0');
    h.update(String(bytes.length));
    h.update('\0');
    h.update(bytes);
  };
  entry('manifest.json', manifestBytes);
  for (const f of [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : 1))) {
    entry(f.relPath, f.bytes);
  }
  return `sha256:${h.digest('hex')}`;
}

/** Encoded single-sequence input: `[CLS] tokens… [SEP]`, hard-truncated. */
export interface EncodedInput {
  readonly ids: number[];
  /** All ones — no padding is emitted for single-sequence inference. */
  readonly attentionMask: number[];
}

/**
 * Minimal, dependency-free WordPiece tokenizer (D3): NFC normalization,
 * optional lowercasing, whitespace + punctuation pre-tokenization (each
 * punctuation character is its own word — the BERT BasicTokenizer rule),
 * then greedy longest-match-first over the vocab with `##` continuation;
 * an unmatchable word maps to `unkToken`. Golden tests pin exact id
 * sequences — any drift from this declared algorithm is a test failure,
 * not a silent re-embedding of the space.
 */
export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly unkId: number;
  private readonly clsId: number;
  private readonly sepId: number;
  private readonly lowercase: boolean;
  private readonly maxTokens: number;
  /** Longest vocab entry, bounding the greedy-match window. */
  private readonly maxWordChars: number;

  constructor(vocabText: string, cfg: BundleManifest['tokenizer']) {
    this.vocab = new Map();
    const lines = vocabText.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const tok = (lines[i] ?? '').replace(/\r$/, '');
      if (tok.length > 0 && !this.vocab.has(tok)) this.vocab.set(tok, i);
    }
    const req = (name: string, tok: string): number => {
      const id = this.vocab.get(tok);
      if (id === undefined) throw new BundleError(`vocab is missing the declared ${name} ("${tok}")`);
      return id;
    };
    this.unkId = req('unkToken', cfg.unkToken);
    this.clsId = req('clsToken', cfg.clsToken);
    this.sepId = req('sepToken', cfg.sepToken);
    req('padToken', cfg.padToken);
    this.lowercase = cfg.lowercase;
    this.maxTokens = cfg.maxTokens;
    let max = 1;
    for (const key of this.vocab.keys()) max = Math.max(max, key.length);
    this.maxWordChars = max;
  }

  get vocabSize(): number {
    return this.vocab.size;
  }

  encode(text: string): EncodedInput {
    let s = text.normalize('NFC');
    if (this.lowercase) s = s.toLowerCase();
    const ids: number[] = [this.clsId];
    const budget = this.maxTokens - 1; // reserve the trailing [SEP]
    outer: for (const word of splitWords(s)) {
      for (const id of this.wordPiece(word)) {
        if (ids.length >= budget) break outer;
        ids.push(id);
      }
    }
    ids.push(this.sepId);
    return { ids, attentionMask: ids.map(() => 1) };
  }

  /** Greedy longest-match-first; whole word → unk when any piece is unmatchable.
   * Words longer than MAX_WORD_CHARS map to unk wholesale — the DECLARED
   * fixed guard, matching BERT's conventional max_input_chars_per_word=100
   * (impl-clink Med-2; the previous vocab-derived dynamic guard was neither). */
  private wordPiece(word: string): number[] {
    if (word.length > MAX_WORD_CHARS) return [this.unkId];
    const pieces: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = Math.min(word.length, start + this.maxWordChars);
      let match: number | undefined;
      while (end > start) {
        const piece = (start === 0 ? '' : '##') + word.slice(start, end);
        const id = this.vocab.get(piece);
        if (id !== undefined) {
          match = id;
          break;
        }
        end -= 1;
      }
      if (match === undefined) return [this.unkId];
      pieces.push(match);
      start = end;
    }
    return pieces;
  }
}

/** BERT's conventional per-word length guard: longer words map to [UNK]. */
const MAX_WORD_CHARS = 100;

/** Whitespace split, then each punctuation char becomes its own word. */
function splitWords(s: string): string[] {
  const words: string[] = [];
  for (const chunk of s.split(/\s+/u)) {
    if (chunk === '') continue;
    let current = '';
    for (const ch of chunk) {
      if (isPunctuation(ch)) {
        if (current !== '') {
          words.push(current);
          current = '';
        }
        words.push(ch);
      } else {
        current += ch;
      }
    }
    if (current !== '') words.push(current);
  }
  return words;
}

/** The DECLARED punctuation rule (impl-clink Med-2), matching BERT's
 * `_is_punctuation`: the four ASCII bands (33–47, 58–64, 91–96, 123–126 —
 * which include ASCII symbols like `$` and `+`) plus Unicode category P.
 * Non-ASCII symbols (currency signs, emoji) are NOT split — they stay part
 * of the word (and typically resolve to [UNK]). */
function isPunctuation(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(ch);
}

/**
 * Mean-pool token embeddings `[seq, dims]` over the attention mask, then
 * L2-normalize (the manifest declares `pooling: mean`, `normalize: true`).
 * Rejects (throws BundleError) on non-finite output — the caller treats it
 * as an embed failure (fail-open upstream).
 */
export function meanPoolNormalize(
  data: Float32Array,
  seqLen: number,
  dims: number,
  attentionMask: readonly number[],
): Float32Array {
  const out = new Float32Array(dims);
  let count = 0;
  for (let t = 0; t < seqLen; t += 1) {
    if ((attentionMask[t] ?? 0) === 0) continue;
    count += 1;
    const base = t * dims;
    for (let d = 0; d < dims; d += 1) out[d] = (out[d] ?? 0) + (data[base + d] ?? 0);
  }
  if (count === 0) throw new BundleError('empty attention mask — nothing to pool');
  for (let d = 0; d < dims; d += 1) out[d] = (out[d] ?? 0) / count;
  return l2Normalize(out);
}

/** L2-normalize in place; throws on zero/non-finite norm. */
export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new BundleError('embedding norm is zero or non-finite');
  }
  for (let i = 0; i < vec.length; i += 1) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

/** Post-inference vector validation (D6): declared dims, finite, unit norm. */
export function validateVector(vec: Float32Array, dims: number): void {
  if (vec.length !== dims) {
    throw new BundleError(
      `model produced ${String(vec.length)} dims, manifest declares ${String(dims)}`,
    );
  }
  let norm = 0;
  for (const v of vec) {
    if (!Number.isFinite(v)) throw new BundleError('model produced a non-finite value');
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (Math.abs(norm - 1) > 1e-3) {
    throw new BundleError(`embedding is not unit-norm (|v| = ${norm.toFixed(6)})`);
  }
}
