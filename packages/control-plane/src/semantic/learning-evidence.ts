import { resolveBandTarget, type RoutingSnapshot } from '@polyrouter/data-plane';
import { computeLearningEvidenceRevision } from './learning-revision';
import type { LearningProvenance } from './semantic-classifier.service';

/**
 * Resolve a tenant's learning-evidence revision (add-semantic-learning D7). The
 * digest combines the classifier-side provenance (embedder, anchors, extractor,
 * thresholds), the quality-gate threshold, and the tenant's resolved `auto_low`
 * chain — a `low` label means "the cheap tier THIS tenant configured sufficed,"
 * so a changed cheap route changes what the label attests to.
 *
 * This is the SHARED contract the sweep (task 4.2) and the hot-path gate (task
 * 2.2) both compute from — the sweep from a freshly loaded snapshot, the gate
 * from resolvePlan's — so the accumulator's revision-stamped pending buckets and
 * the sweep's rotate always agree.
 */

/** The resolved ordered `auto_low` (cheap) chain: the tier key + the ordered model
 * ids the cheap answer would come from. Empty when no cheap target resolves (such
 * a tenant generates no cascade evidence anyway). The `layer`/`reason` passed to
 * `resolveBandTarget` do not affect the returned `tierKey`/`chain`. */
export function resolveAutoLowChain(snapshot: RoutingSnapshot): readonly string[] {
  const decision = resolveBandTarget(snapshot, 'auto_low', 'cascade', 'learning-revision');
  if (decision === null) return [];
  return [decision.tierKey ?? '', ...decision.chain.map((t) => t.modelId)];
}

export function resolveLearningEvidenceRevision(
  snapshot: RoutingSnapshot,
  provenance: LearningProvenance,
  qualityThreshold: number,
): string {
  return computeLearningEvidenceRevision({
    embedderId: provenance.embedderId,
    dims: provenance.dims,
    anchorSetId: provenance.anchorSetId,
    extractorVersion: provenance.extractorVersion,
    highThreshold: provenance.highThreshold,
    lowThreshold: provenance.lowThreshold,
    qualityThreshold,
    autoLowChain: resolveAutoLowChain(snapshot),
  });
}
