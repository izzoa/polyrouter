/**
 * The Layer-2 classifier core (add-semantic-routing D2): pure cosine
 * three-band classification over unit-norm centroids. Degenerate inputs are
 * a DISCRIMINATED `invalid` — never a band, never telemetry (clink r1
 * Med-1); the caller maps `invalid` to its fault path (skip).
 */

export type SemanticBand = 'high' | 'low' | 'ambiguous';

export interface SemanticCentroids {
  readonly high: Float32Array;
  readonly low: Float32Array;
}

export interface SemanticThresholds {
  /** score ≥ high → band high (positive, inclusive). */
  readonly high: number;
  /** score ≤ −low → band low (positive, inclusive). */
  readonly low: number;
}

export type SemanticClassification =
  | {
      readonly kind: 'band';
      readonly band: SemanticBand;
      /** clamp(cos(v, high)) − clamp(cos(v, low)) ∈ [-2, 2]. */
      readonly score: number;
      readonly simHigh: number;
      readonly simLow: number;
    }
  | { readonly kind: 'invalid'; readonly reason: string };

const clamp1 = (x: number): number => (x > 1 ? 1 : x < -1 ? -1 : x);

function dot(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d;
}

function isFiniteVec(v: Float32Array): boolean {
  for (const x of v) if (!Number.isFinite(x)) return false;
  return true;
}

export function classifySemantic(
  vector: Float32Array,
  centroids: SemanticCentroids,
  thresholds: SemanticThresholds,
): SemanticClassification {
  const dims = centroids.high.length;
  if (centroids.low.length !== dims) return { kind: 'invalid', reason: 'centroid dims differ' };
  if (vector.length !== dims) {
    return {
      kind: 'invalid',
      reason: `vector dims ${String(vector.length)} != centroid dims ${String(dims)}`,
    };
  }
  if (!isFiniteVec(vector)) return { kind: 'invalid', reason: 'non-finite vector' };
  let norm = 0;
  for (const x of vector) norm += x * x;
  if (norm === 0) return { kind: 'invalid', reason: 'zero-norm vector' };

  const simHigh = clamp1(dot(vector, centroids.high));
  const simLow = clamp1(dot(vector, centroids.low));
  if (!Number.isFinite(simHigh) || !Number.isFinite(simLow)) {
    return { kind: 'invalid', reason: 'non-finite similarity' };
  }
  const score = simHigh - simLow;
  const band: SemanticBand =
    score >= thresholds.high ? 'high' : score <= -thresholds.low ? 'low' : 'ambiguous';
  return { kind: 'band', band, score, simHigh, simLow };
}

/**
 * Boot-time centroid validation (D5): unit-norm within tolerance and
 * NON-CANCELLING (near-identical centroids make every score ≈ 0 — a broken
 * anchor set must fail boot, not silently classify everything ambiguous).
 */
export function validateCentroids(c: SemanticCentroids, dims: number): void {
  const check = (v: Float32Array, name: string): void => {
    if (v.length !== dims) throw new Error(`${name} centroid has ${String(v.length)} dims, expected ${String(dims)}`);
    let norm = 0;
    for (const x of v) {
      if (!Number.isFinite(x)) throw new Error(`${name} centroid contains a non-finite value`);
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (Math.abs(norm - 1) > 1e-3) throw new Error(`${name} centroid is not unit-norm (|v|=${norm.toFixed(6)})`);
  };
  check(c.high, 'high');
  check(c.low, 'low');
  const sim = clamp1(dot(c.high, c.low));
  if (sim > 0.999) throw new Error(`centroids nearly cancel (cos=${sim.toFixed(6)}) — anchor sets do not separate`);
}
