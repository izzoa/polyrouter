import { WORKLOAD_CLASSES, type WorkloadClass } from '@polyrouter/shared';
import {
  classifySemanticWorkload,
  semanticWorkloadRevision,
  semanticWorkloadVerdict,
  validateWorkloadCentroids,
  type SemanticWorkloadClassification,
  type WorkloadCentroids,
} from './workload-classify';

const DIMS = 8;
const unit = (vals: number[]): Float32Array => {
  const v = new Float32Array(DIMS);
  vals.forEach((x, i) => (v[i] = x));
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < DIMS; i += 1) v[i] = (v[i] ?? 0) / n;
  return v;
};
const basis = (i: number): Float32Array =>
  unit(Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0)));
// WORKLOAD_CLASSES order: code, research, vision, structured, writing → e0..e4
const CENTS: WorkloadCentroids = Object.fromEntries(
  WORKLOAD_CLASSES.map((c, i) => [c, basis(i)]),
) as Record<WorkloadClass, Float32Array>;
const RAILS = { margin: 0.05, minSim: 0.2 };
const verdict = (c: SemanticWorkloadClassification) => {
  if (c.kind !== 'verdict') throw new Error(`expected verdict, got ${c.reason}`);
  return c;
};

describe('classifySemanticWorkload (add-semantic-workloads D1)', () => {
  it('emits a reserved class that wins by the margin above the floor, with the winning cosine as score', () => {
    const r = verdict(classifySemanticWorkload(basis(1), CENTS, RAILS)); // research
    expect(r.class).toBe('research');
    expect(r.score).toBeCloseTo(1, 6);
    expect(r.top).toBe('research');
    expect(r.margin).toBeCloseTo(1, 6);
    const w = verdict(classifySemanticWorkload(basis(4), CENTS, RAILS));
    expect(w.class).toBe('writing');
  });

  it('never emits a structural class even when it wins outright — but keeps the winning cosine as the score', () => {
    for (const i of [0, 2, 3]) {
      const c = verdict(classifySemanticWorkload(basis(i), CENTS, RAILS));
      expect(c.class).toBe('none');
      expect(c.score).toBeCloseTo(1, 6); // an abstention persists its real confidence (clink r5 M1)
      expect(c.top).toBe(WORKLOAD_CLASSES[i]);
      expect(c.margin).toBeCloseTo(1, 6); // the margin is huge — ownership, not confidence, decides
    }
  });

  it('a reserved winner below the margin rail is none (the runner-up is another class)', () => {
    // research 0.8 / writing 0.79 → tiny margin
    const c = verdict(classifySemanticWorkload(unit([0, 0.8, 0, 0, 0.79]), CENTS, RAILS));
    expect(c.top).toBe('research');
    expect(c.margin).toBeLessThan(0.05);
    expect(c.class).toBe('none');
    expect(c.score).toBeCloseTo(c.topSim, 6); // below-margin abstention keeps the winning cosine
    // widen the lead → research
    const d = verdict(classifySemanticWorkload(unit([0, 0.9, 0, 0, 0.3]), CENTS, RAILS));
    expect(d.class).toBe('research');
  });

  it('a reserved winner below the similarity floor is none even with a clear margin', () => {
    // research 0.15 in a vector dominated by an unrelated direction (dim 6)
    const c = verdict(classifySemanticWorkload(unit([0, 0.15, 0, 0, 0, 0, 0.98, 0]), CENTS, RAILS));
    expect(c.top).toBe('research');
    expect(c.topSim).toBeLessThan(0.2);
    expect(c.margin).toBeGreaterThan(0.05);
    expect(c.class).toBe('none');
    expect(c.score).toBeCloseTo(c.topSim, 6); // below-floor abstention keeps the winning cosine
    // the same vector under a zero floor → research (the floor is what decided)
    expect(
      verdict(
        classifySemanticWorkload(unit([0, 0.15, 0, 0, 0, 0, 0.98, 0]), CENTS, {
          margin: 0.05,
          minSim: 0,
        }),
      ).class,
    ).toBe('research');
  });

  it('an exact tie between the two reserved classes is none (margin 0 < any rail), with a deterministic ranking', () => {
    const c = verdict(classifySemanticWorkload(unit([0, 1, 0, 0, 1]), CENTS, RAILS));
    expect(c.margin).toBeCloseTo(0, 6);
    expect(c.class).toBe('none');
    expect([c.top, c.second].sort()).toEqual(['research', 'writing']);
  });

  it('degenerate inputs are a discriminated invalid — never a verdict', () => {
    expect(classifySemanticWorkload(new Float32Array(DIMS), CENTS, RAILS)).toMatchObject({
      kind: 'invalid',
      reason: 'zero-norm vector',
    });
    const nan = basis(1);
    nan[3] = Number.NaN;
    expect(classifySemanticWorkload(nan, CENTS, RAILS)).toMatchObject({
      kind: 'invalid',
      reason: 'non-finite vector',
    });
    expect(classifySemanticWorkload(new Float32Array(0), CENTS, RAILS)).toMatchObject({
      kind: 'invalid',
      reason: 'empty vector',
    });
    const bad = { ...CENTS, vision: new Float32Array(DIMS + 1) } as WorkloadCentroids;
    expect(classifySemanticWorkload(basis(1), bad, RAILS).kind).toBe('invalid');
  });

  it('sims carry all five classes (telemetry/debug), clamped to [-1, 1]', () => {
    const c = verdict(classifySemanticWorkload(basis(1), CENTS, RAILS));
    expect(Object.keys(c.sims).sort()).toEqual([...WORKLOAD_CLASSES].sort());
    for (const v of Object.values(c.sims)) expect(v >= -1 && v <= 1).toBe(true);
  });
});

