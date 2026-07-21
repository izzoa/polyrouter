import { computeLearningEvidenceRevision, type LearningEvidenceInputs } from './learning-revision';

const base: LearningEvidenceInputs = {
  embedderId: 'sha256:abc',
  dims: 384,
  anchorSetId: 'bundled-v1',
  extractorVersion: 1,
  highThreshold: 0.15,
  lowThreshold: 0.15,
  qualityThreshold: 0.5,
  autoLowChain: ['m-cheap-1', 'm-cheap-2'],
};

describe('computeLearningEvidenceRevision', () => {
  it('is deterministic and opaque', () => {
    expect(computeLearningEvidenceRevision(base)).toBe(computeLearningEvidenceRevision(base));
    expect(computeLearningEvidenceRevision(base)).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it('changes when any MEANING-bearing input changes', () => {
    const r0 = computeLearningEvidenceRevision(base);
    expect(computeLearningEvidenceRevision({ ...base, embedderId: 'sha256:xyz' })).not.toBe(r0);
    expect(computeLearningEvidenceRevision({ ...base, highThreshold: 0.2 })).not.toBe(r0);
    expect(computeLearningEvidenceRevision({ ...base, qualityThreshold: 0.6 })).not.toBe(r0);
    // The cheap chain is meaning-bearing: a different auto_low target = a
    // different notion of "the cheap tier sufficed".
    expect(computeLearningEvidenceRevision({ ...base, autoLowChain: ['m-other'] })).not.toBe(r0);
    // Order matters (it's the fallback order).
    expect(
      computeLearningEvidenceRevision({ ...base, autoLowChain: ['m-cheap-2', 'm-cheap-1'] }),
    ).not.toBe(r0);
  });

  it('rounds thresholds to 4 decimals for float stability', () => {
    expect(computeLearningEvidenceRevision({ ...base, qualityThreshold: 0.5 })).toBe(
      computeLearningEvidenceRevision({ ...base, qualityThreshold: 0.500001 }),
    );
  });
});
