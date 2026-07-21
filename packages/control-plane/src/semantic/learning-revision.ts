import { createHash } from 'node:crypto';

/**
 * The learning-evidence revision (add-semantic-learning D7, clink r1 Med-1) —
 * DISTINCT from change 2's `computeRevision`. That one includes the active
 * centroid source/revision and so advances every time learned centroids
 * advance; reusing it would wrongly invalidate a tenant's own pending evidence
 * the moment its centroids move. This digest instead captures ONLY what
 * changes the MEANING of a label: the embedding space, the classifier inputs,
 * and — crucially — the cheap-route/quality-gate configuration the labels were
 * judged under. A `low` label means "the cheap tier THIS tenant configured
 * sufficed"; if `auto_low` or the quality gate changes, old evidence no longer
 * means the same thing and must not mix.
 *
 * Bumped deliberately when the gate algorithm changes.
 */
export const QUALITY_GATE_ALGO_VERSION = 1;

export interface LearningEvidenceInputs {
  readonly embedderId: string;
  readonly dims: number;
  readonly anchorSetId: string;
  readonly extractorVersion: number;
  readonly highThreshold: number;
  readonly lowThreshold: number;
  readonly qualityThreshold: number;
  /** The resolved ordered `auto_low` (cheap) decision chain — the tier key and
   * the ordered model ids the cheap answer would actually come from. A change
   * here changes what a `low` label attests to. Empty when unresolvable (a
   * tenant with no cheap target generates no cascade evidence anyway). */
  readonly autoLowChain: readonly string[];
}

export function computeLearningEvidenceRevision(input: LearningEvidenceInputs): string {
  const h = createHash('sha256');
  h.update('polyrouter-learning-evidence-v1\0');
  const part = (s: string): void => {
    h.update(s);
    h.update('\0');
  };
  part(input.embedderId);
  part(String(input.dims));
  part(input.anchorSetId);
  part(String(input.extractorVersion));
  part(input.highThreshold.toFixed(4));
  part(input.lowThreshold.toFixed(4));
  part(`qg${String(QUALITY_GATE_ALGO_VERSION)}`);
  part(input.qualityThreshold.toFixed(4));
  part('chain');
  for (const m of input.autoLowChain) part(m);
  return `sha256:${h.digest('hex').slice(0, 32)}`;
}
