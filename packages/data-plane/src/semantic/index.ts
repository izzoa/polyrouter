export { stubEmbedder, type Embedder } from './embedder';
export {
  classifySemantic,
  CentroidValidationError,
  validateCentroids,
  type SemanticBand,
  type SemanticCentroids,
  type SemanticClassification,
  type SemanticThresholds,
} from './classify';
export { SEMANTIC_EXTRACTOR_VERSION, extractSemanticInput, type ExtractCaps } from './extract';
export { ANCHOR_SET_ID, HIGH_ANCHORS, LOW_ANCHORS } from './anchors';
export {
  labelForOutcome,
  foldEvidence,
  clampDriftSpherical,
  cosineDistance,
  evidenceMean,
  foldBothLabels,
  type LearningLabel,
} from './learning';
export {
  WORKLOAD_ANCHORS,
  WORKLOAD_ANCHOR_CONTENT_HASH,
  WORKLOAD_ANCHOR_SET_ID,
} from './workload-anchors';
export {
  classifySemanticWorkload,
  semanticWorkloadRevision,
  semanticWorkloadVerdict,
  validateWorkloadCentroids,
  type SemanticWorkloadClassification,
  type SemanticWorkloadRails,
  type SemanticWorkloadRevisionInputs,
  type WorkloadCentroids,
} from './workload-classify';
