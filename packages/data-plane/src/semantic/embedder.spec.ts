import { stubEmbedder } from './embedder';

describe('stubEmbedder', () => {
  it('is deterministic: same text, same vector', async () => {
    const e = stubEmbedder(384);
    const a = await e.embed('route this request');
    const b = await e.embed('route this request');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('produces unit-norm vectors of the declared dims', async () => {
    const e = stubEmbedder(384);
    expect(e.dims).toBe(384);
    expect(e.id).toBe('stub:384');
    const v = await e.embed('hello');
    expect(v).toHaveLength(384);
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    for (const x of v) expect(Number.isFinite(x)).toBe(true);
  });

  it('distinct texts produce distinct vectors', async () => {
    const e = stubEmbedder(64);
    const a = await e.embed('write me a haiku');
    const b = await e.embed('prove the Riemann hypothesis');
    let dot = 0;
    for (let i = 0; i < 64; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
    // Unit vectors: identical would dot to 1; independent hashes hover near 0.
    expect(Math.abs(dot)).toBeLessThan(0.9);
  });

  it('covers dims not divisible by the digest stride', async () => {
    const e = stubEmbedder(7);
    const v = await e.embed('x');
    expect(v).toHaveLength(7);
    expect(v.some((x) => x !== 0)).toBe(true);
  });

  it('rejects invalid dims at construction', () => {
    expect(() => stubEmbedder(1)).toThrow('dims');
    expect(() => stubEmbedder(2.5)).toThrow('dims');
  });
});
