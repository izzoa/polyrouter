/**
 * Layer-1 structural classifier (#13, spec §7.2). Pure: maps a feature vector
 * (baseline-subtracted on the size signal) to a band via saturating, weighted
 * sub-scores. Deterministic and language-neutral; the `reason` is a typed
 * serialization of numbers only — never raw prompt text (invariant 8).
 */
import type { StructuralFeatures } from './features';

/** Learned per-agent baseline (EWMA of effective input size). */
export interface StructuralBaseline {
  readonly ewma: number;
}

export interface StructuralWeights {
  readonly size: number;
  readonly code: number;
  readonly tools: number;
  readonly schema: number;
  readonly depth: number;
  readonly multimodal: number;
  readonly maxTokens: number;
}

/** The tunable feature keys (used by config validation to reject unknowns). */
export const STRUCTURAL_WEIGHT_KEYS: readonly (keyof StructuralWeights)[] = [
  'size',
  'code',
  'tools',
  'schema',
  'depth',
  'multimodal',
  'maxTokens',
];

/** Zero-tuning default weights (sum to 1). Size is capped at 0.30 so a long
 * prompt alone never forces the top tier — `high` needs multiple signals. */
export const DEFAULT_STRUCTURAL_WEIGHTS: StructuralWeights = {
  size: 0.3,
  code: 0.2,
  tools: 0.2,
  schema: 0.1,
  depth: 0.1,
  multimodal: 0.05,
  maxTokens: 0.05,
};

/** Saturation points: the value at which a sub-score reaches 1.0. */
export const SIZE_SAT = 8_000;
export const CODE_SAT = 4_000;
export const TOOLS_SAT = 8;
export const DEPTH_SAT = 20;
export const MAXTOK_SAT = 4_096;

export interface StructuralThresholds {
  readonly high: number;
  readonly low: number;
  readonly weights: StructuralWeights;
}

export type StructuralBand = 'high' | 'low' | 'ambiguous';

export interface StructuralVerdict {
  readonly band: StructuralBand;
  readonly score: number;
  readonly reason: string;
}

/** Coerce to a finite, non-negative number (NaN/±∞/undefined/negative → 0). */
function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Saturating sub-score in [0,1]. */
function sat(x: number, s: number): number {
  const v = nonNeg(x);
  return v <= 0 ? 0 : Math.min(1, v / s);
}

export function classifyStructural(
  f: StructuralFeatures,
  baseline: StructuralBaseline | null,
  opts: StructuralThresholds,
): StructuralVerdict {
  const w = opts.weights;
  const sizeDelta = nonNeg(f.effectiveInputChars) - (baseline ? nonNeg(baseline.ewma) : 0);
  const sub = {
    size: sat(sizeDelta, SIZE_SAT),
    code: sat(f.codeBlockChars, CODE_SAT),
    tools: sat(f.toolCount, TOOLS_SAT),
    schema: f.toolSchemaDemand ? 1 : 0,
    depth: sat(f.conversationDepth, DEPTH_SAT),
    multimodal: f.multimodalPresent ? 1 : 0,
    maxTokens: sat(f.maxOutputTokens, MAXTOK_SAT),
  };
  const score =
    w.size * sub.size +
    w.code * sub.code +
    w.tools * sub.tools +
    w.schema * sub.schema +
    w.depth * sub.depth +
    w.multimodal * sub.multimodal +
    w.maxTokens * sub.maxTokens;
  const band: StructuralBand =
    score >= opts.high ? 'high' : score <= opts.low ? 'low' : 'ambiguous';
  const reason =
    `structural:${band} score=${score.toFixed(2)} size=${sub.size.toFixed(2)} ` +
    `code=${sub.code.toFixed(2)} tools=${sub.tools.toFixed(2)} schema=${sub.schema.toFixed(2)} ` +
    `depth=${sub.depth.toFixed(2)} mm=${sub.multimodal.toFixed(2)} maxtok=${sub.maxTokens.toFixed(2)}`;
  return { band, score, reason };
}