describe('validateWorkloadCentroids (D4)', () => {
  it('accepts five unit-norm, finite, non-cancelling centroids', () => {
    expect(() => validateWorkloadCentroids({ ...CENTS }, DIMS)).not.toThrow();
  });
  it('rejects a missing class, a wrong dimension, a non-unit or non-finite centroid, and near-cancelling pairs', () => {
    const { writing: _w, ...fourOnly } = CENTS;
    expect(() => validateWorkloadCentroids(fourOnly, DIMS)).toThrow(/writing is missing/);
    expect(() =>
      validateWorkloadCentroids({ ...CENTS, code: new Float32Array(DIMS + 1) }, DIMS),
    ).toThrow(/dims/);
    const notUnit = new Float32Array(DIMS);
    notUnit[0] = 0.5;
    expect(() => validateWorkloadCentroids({ ...CENTS, code: notUnit }, DIMS)).toThrow(
      /not unit-norm/,
    );
    const nan = basis(0);
    nan[1] = Number.NaN;
    expect(() => validateWorkloadCentroids({ ...CENTS, code: nan }, DIMS)).toThrow(/non-finite/);
    expect(() => validateWorkloadCentroids({ ...CENTS, writing: basis(1) }, DIMS)).toThrow(
      /nearly cancel/,
    ); // writing == research
    // the equality boundary is forbidden too (cos exactly 0.999 → reject; 0.998 → accept)
    const near = (cos: number): Float32Array => unit([0, cos, 0, 0, Math.sqrt(1 - cos * cos)]);
    expect(() => validateWorkloadCentroids({ ...CENTS, writing: near(0.999) }, DIMS)).toThrow(
      /nearly cancel/,
    );
    expect(() => validateWorkloadCentroids({ ...CENTS, writing: near(0.998) }, DIMS)).not.toThrow();
  });
});

describe('semanticWorkloadRevision + semanticWorkloadVerdict (D3)', () => {
  const inputs = {
    embedderId: 'sha256:abc',
    anchorSetId: 'workload-v1',
    anchorContentHash: 'h',
    extractorVersion: 1,
    margin: 0.05,
    minSim: 0.2,
  };
  it('is deterministic, key-order independent, configuration-only, and changes with any input', () => {
    const a = semanticWorkloadRevision(inputs);
    const b = semanticWorkloadRevision({
      minSim: 0.2,
      margin: 0.05,
      extractorVersion: 1,
      anchorContentHash: 'h',
      anchorSetId: 'workload-v1',
      embedderId: 'sha256:abc',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^semantic\/v1\/s1\/[0-9a-f]{12}$/);
    expect(semanticWorkloadRevision({ ...inputs, margin: 0.06 })).not.toBe(a);
    expect(semanticWorkloadRevision({ ...inputs, minSim: 0.25 })).not.toBe(a);
    expect(semanticWorkloadRevision({ ...inputs, embedderId: 'sha256:other' })).not.toBe(a);
    expect(semanticWorkloadRevision({ ...inputs, anchorContentHash: 'h2' })).not.toBe(a);
    expect(semanticWorkloadRevision({ ...inputs, extractorVersion: 2 })).not.toBe(a);
  });
  it('builds a numbers-and-class-names-only reason with a 4-dp score', () => {
    const c = verdict(classifySemanticWorkload(unit([0, 0.9, 0, 0, 0.3]), CENTS, RAILS));
    const v = semanticWorkloadVerdict(c, 'semantic/v1/s1/abcdefabcdef');
    expect(v).toMatchObject({
      class: 'research',
      source: 'semantic',
      revision: 'semantic/v1/s1/abcdefabcdef',
    });
    expect(v.score).toBe(Math.round(c.score * 10_000) / 10_000);
    expect(v.reason).toMatch(
      /^workload:research score=\d\.\d{4} m=\d\.\d{4} sim2=-?\d\.\d{4} top=research top2=writing src=semantic$/,
    );
    const n = semanticWorkloadVerdict(
      verdict(classifySemanticWorkload(basis(0), CENTS, RAILS)),
      'r',
    );
    expect(n.class).toBe('none');
    expect(n.score).toBeCloseTo(1, 4); // the winning cosine rides the record even for `none`
    expect(n.reason.startsWith('workload:none score=1.0000')).toBe(true);
  });
});
