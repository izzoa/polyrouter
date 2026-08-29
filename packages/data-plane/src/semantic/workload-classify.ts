import { CentroidValidationError } from './classify';
import { createHash } from 'node:crypto';
import {
  SEMANTIC_WORKLOAD_CLASSES,
  SEMANTIC_WORKLOAD_CLASSIFIER_VERSION,
  WORKLOAD_CLASSES,
  WORKLOAD_NONE,
  WORKLOAD_TAXONOMY_VERSION,
  type SemanticWorkloadClass,
  type WorkloadClass,
} from '@polyrouter/shared';
import type {
  SemanticWorkloadVerdict,
  SemanticWorkloadVerdictClass,
} from '../routing/workload-verdict';

/**
 * The SEMANTIC workload classifier core (add-semantic-workloads D1). Pure:
 * cosine of a unit-norm request vector against one unit-norm centroid per
 * taxonomy class; argmax over ALL FIVE; the verdict is the winning class ONLY
 * when it is a reserved class (research / writing) AND it leads the runner-up
 * by at least `margin` AND its similarity is at least `minSim` — otherwise
 * `none`. The structural classes' centroids exist so a reserved class is
 * claimed only when it also beats them; this source never emits one of them.
 * Degenerate inputs are a DISCRIMINATED `invalid` — never a verdict, never
 * telemetry (the caller maps it to its fault path).
 */

export type WorkloadCentroids = Readonly<Record<WorkloadClass, Float32Array>>;

export interface SemanticWorkloadRails {
  /** Required lead of the winning cosine over the runner-up, in [0.01, 1]. */
  readonly margin: number;
  /** Required winning cosine (a near-orthogonal guard), in [0, 1]. */
  readonly minSim: number;
}

export type SemanticWorkloadClassification =
  | {
      readonly kind: 'verdict';
      readonly class: SemanticWorkloadVerdictClass;
      /** The winning cosine clamped to [0,1] — the recorded score, for `none` too. */
      readonly score: number;
      readonly top: WorkloadClass;
      readonly second: WorkloadClass;
      readonly topSim: number;
      readonly secondSim: number;
      readonly margin: number;
      readonly sims: Readonly<Record<WorkloadClass, number>>;
    }
  | { readonly kind: 'invalid'; readonly reason: string };

const clamp1 = (x: number): number => (x > 1 ? 1 : x < -1 ? -1 : x);
const clamp01 = (x: number): number => (x > 1 ? 1 : x < 0 ? 0 : x);

function dot(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d;
}

function isFiniteVec(v: Float32Array): boolean {
  for (const x of v) if (!Number.isFinite(x)) return false;
  return true;
}

const RESERVED: ReadonlySet<string> = new Set(SEMANTIC_WORKLOAD_CLASSES);

export function classifySemanticWorkload(
  vector: Float32Array,
  centroids: WorkloadCentroids,
  rails: SemanticWorkloadRails,
): SemanticWorkloadClassification {
  const dims = vector.length;
  if (dims === 0) return { kind: 'invalid', reason: 'empty vector' };
  if (!isFiniteVec(vector)) return { kind: 'invalid', reason: 'non-finite vector' };
  let norm = 0;
  for (const x of vector) norm += x * x;
  if (norm === 0) return { kind: 'invalid', reason: 'zero-norm vector' };
  const sims: Partial<Record<WorkloadClass, number>> = {};
  for (const cls of WORKLOAD_CLASSES) {
    const c = centroids[cls];
    if (c.length !== dims) {
      return {
        kind: 'invalid',
        reason: `centroid ${cls} dims ${String(c.length)} != vector dims ${String(dims)}`,
      };
    }
    const sim = clamp1(dot(vector, c));
    if (!Number.isFinite(sim))
      return { kind: 'invalid', reason: `non-finite similarity for ${cls}` };
    sims[cls] = sim;
  }
  // Deterministic order: similarity desc, then the taxonomy order as the tie-break
  // (a tie yields margin 0, which no rail ≥ 0.01 accepts → `none`).
  const ranked = [...WORKLOAD_CLASSES].sort((a, b) => (sims[b] ?? 0) - (sims[a] ?? 0));
  const top = ranked[0]!;
  const second = ranked[1]!;
  const topSim = sims[top] ?? 0;
  const secondSim = sims[second] ?? 0;
  const margin = topSim - secondSim;
  const emits = RESERVED.has(top) && margin >= rails.margin && topSim >= rails.minSim;
  // The SCORE is the winning cosine whatever the rails decide (D3): an
  // abstention keeps its real confidence so the telemetry that tunes the rails
  // is never a fabricated zero — only the emitted CLASS is conditional.
  return {
    kind: 'verdict',
    class: emits ? (top as SemanticWorkloadClass) : WORKLOAD_NONE,
    score: clamp01(topSim),
    top,
    second,
    topSim,
    secondSim,
    margin,
    sims: sims as Record<WorkloadClass, number>,
  };
}

