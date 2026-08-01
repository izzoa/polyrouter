import { computeSignalQuality } from './signal-quality';

/** Unit coverage for the pure verdict/modal logic (add-auto-signal-honesty
 * task 1.2). The SQL grouping is covered by the analytics e2e; every judgment
 * edge lives here. */
describe('computeSignalQuality', () => {
  const agg = (
    agentId: string | null,
    bandedRows: number,
    ambiguousRows: number,
    distinctScores: number,
  ) => ({ agentId, bandedRows, ambiguousRows, distinctScores });
  const bkt = (agentId: string | null, bucket: number, rows: number) => ({
    agentId,
    bucket,
    rows,
  });
  const labels = new Map([['a1', 'markus']]);

  it('flags a point mass at share exactly 0.5 with >= 50 ambiguous rows', () => {
    const [r] = computeSignalQuality(
      [agg('a1', 100, 100, 30)],
      [bkt('a1', 0.45, 50), bkt('a1', 0.3, 25), bkt('a1', 0.5, 25)],
      labels,
    );
    expect(r).toMatchObject({
      agentId: 'a1',
      label: 'markus',
      modalScore: 0.45,
      modalShare: 0.5,
      collapsed: true, // >= is inclusive at the boundary
    });
  });

  it('allows a verdict at exactly the 50-row floor and refuses at 49', () => {
    const atFloor = computeSignalQuality(
      [agg('a1', 50, 50, 1)],
      [bkt('a1', 0.45, 50)],
      labels,
    )[0]!;
    expect(atFloor.collapsed).toBe(true);
    const below = computeSignalQuality(
      [agg('a1', 49, 49, 1)],
      [bkt('a1', 0.45, 49)],
      labels,
    )[0]!;
    expect(below).toMatchObject({ collapsed: null, modalScore: 0.45, modalShare: 1 });
  });

  it('unifies an EWMA-drift family into one bucket (binning is the SQL side; the merge honors it)', () => {
    // The SQL bins 0.45 / 0.4501 / 0.45405 into bucket 0.45 — here that
    // arrives as ONE bucket row; the spread rows arrive as others.
    const [r] = computeSignalQuality(
      [agg('a1', 200, 200, 42)], // 42 raw distinct scores — reported verbatim
      [bkt('a1', 0.45, 160), bkt('a1', 0.31, 20), bkt('a1', 0.52, 20)],
      labels,
    );
    expect(r).toMatchObject({
      modalScore: 0.45,
      modalShare: 0.8,
      collapsed: true,
      distinctScores: 42,
    });
  });

  it('breaks an equal-share tie toward the LOWEST bucket, deterministically', () => {
    const r = computeSignalQuality(
      [agg('a1', 100, 100, 2)],
      // Insertion order deliberately high-first: the tie must still pick 0.30.
      [bkt('a1', 0.52, 50), bkt('a1', 0.3, 50)],
      labels,
    )[0]!;
    expect(r.modalScore).toBe(0.3);
    expect(r.modalShare).toBe(0.5);
  });

  it('never flags a confident-band point mass (below the ambiguous floor)', () => {
    const [r] = computeSignalQuality(
      [agg('a1', 210, 10, 3)], // 200 high-band rows + 10 ambiguous
      [bkt('a1', 0.45, 10)],
      labels,
    );
    expect(r).toMatchObject({ bandedRows: 210, ambiguousRows: 10, collapsed: null });
  });

  it('gives the zero-ambiguous agent a defined null shape — never NaN', () => {
    const [r] = computeSignalQuality([agg('a1', 80, 0, 0)], [], labels);
    expect(r).toMatchObject({
      ambiguousRows: 0,
      distinctScores: 0,
      modalScore: null,
      modalShare: null,
      collapsed: null,
    });
  });

  it('assesses false below the share without flagging, and null-labels keyless/foreign agents', () => {
    const rows = computeSignalQuality(
      [agg('a1', 200, 200, 90), agg(null, 60, 60, 40), agg('b-foreign', 55, 55, 20)],
      [
        bkt('a1', 0.45, 40), // 0.2 share — assessed, not collapsed
        bkt(null, 0.4, 20),
        bkt('b-foreign', 0.4, 30),
      ],
      labels, // resolver returned nothing for null/'b-foreign'
    );
    const a1 = rows.find((r) => r.agentId === 'a1')!;
    expect(a1.collapsed).toBe(false);
    const keyless = rows.find((r) => r.agentId === null)!;
    expect(keyless.label).toBeNull();
    expect(keyless.collapsed).toBe(false); // 20/60 ≈ 0.33 — assessed, below the share
    const foreign = rows.find((r) => r.agentId === 'b-foreign')!;
    expect(foreign.label).toBeNull(); // owner-scoped resolver dropped it
  });

  it('orders by traffic descending with a stable id tie-break', () => {
    const rows = computeSignalQuality(
      [agg('z', 10, 0, 0), agg('a', 10, 0, 0), agg('big', 500, 0, 0)],
      [],
      new Map(),
    );
    expect(rows.map((r) => r.agentId)).toEqual(['big', 'a', 'z']);
  });
});
