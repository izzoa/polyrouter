import type {
  SemanticWorkloadClass,
  StructuralWorkloadClass,
  WORKLOAD_NONE,
} from '@polyrouter/shared';

/** What the structural source can record: its three classes, or `none` — the
 * reserved semantic-only classes are unrepresentable here by type, not just by
 * the database's compatibility CHECK. */
export type StructuralWorkloadVerdictClass = StructuralWorkloadClass | typeof WORKLOAD_NONE;

/** What the semantic source can record: the reserved classes, or `none`. */
export type SemanticWorkloadVerdictClass = SemanticWorkloadClass | typeof WORKLOAD_NONE;

export interface StructuralWorkloadVerdict {
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

/** The SEMANTIC source's verdict (add-semantic-workloads D3): a reserved class
 * or `none`; the score is the winning cosine clamped to [0,1]; the revision is
 * `semantic/<taxonomy v>/<semantic classifier v>/<digest>`; the reason carries
 * class names and numbers only. */
export interface SemanticWorkloadVerdict {
  readonly class: SemanticWorkloadVerdictClass;
  readonly score: number;
  readonly source: 'semantic';
  readonly revision: string;
  readonly reason: string;
}

/** The workload verdict either source can produce — the proxy's stage, the
 * recorder, and the analytics read the common fields; the `source` literal
 * discriminates. */
export type WorkloadVerdict = StructuralWorkloadVerdict | SemanticWorkloadVerdict;
