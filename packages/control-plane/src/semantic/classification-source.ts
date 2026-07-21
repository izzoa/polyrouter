import { createHash } from 'node:crypto';
import type { SemanticCentroids } from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';

/** The active classification state for a principal (add-semantic-routing D5).
 * v1 always returns the bundled centroids; the semantic-learning capability
 * (change 3) decorates this seam with per-tenant learned state. */
export interface ClassificationState {
  readonly centroids: SemanticCentroids;
  readonly source: 'bundled' | 'learned';
  /** Opaque provenance digest — see {@link computeRevision}. */
  readonly revision: string;
}

/** The seam the router reads. Bundled-only in this change; the interface is
 * the single point change 3 substitutes learned state through. */
export interface ClassificationSourceProvider {
  forPrincipal(principal: Principal): ClassificationState;
}

/** DI token for the classification source (add-semantic-routing). Bound to
 * `SemanticClassifierService` here via `useExisting`; the semantic-learning
 * capability rebinds it to a decorator that layers per-tenant learned state
 * over the bundled source WITHOUT touching the router (clink r2 Med-4). */
export const CLASSIFICATION_SOURCE = 'polyrouter:classification-source';

/**
 * The opaque, versioned provenance digest (D4, clink r1 Med-3): one text
 * column auditable against EVERYTHING that produced a band — the embedder
 * content id + dims, the anchor-set content, the extractor version, the
 * active thresholds, and the active centroid source revision. A change to any
 * input changes the recorded revision.
 */
export function computeRevision(input: {
  embedderId: string;
  dims: number;
  anchorSetId: string;
  anchorContentHash: string;
  extractorVersion: number;
  highThreshold: number;
  lowThreshold: number;
  source: string;
  sourceRevision: string;
}): string {
  const h = createHash('sha256');
  h.update('polyrouter-semantic-revision-v1\0');
  for (const part of [
    input.embedderId,
    String(input.dims),
    input.anchorSetId,
    input.anchorContentHash,
    String(input.extractorVersion),
    input.highThreshold.toFixed(4),
    input.lowThreshold.toFixed(4),
    input.source,
    input.sourceRevision,
  ]) {
    h.update(part);
    h.update('\0');
  }
  return `sha256:${h.digest('hex').slice(0, 32)}`;
}

/** Stable content hash of an anchor set (order-independent within a band). */
export function hashAnchorContent(high: readonly string[], low: readonly string[]): string {
  const h = createHash('sha256');
  h.update('high\0');
  for (const a of [...high].sort()) {
    h.update(a);
    h.update('\0');
  }
  h.update('low\0');
  for (const a of [...low].sort()) {
    h.update(a);
    h.update('\0');
  }
  return h.digest('hex');
}
