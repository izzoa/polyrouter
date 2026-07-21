import { createHash } from 'node:crypto';

/**
 * The Layer-2 embedding seam (add-semantic-embedder). This is the ONLY surface
 * the semantic classifier consumes — the runtime behind it (local ONNX in the
 * control-plane, a deterministic stub in tests) is invisible to callers.
 *
 * Contract: `embed` resolves a unit-norm Float32Array of exactly `dims`
 * entries, or rejects typed (timeout, saturation, invalid output). It never
 * throws synchronously and never returns non-finite values. A real model's
 * `id` is a CONTENT-DERIVED revision (canonical hash over the model bundle),
 * so "same name, different weights" can never masquerade as the same
 * embedding space.
 */
export interface Embedder {
  readonly id: string;
  readonly dims: number;
  embed(text: string, opts?: { signal?: AbortSignal }): Promise<Float32Array>;
}

/**
 * Deterministic test embedder: SHA-256-seeded pseudo-vectors, unit-norm.
 * Same text → same vector, distinct texts → (overwhelmingly) distinct
 * vectors; no model, no I/O, no timing variance — the fake-adapter idiom.
 */
export function stubEmbedder(dims: number): Embedder {
  if (!Number.isInteger(dims) || dims < 2) {
    throw new Error('stubEmbedder dims must be an integer >= 2');
  }
  return {
    id: `stub:${String(dims)}`,
    dims,
    embed(text: string): Promise<Float32Array> {
      const out = new Float32Array(dims);
      // Stretch the digest across the vector by re-hashing with a counter.
      let filled = 0;
      let counter = 0;
      while (filled < dims) {
        const digest = createHash('sha256')
          .update(text)
          .update(Buffer.from([counter & 0xff]))
          .digest();
        for (let i = 0; i + 4 <= digest.length && filled < dims; i += 4) {
          // Signed 32-bit int scaled to [-1, 1): deterministic, well-spread.
          out[filled] = digest.readInt32BE(i) / 0x80000000;
          filled += 1;
        }
        counter += 1;
      }
      let norm = 0;
      for (const v of out) norm += v * v;
      norm = Math.sqrt(norm);
      // A zero digest is cryptographically unreachable; guard anyway.
      if (norm === 0) out[0] = 1;
      else for (let i = 0; i < dims; i += 1) out[i] = (out[i] ?? 0) / norm;
      return Promise.resolve(out);
    },
  };
}
