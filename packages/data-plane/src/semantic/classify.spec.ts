import { classifySemantic, validateCentroids, type SemanticCentroids } from './classify';

const unit = (xs: number[]): Float32Array => {
  const v = Float32Array.from(xs);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) / n;
  return v;
};

const C: SemanticCentroids = { high: unit([1, 0, 0, 0]), low: unit([0, 1, 0, 0]) };
const T = { high: 0.15, low: 0.15 };

describe('classifySemantic', () => {
  it('cuts bands with inclusive edges over the score = simHigh − simLow', () => {
    const hi = classifySemantic(unit([1, 0, 0, 0]), C, T);
    expect(hi).toMatchObject({ kind: 'band', band: 'high', score: 1 });
    const lo = classifySemantic(unit([0, 1, 0, 0]), C, T);
    expect(lo).toMatchObject({ kind: 'band', band: 'low', score: -1 });
    const mid = classifySemantic(unit([1, 1, 0, 0]), C, T);
    expect(mid).toMatchObject({ kind: 'band', band: 'ambiguous' });
    // exact-edge inclusivity: craft score == 0.15 via thresholds
    const edge = classifySemantic(unit([1, 0, 0, 0]), C, { high: 1, low: 0.15 });
    expect(edge).toMatchObject({ kind: 'band', band: 'high' }); // score 1 ≥ 1
  });

  it('returns invalid — never a band — for degenerate inputs (clink r1 Med-1)', () => {
    expect(classifySemantic(new Float32Array(4), C, T)).toMatchObject({ kind: 'invalid' });
    expect(classifySemantic(Float32Array.from([Number.NaN, 0, 0, 0]), C, T)).toMatchObject({
      kind: 'invalid',
    });
    expect(classifySemantic(unit([1, 0, 0]), C, T)).toMatchObject({ kind: 'invalid' }); // dim mismatch
    const clash: SemanticCentroids = { high: C.high, low: unit([1, 0, 0]) };
    expect(classifySemantic(unit([1, 0, 0, 0]), clash, T)).toMatchObject({ kind: 'invalid' });
  });

  it('clamps cosines into [-1,1] so score stays in [-2,2]', () => {
    // Non-unit centroid would push |cos| past 1 without the clamp.
    const big: SemanticCentroids = { high: Float32Array.from([2, 0, 0, 0]), low: unit([0, 1, 0, 0]) };
    const r = classifySemantic(unit([1, 0, 0, 0]), big, T);
    expect(r).toMatchObject({ kind: 'band', score: 1, simHigh: 1 });
  });
});

describe('validateCentroids (boot gate)', () => {
  it('accepts unit, separated centroids', () => {
    expect(() => validateCentroids(C, 4)).not.toThrow();
  });
  it('rejects non-unit, wrong-dims, non-finite, and near-cancelling pairs', () => {
    expect(() => validateCentroids({ high: Float32Array.from([2, 0, 0, 0]), low: C.low }, 4)).toThrow(
      'unit-norm',
    );
    expect(() => validateCentroids(C, 5)).toThrow('dims');
    expect(() =>
      validateCentroids({ high: Float32Array.from([Number.NaN, 0, 0, 0]), low: C.low }, 4),
    ).toThrow('non-finite');
    expect(() => validateCentroids({ high: C.high, low: C.high }, 4)).toThrow('cancel');
  });
});
