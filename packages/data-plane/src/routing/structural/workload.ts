/**
 * Structural WORKLOAD classification (add-workload-telemetry, Epic W). Pure:
 * maps the ALREADY-EXTRACTED Layer-1 feature vector to a categorical workload
 * verdict — what KIND of work the request carries, beside (not instead of)
 * the complexity score. No second scan, no tokenizer, no keyword matching
 * (invariant 9): every signal is an existing count/flag, so the classifier
 * inherits the feature extractor's boundaries (the bounded scan budget and the
 * chronological window walk) unchanged — pinned by its spec, not fixed here.
 *
 * Signals (design D3): `vision` ← an image block seen by the scan;
 * `structured` ← a declared machine-parseable OUTPUT format (deliberately NOT
 * tool-parameter schemas — tools-with-schemas is agentic/code traffic, not an
 * extraction workload); `code` ← fenced-code SHARE of the scanned window's
 * text at/above `codeShare` AND at least `codeMinChars` fenced chars (a share,
 * not L1's absolute `CODE_SAT`: a long prose document with one snippet is not
 * a code workload; the floor stops a 20-char window with a 10-char fence from
 * reading as 50% code). FIXED precedence when several fire — vision >
 * structured > code (capability-binding signals first); else `none`.
 *
 * The `reason` is numbers/flags only — never prompt text (invariant 8). The
 * classifier itself does not route: a verdict steers a request only through a
 * configured `auto_workload` target (add-workload-routing) — otherwise it is telemetry.
 */
import { createHash } from 'node:crypto';
import {
  STRUCTURAL_WORKLOAD_CLASSIFIER_VERSION,
  WORKLOAD_NONE,
  WORKLOAD_TAXONOMY_VERSION,
  type StructuralWorkloadClass,
} from '@polyrouter/shared';
import type { StructuralFeatures } from './features';

export interface WorkloadThresholds {
  /** Fenced-code share of the scanned window's text at/above which `code`
   * fires — in (0, 1]. */
  readonly codeShare: number;
  /** Absolute floor of fenced-code chars for `code` — a non-negative integer. */
  readonly codeMinChars: number;
}

/** Zero-tuning defaults (design D3): 30% fenced code with at least 200 chars. */
export const DEFAULT_WORKLOAD_THRESHOLDS: WorkloadThresholds = {
  codeShare: 0.3,
  codeMinChars: 200,
};

/** The tunable threshold keys (config validation rejects unknowns). */
export const WORKLOAD_THRESHOLD_KEYS: readonly (keyof WorkloadThresholds)[] = [
  'codeShare',
  'codeMinChars',
];

/** What the structural source can record: its three classes, or `none` — the
 * reserved semantic-only classes are unrepresentable here by type, not just by
 * the database's compatibility CHECK. */
export type StructuralWorkloadVerdictClass = StructuralWorkloadClass | typeof WORKLOAD_NONE;

export interface WorkloadVerdict {
  /** A taxonomy class the structural source can emit, or `none`. */
  readonly class: StructuralWorkloadVerdictClass;
  /** The recorded class's confidence in [0,1]: 1 for the binary classes, the
   * fenced-code share for `code`, 0 for `none`. */
  readonly score: number;
  readonly source: 'structural';
  /** `structural/<taxonomy v>/<classifier v>/<threshold digest>` — configuration
   * only, computed once at boot by the caller, never per request. */
  readonly revision: string;
  /** Numbers-only serialization (invariant 8). */
  readonly reason: string;
}

/** The pinned structural revision stamp (design D4): taxonomy version,
 * classifier version, and the first 12 hex chars of a SHA-256 over the
 * canonical (sorted-key) JSON of the effective thresholds. Deterministic for
 * equal thresholds regardless of the caller's key order; differs when any
 * threshold, the class list, or the classifier behavior version changes. Pure
 * over configuration — no request content ever reaches it. */
export function workloadRevision(t: WorkloadThresholds): string {
  const canonical = JSON.stringify(
    Object.fromEntries([...WORKLOAD_THRESHOLD_KEYS].sort().map((k) => [k, t[k]])),
  );
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `structural/${WORKLOAD_TAXONOMY_VERSION}/${STRUCTURAL_WORKLOAD_CLASSIFIER_VERSION}/${digest}`;
}

/** Coerce to a finite, non-negative number (NaN/±∞/undefined/negative → 0). */
function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function classifyWorkload(
  f: StructuralFeatures,
  t: WorkloadThresholds,
  revision: string,
): WorkloadVerdict {
  const chars = nonNeg(f.effectiveInputChars);
  const code = nonNeg(f.codeBlockChars);
  // Share of the scanned window's counted text inside fenced spans; a window
  // with no counted text has no share (0), never NaN.
  const share = chars > 0 ? Math.min(1, code / chars) : 0;
  const codeFires = share >= t.codeShare && code >= t.codeMinChars;
  const mm = f.multimodalPresent === true;
  const rf = f.responseFormatDemand === true;

  let cls: StructuralWorkloadVerdictClass;
  let score: number;
  if (mm) {
    cls = 'vision';
    score = 1;
  } else if (rf) {
    cls = 'structured';
    score = 1;
  } else if (codeFires) {
    cls = 'code';
    score = share;
  } else {
    cls = WORKLOAD_NONE;
    score = 0;
  }
  const reason =
    `workload:${cls} score=${score.toFixed(2)} share=${share.toFixed(2)} ` +
    `codechars=${String(Math.round(code))} mm=${mm ? 1 : 0} rf=${rf ? 1 : 0}`;
  return { class: cls, score, source: 'structural', revision, reason };
}
