import type { SemanticCentroids } from './classify';

/**
 * Pure learning math (add-semantic-learning D5). No I/O, no Redis, no clock —
 * the sweep composes these; every one is unit-testable in isolation. Vectors
 * are unit-norm centroids; all outputs are unit-norm or a discriminated
 * degenerate signal (never a silent wrong vector).
 */

/** The two learning labels, derived from a settled cascade outcome. */
export type LearningLabel = 'high' | 'low';

/**
 * The label a settled cascade outcome teaches (add-semantic-learning): a
 * quality-passed cheap answer is a `low` exemplar; a quality-gate escalation
 * is a `high` exemplar; EVERYTHING else — provider faults (`cheap_error`),
 * cancellations, fail-open unknown quality — is NOT evidence.
 */
export function labelForOutcome(o: {
  escalated: boolean;
  status: string;
  qualitySignal: number | null | undefined;
  escalationSource: 'quality_gate' | 'cheap_error' | undefined;
}): LearningLabel | null {
  if (o.escalated) {
    return o.escalationSource === 'quality_gate' ? 'high' : null;
  }
  // Not escalated: a served answer with a decided (non-null) quality signal is
  // a genuine cheap-pass; a null signal is the fail-open unknown path (no
  // evidence), and a non-served status is not a pass.
  if (
    (o.status === 'success' || o.status === 'fallback') &&
    o.qualitySignal !== null &&
    o.qualitySignal !== undefined
  ) {
    return 'low';
  }
  return null;
}

const EPS = 1e-9;

function norm(v: Float32Array): number {
  let n = 0;
  for (const x of v) n += x * x;
  return Math.sqrt(n);
}

function dot(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d;
}

function unit(v: Float32Array): Float32Array | null {
  const n = norm(v);
  if (!Number.isFinite(n) || n < EPS) return null;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] ?? 0) / n;
  return out;
}

/**
 * EMA-fold a fresh evidence mean into the active centroid and renormalize:
 * `active' = normalize((1-alpha)·active + alpha·pendingMean)`. Returns null if
 * the result is degenerate (zero/non-finite) — the caller keeps the prior
 * centroid.
 */
export function foldEvidence(
  active: Float32Array,
  pendingMean: Float32Array,
  alpha: number,
): Float32Array | null {
  if (active.length !== pendingMean.length) return null;
  const mixed = new Float32Array(active.length);
  for (let i = 0; i < active.length; i += 1) {
    mixed[i] = (1 - alpha) * (active[i] ?? 0) + alpha * (pendingMean[i] ?? 0);
  }
  return unit(mixed);
}

/**
 * Clamp a learned centroid to at most `maxDrift` COSINE DISTANCE from its
 * bundled counterpart, by SPHERICAL interpolation (SLERP) onto the cap
 * boundary (clink set-Med-4). Both inputs are unit vectors. When the learned
 * centroid is within the cap it is returned unchanged; when it exceeds it, it
 * is rotated back along the geodesic to exactly the cap distance. The
 * antipodal degenerate case (bundled and learned diametrically opposed, no
 * unique geodesic) falls back to bundled outright.
 *
 * `maxDrift` is a cosine DISTANCE in [0, 1]: distance = 1 − cos(θ). The cap
 * angle is `acos(1 − maxDrift)`.
 */
export function clampDriftSpherical(
  learned: Float32Array,
  bundled: Float32Array,
  maxDrift: number,
): Float32Array {
  const lu = unit(learned);
  const bu = unit(bundled);
  if (lu === null || bu === null) return bundled;
  const cos = Math.max(-1, Math.min(1, dot(lu, bu)));
  const distance = 1 - cos;
  if (distance <= maxDrift) return lu; // already within the leash
  // Antipodal: no unique shortest geodesic → fall back to bundled.
  if (cos <= -1 + EPS) return bu;
  const theta = Math.acos(cos); // current angle between bundled and learned
  const capAngle = Math.acos(Math.max(-1, Math.min(1, 1 - maxDrift)));
  const t = capAngle / theta; // fraction along bundled→learned to stop at
  // SLERP(bundled, learned, t): sinθ can't be ~0 here (distance>maxDrift>0).
  const sinTheta = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / sinTheta;
  const w1 = Math.sin(t * theta) / sinTheta;
  const out = new Float32Array(lu.length);
  for (let i = 0; i < lu.length; i += 1) {
    out[i] = w0 * (bu[i] ?? 0) + w1 * (lu[i] ?? 0);
  }
  return unit(out) ?? bu;
}

/** Cosine distance (1 − cos) between two vectors, for audit scalars. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  const au = unit(a);
  const bu = unit(b);
  if (au === null || bu === null) return 1;
  return 1 - Math.max(-1, Math.min(1, dot(au, bu)));
}

/** Mean of a summed vector + count → unit-norm evidence mean, or null. */
export function evidenceMean(sum: Float32Array, count: number): Float32Array | null {
  if (count <= 0) return null;
  const mean = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i += 1) mean[i] = (sum[i] ?? 0) / count;
  return unit(mean);
}

/** Fold a fresh evidence mean per label into both bundled-anchored centroids,
 * each spherically drift-clamped. Labels with no fresh mean keep bundled. */
export function foldBothLabels(
  bundled: SemanticCentroids,
  active: SemanticCentroids | null,
  freshHigh: Float32Array | null,
  freshLow: Float32Array | null,
  alpha: number,
  maxDrift: number,
): SemanticCentroids {
  const base = active ?? bundled;
  const foldOne = (
    baseVec: Float32Array,
    bundledVec: Float32Array,
    fresh: Float32Array | null,
  ): Float32Array => {
    if (fresh === null) return baseVec;
    const folded = foldEvidence(baseVec, fresh, alpha);
    if (folded === null) return baseVec;
    return clampDriftSpherical(folded, bundledVec, maxDrift);
  };
  return {
    high: foldOne(base.high, bundled.high, freshHigh),
    low: foldOne(base.low, bundled.low, freshLow),
  };
}