/**
 * Boot-time validation of the five workload centroids (D4): every taxonomy
 * class present, unit-norm within tolerance, finite, and mutually
 * NON-CANCELLING (no pairwise cosine above the bound) — a broken anchor set
 * must disable ONLY this source, loudly, never classify everything `none`.
 */
export function validateWorkloadCentroids(
  centroids: Partial<Record<WorkloadClass, Float32Array>>,
  dims: number,
): asserts centroids is WorkloadCentroids {
  for (const cls of WORKLOAD_CLASSES) {
    const v = centroids[cls];
    if (v === undefined) throw new CentroidValidationError(`workload centroid ${cls} is missing`);
    if (v.length !== dims) {
      throw new CentroidValidationError(
        `workload centroid ${cls} has ${String(v.length)} dims, expected ${String(dims)}`,
      );
    }
    let norm = 0;
    for (const x of v) {
      if (!Number.isFinite(x))
        throw new CentroidValidationError(`workload centroid ${cls} contains a non-finite value`);
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (Math.abs(norm - 1) > 1e-3) {
      throw new CentroidValidationError(
        `workload centroid ${cls} is not unit-norm (|v|=${norm.toFixed(6)})`,
      );
    }
  }
  for (let i = 0; i < WORKLOAD_CLASSES.length; i += 1) {
    for (let j = i + 1; j < WORKLOAD_CLASSES.length; j += 1) {
      const a = WORKLOAD_CLASSES[i]!;
      const b = WORKLOAD_CLASSES[j]!;
      const sim = clamp1(dot(centroids[a]!, centroids[b]!));
      if (sim >= 0.999) {
        throw new CentroidValidationError(
          `workload centroids ${a} and ${b} nearly cancel (cos=${sim.toFixed(6)}) — anchor sets do not separate`,
        );
      }
    }
  }
}

export interface SemanticWorkloadRevisionInputs {
  /** The embedder's content-derived id. */
  readonly embedderId: string;
  readonly anchorSetId: string;
  readonly anchorContentHash: string;
  readonly extractorVersion: number;
  readonly margin: number;
  readonly minSim: number;
}

/** `semantic/<taxonomy v>/<semantic classifier v>/<12 hex>` — a digest over the
 * canonical (sorted-key) JSON of the inputs: deterministic for equal inputs
 * whatever the caller's key order; different when any input changes. Pure
 * over configuration — no request content ever reaches it. */
export function semanticWorkloadRevision(inputs: SemanticWorkloadRevisionInputs): string {
  const keys = Object.keys(inputs).sort() as (keyof SemanticWorkloadRevisionInputs)[];
  const canonical = JSON.stringify(Object.fromEntries(keys.map((k) => [k, inputs[k]])));
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `semantic/${WORKLOAD_TAXONOMY_VERSION}/${SEMANTIC_WORKLOAD_CLASSIFIER_VERSION}/${digest}`;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Build the recorded verdict from a classification (numbers + class names
 * only in the reason — invariant 8). */
export function semanticWorkloadVerdict(
  c: Extract<SemanticWorkloadClassification, { kind: 'verdict' }>,
  revision: string,
): SemanticWorkloadVerdict {
  const score = round4(c.score);
  const reason =
    `workload:${c.class} score=${score.toFixed(4)} m=${round4(c.margin).toFixed(4)} ` +
    `sim2=${round4(c.secondSim).toFixed(4)} top=${c.top} top2=${c.second} src=semantic`;
  return { class: c.class, score, source: 'semantic', revision, reason };
}
