import {
  clampDriftSpherical,
  cosineDistance,
  evidenceMean,
  foldEvidence,
  labelForOutcome,
} from './learning';

const unit = (xs: number[]): Float32Array => {
  const v = Float32Array.from(xs);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) / n;
  return v;
};

describe('labelForOutcome', () => {
  it('quality-gate escalation → high; cheap_error escalation → nothing', () => {
    expect(
      labelForOutcome({ escalated: true, status: 'success', qualitySignal: 0.3, escalationSource: 'quality_gate' }),
    ).toBe('high');
    expect(
      labelForOutcome({ escalated: true, status: 'error', qualitySignal: null, escalationSource: 'cheap_error' }),
    ).toBeNull();
  });

  it('cheap pass (served + decided quality) → low; unknown/failed → nothing', () => {
    expect(
      labelForOutcome({ escalated: false, status: 'success', qualitySignal: 0.9, escalationSource: undefined }),
    ).toBe('low');
    expect(
      labelForOutcome({ escalated: false, status: 'success', qualitySignal: null, escalationSource: undefined }),
    ).toBeNull(); // fail-open unknown
    expect(
      labelForOutcome({ escalated: false, status: 'error', qualitySignal: 0.9, escalationSource: undefined }),
    ).toBeNull(); // not served
    expect(
      labelForOutcome({ escalated: false, status: 'cancelled', qualitySignal: 0.9, escalationSource: undefined }),
    ).toBeNull();
  });
});

describe('foldEvidence (EMA + renorm)', () => {
  it('moves the active centroid toward the evidence, staying unit-norm', () => {
    const active = unit([1, 0, 0]);
    const evidence = unit([0, 1, 0]);
    const out = foldEvidence(active, evidence, 0.2)!;
    expect(Math.hypot(...out)).toBeCloseTo(1, 6);
    // With alpha 0.2 the result leans toward active but tilts toward evidence.
    expect(out[0]!).toBeGreaterThan(out[1]!);
    expect(out[1]!).toBeGreaterThan(0);
  });

  it('returns null on dim mismatch', () => {
    expect(foldEvidence(unit([1, 0]), unit([1, 0, 0]), 0.2)).toBeNull();
  });
});

describe('clampDriftSpherical', () => {
  it('leaves a within-leash centroid unchanged (as a unit vector)', () => {
    const bundled = unit([1, 0, 0]);
    const learned = unit([1, 0.05, 0]); // tiny drift
    const out = clampDriftSpherical(learned, bundled, 0.35);
    expect(cosineDistance(out, learned)).toBeCloseTo(0, 5);
  });

  it('rotates an over-drifted centroid back onto the cap boundary', () => {
    const bundled = unit([1, 0, 0]);
    const learned = unit([0, 1, 0]); // distance 1.0 (orthogonal) > 0.35
    const out = clampDriftSpherical(learned, bundled, 0.35);
    expect(cosineDistance(out, bundled)).toBeCloseTo(0.35, 4);
    expect(Math.hypot(...out)).toBeCloseTo(1, 6);
  });

  it('antipodal → bundled outright', () => {
    const bundled = unit([1, 0, 0]);
    const learned = unit([-1, 0, 0]);
    const out = clampDriftSpherical(learned, bundled, 0.35);
    expect(cosineDistance(out, bundled)).toBeCloseTo(0, 6);
  });

  it('degenerate (zero) learned → bundled', () => {
    const bundled = unit([1, 0, 0]);
    expect(cosineDistance(clampDriftSpherical(new Float32Array(3), bundled, 0.35), bundled)).toBeCloseTo(0, 6);
  });
});

describe('evidenceMean', () => {
  it('averages a summed vector and unit-normalizes', () => {
    const sum = Float32Array.from([2, 0, 0]); // sum of 2 copies of [1,0,0]
    const m = evidenceMean(sum, 2)!;
    expect(Array.from(m)).toEqual([1, 0, 0]);
  });
  it('null for zero count or degenerate sum', () => {
    expect(evidenceMean(Float32Array.from([1, 0]), 0)).toBeNull();
    expect(evidenceMean(new Float32Array(3), 5)).toBeNull();
  });
});
