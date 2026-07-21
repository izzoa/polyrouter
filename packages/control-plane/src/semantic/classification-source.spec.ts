import { computeRevision, hashAnchorContent } from './classification-source';

const base = {
  embedderId: 'sha256:abc',
  dims: 384,
  anchorSetId: 'bundled-v1',
  anchorContentHash: 'deadbeef',
  extractorVersion: 1,
  highThreshold: 0.15,
  lowThreshold: 0.15,
  source: 'bundled',
  sourceRevision: 'bundled-v1',
};

describe('computeRevision', () => {
  it('is deterministic and opaque (sha256:… truncated)', () => {
    expect(computeRevision(base)).toBe(computeRevision(base));
    expect(computeRevision(base)).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it('changes when ANY input changes', () => {
    const r0 = computeRevision(base);
    expect(computeRevision({ ...base, embedderId: 'sha256:xyz' })).not.toBe(r0);
    expect(computeRevision({ ...base, dims: 768 })).not.toBe(r0);
    expect(computeRevision({ ...base, anchorContentHash: 'feed' })).not.toBe(r0);
    expect(computeRevision({ ...base, extractorVersion: 2 })).not.toBe(r0);
    expect(computeRevision({ ...base, highThreshold: 0.2 })).not.toBe(r0);
    expect(computeRevision({ ...base, source: 'learned' })).not.toBe(r0);
    expect(computeRevision({ ...base, sourceRevision: 'learned-42' })).not.toBe(r0);
  });

  it('rounds thresholds to 4 decimals so float noise is stable', () => {
    expect(computeRevision({ ...base, highThreshold: 0.15 })).toBe(
      computeRevision({ ...base, highThreshold: 0.150001 }),
    );
  });
});

describe('hashAnchorContent', () => {
  it('is order-independent within a band but band-position sensitive', () => {
    const a = hashAnchorContent(['x', 'y'], ['p', 'q']);
    expect(hashAnchorContent(['y', 'x'], ['q', 'p'])).toBe(a);
    // Swapping the sets is a different content.
    expect(hashAnchorContent(['p', 'q'], ['x', 'y'])).not.toBe(a);
  });

  it('changes when an exemplar changes', () => {
    const a = hashAnchorContent(['x'], ['p']);
    expect(hashAnchorContent(['x2'], ['p'])).not.toBe(a);
  });
});
