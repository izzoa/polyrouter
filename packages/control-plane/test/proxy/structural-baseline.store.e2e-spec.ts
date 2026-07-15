import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import { RedisModule } from '../../src/redis/redis.module';
import { StructuralBaselineStore } from '../../src/proxy/structural/structural-baseline.store';

const HMAC = 'd'.repeat(64);

async function waitFor(fn: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for condition');
}

/** #13 baseline store against a real Redis: the hot-path read never awaits, the
 * shared EWMA is atomic + field-capped + TTL'd, and an outage bounds background
 * work rather than accumulating it. */
describe('StructuralBaselineStore (real Redis)', () => {
  let app: INestApplication;
  let client: Redis;
  const stores: StructuralBaselineStore[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RedisModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    client = app.get<Redis>(REDIS_CLIENT);
    try {
      await client.ping();
    } catch (error) {
      throw new Error(
        `Dev redis unreachable — docker compose -f docker-compose.dev.yml up -d\n(${(error as Error).message})`,
      );
    }
  }, 30_000);

  afterAll(async () => {
    for (const s of stores) s.onApplicationShutdown();
    const keys = await client.keys('route:sbaseline:*');
    if (keys.length > 0) await client.del(...keys);
    await app.close();
  });

  function newStore(shared: Redis = client): StructuralBaselineStore {
    const s = new StructuralBaselineStore(shared, HMAC);
    stores.push(s);
    return s;
  }

  it('read is synchronous + null on a cold miss; observe warms the local EWMA (Redis-independent)', () => {
    const s = newStore();
    expect(s.read('t1', 'a1', 'sys')).toBeNull();
    s.observe('t1', 'a1', 'sys', 1_000, 0.5);
    expect(s.read('t1', 'a1', 'sys')?.ewma).toBe(1_000); // first observation seeds the EWMA
    s.observe('t1', 'a1', 'sys', 2_000, 0.5);
    expect(s.read('t1', 'a1', 'sys')?.ewma).toBe(1_500); // .5*2000 + .5*1000
  });

  it('flushes an atomic EWMA to Redis with a TTL, and a second instance cold-seeds it', async () => {
    const a = newStore();
    await a.waitReady();
    const uid = `x-${Date.now()}`;
    a.observe(uid, 'ag', 'sys', 800, 0.5);
    await a.flushPending();

    const hkey = `route:sbaseline:${uid}:ag`;
    const fields = await client.hgetall(hkey);
    expect(Number(Object.values(fields)[0])).toBe(800);
    expect(await client.ttl(hkey)).toBeGreaterThan(0);

    const b = newStore();
    await b.waitReady();
    b.read(uid, 'ag', 'sys'); // miss → schedules an async cold-seed from Redis
    await waitFor(() => b.read(uid, 'ag', 'sys') !== null);
    expect(b.read(uid, 'ag', 'sys')?.ewma).toBe(800);
  });

  it('caps the number of fingerprint fields per agent', async () => {
    const c = newStore();
    await c.waitReady();
    const uid = `cap-${Date.now()}`;
    for (let i = 0; i < 40; i++) c.observe(uid, 'ag', `sys-${i}`, 100, 0.5);
    await c.flushPending();
    expect(await client.hlen(`route:sbaseline:${uid}:ag`)).toBeLessThanOrEqual(32);
  });

  it('scopes baseline keys by tenant', async () => {
    const d = newStore();
    await d.waitReady();
    const u1 = `iso1-${Date.now()}`;
    const u2 = `iso2-${Date.now()}`;
    d.observe(u1, 'ag', 'sys', 100, 0.5);
    d.observe(u2, 'ag', 'sys', 200, 0.5);
    await d.flushPending();
    expect(await client.exists(`route:sbaseline:${u1}:ag`)).toBe(1);
    expect(await client.exists(`route:sbaseline:${u2}:ag`)).toBe(1);
  });

  it('bounds background work during a Redis outage (unique-fingerprint flood)', () => {
    const bad = new Redis({
      host: '127.0.0.1',
      port: 6399, // nothing listening
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    bad.on('error', () => {});
    const s = new StructuralBaselineStore(bad, HMAC);
    stores.push(s);
    for (let i = 0; i < 10_000; i++) {
      s.read(`out`, 'ag', `sys-${i}`); // miss → seed
      s.observe(`out`, 'ag', `sys-${i}`, 100, 0.5); // → flush
    }
    expect(s.backgroundEntries).toBeLessThanOrEqual(4_096); // admission-capped, never accumulates
    bad.disconnect();
  });

  it('onApplicationShutdown clears queued state and disconnects the duplicate', () => {
    const s = newStore();
    s.observe(`life-${Date.now()}`, 'ag', 'sys', 100, 0.5); // arms a flush timer
    s.onApplicationShutdown();
    expect(s.backgroundEntries).toBe(0);
  });
});
