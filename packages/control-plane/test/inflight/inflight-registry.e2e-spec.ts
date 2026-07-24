import { randomUUID } from 'node:crypto';
import { userPrincipal, type Principal } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import {
  InflightRegistry,
  inflightKeysFor,
  type InflightEntry,
} from '../../src/inflight/inflight-registry';

/** add-inflight-requests §2.1: the registry's Redis contract against a REAL Redis —
 * atomic entry+index, owner scoping, the bounded/self-cleaning read, and above all
 * the TWO-CLOCK late-write safety (settled marker within the admission window, the
 * server-time cutoff past it) that makes a stale write unable to resurrect a ghost. */
describe('InflightRegistry (real Redis)', () => {
  let client: Redis;
  let reg: InflightRegistry;
  const owners: Principal[] = [];

  const principal = (): Principal => {
    const p = userPrincipal(`u-inflight-${randomUUID()}`);
    owners.push(p);
    return p;
  };

  const entry = (over: Partial<InflightEntry> = {}): InflightEntry => ({
    requestId: randomUUID(),
    startedAt: Date.now(),
    decisionLayer: 'cascade',
    tierAssigned: 'utility',
    modelLabel: 'minimax/minimax-m3',
    providerLabel: 'Openrouter',
    protocol: 'openai',
    ...over,
  });

  /** `mark`/`clear` are fire-and-forget — poll until the write lands (or give up). */
  const waitFor = async (cond: () => Promise<boolean>, ms = 3_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await cond()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const settled = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    client = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    try {
      await client.connect();
      await client.ping();
    } catch (error) {
      throw new Error(
        `Dev redis unreachable — start it with: docker compose -f docker-compose.dev.yml up -d\n(${(error as Error).message})`,
      );
    }
    reg = new InflightRegistry(client);
  }, 30_000);

  afterAll(async () => {
    for (const p of owners) {
      const { index } = inflightKeysFor(p, 'x');
      const ids = await client.zrange(index, 0, -1);
      const keys = ids.flatMap((id) => {
        const k = inflightKeysFor(p, id);
        return [k.entry, k.marker];
      });
      await client.del(index, ...(keys.length > 0 ? keys : []));
    }
    await client.quit();
  });

  it('publishes a metadata-only entry visible ONLY to its owner', async () => {
    const a = principal();
    const b = principal();
    const e = entry();
    reg.mark(a, e);
    expect(await waitFor(async () => (await reg.list(a)).items.length === 1)).toBe(true);

    const snap = await reg.list(a);
    expect(snap).toMatchObject({ available: true, truncated: false });
    expect(snap.items[0]).toEqual({
      id: e.requestId,
      startedAt: e.startedAt,
      decisionLayer: 'cascade',
      tierAssigned: 'utility',
      modelLabel: 'minimax/minimax-m3',
      providerLabel: 'Openrouter',
      protocol: 'openai',
      status: 'running',
    });
    // Metadata only (invariant 8): the stored value carries no body/usage/credential.
    const raw = (await client.get(inflightKeysFor(a, e.requestId).entry))!;
    expect(raw).not.toMatch(/messages|content|prompt|authorization|api[-_]?key/i);
    // Tenant isolation (invariant 5): another principal never sees it.
    expect((await reg.list(b)).items).toEqual([]);
  });

  it('writes entry AND index together, and removes both on settle', async () => {
    const p = principal();
    const e = entry();
    const keys = inflightKeysFor(p, e.requestId);
    const lease = reg.mark(p, e);
    expect(await waitFor(async () => (await client.exists(keys.entry)) === 1)).toBe(true);
    expect(await client.zscore(keys.index, e.requestId)).toBe(String(e.startedAt));

    lease.settle();
    expect(await waitFor(async () => (await client.exists(keys.entry)) === 0)).toBe(true);
    expect(await client.zscore(keys.index, e.requestId)).toBeNull(); // index member gone too
    expect((await reg.list(p)).items).toEqual([]);
  });

  it('a LATE mark after settle cannot resurrect the entry (settled-marker guard)', async () => {
    const p = principal();
    const e = entry();
    const keys = inflightKeysFor(p, e.requestId);
    reg.mark(p, e).settle();
    expect(await waitFor(async () => (await client.exists(keys.marker)) === 1)).toBe(true);

    reg.mark(p, e); // the delayed write finally lands — must no-op
    await settled();
    expect(await client.exists(keys.entry)).toBe(0);
    expect((await reg.list(p)).items).toEqual([]);
  });

  it('a mark past the admission cutoff is rejected by the server clock (no marker needed)', async () => {
    const p = principal();
    // Older than admissionLifetimeMs (+skew): the marker for such a request would
    // long since have expired, so the TIME check is what must reject it.
    const e = entry({ startedAt: Date.now() - 31 * 60_000 });
    reg.mark(p, e);
    await settled();
    expect(await client.exists(inflightKeysFor(p, e.requestId).entry)).toBe(0);
    expect((await reg.list(p)).items).toEqual([]);
  });

  it('renew is EXISTS-ONLY: it never creates an entry for a cleared request', async () => {
    const p = principal();
    const e = entry();
    const keys = inflightKeysFor(p, e.requestId);
    const lease = reg.mark(p, e);
    expect(await waitFor(async () => (await client.exists(keys.entry)) === 1)).toBe(true);
    const before = await client.pttl(keys.entry);

    // A renew on a LIVE entry extends its absolute deadline.
    await (client as unknown as { inflightRenew: (...a: unknown[]) => Promise<number> })
      .inflightRenew(keys.entry, keys.marker, 600_000);
    expect(await client.pttl(keys.entry)).toBeGreaterThan(before);

    // After settle, a still-scheduled renew must create NOTHING.
    lease.settle();
    expect(await waitFor(async () => (await client.exists(keys.entry)) === 0)).toBe(true);
    await (client as unknown as { inflightRenew: (...a: unknown[]) => Promise<number> })
      .inflightRenew(keys.entry, keys.marker, 600_000);
    expect(await client.exists(keys.entry)).toBe(0);
  });

  it('the read is bounded and flags truncation, newest-first', async () => {
    const p = principal();
    const base = Date.now();
    for (let i = 0; i < 105; i += 1) reg.mark(p, entry({ startedAt: base + i }));
    expect(await waitFor(async () => (await reg.list(p)).items.length >= 100)).toBe(true);

    const snap = await reg.list(p);
    expect(snap.items).toHaveLength(100); // the cap
    expect(snap.truncated).toBe(true); // and it says so
    expect(snap.items[0]!.startedAt).toBeGreaterThan(snap.items[99]!.startedAt); // newest-first
  });

  it('an index member whose entry expired is skipped and reclaimed', async () => {
    const p = principal();
    const e = entry();
    const keys = inflightKeysFor(p, e.requestId);
    reg.mark(p, e);
    expect(await waitFor(async () => (await client.exists(keys.entry)) === 1)).toBe(true);

    await client.del(keys.entry); // simulate the entry expiring under its index member
    expect((await reg.list(p)).items).toEqual([]); // skipped, not rendered
    expect(await waitFor(async () => (await client.zscore(keys.index, e.requestId)) === null)).toBe(
      true,
    ); // and reclaimed
  });
});
