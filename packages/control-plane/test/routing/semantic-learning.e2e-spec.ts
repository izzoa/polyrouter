// Semantic-learning e2e (add-semantic-learning, real Postgres + Redis). Drives
// the queue-free sweep occurrence + the port's CAS/audit against a real DB, and
// the accumulator's flush against a real Redis (tasks 3.4 + 4.3). The full hot
// path (embedder → accumulator) and the decorator's read gate are unit-pinned;
// this proves the crash-atomic Postgres+Redis protocol end-to-end.
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  userPrincipal,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import type { RoutingSnapshot } from '@polyrouter/data-plane';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import { RoutingConfigModule } from '../../src/routing-config/routing-config.module';
import { runSemanticLearningOccurrence } from '../../src/semantic/learning.run';
import { RedisLearningStore } from '../../src/semantic/learning-store';
import { EvidenceAccumulator } from '../../src/semantic/evidence-accumulator';
import { seedPendingBucket } from '../../src/semantic/testing/seed-pending';
import { resolveLearningEvidenceRevision } from '../../src/semantic/learning-evidence';
import {
  dayStamp,
  deriveTenantHmacKey,
  pendingBucketKey,
  tenantHmac,
} from '../../src/semantic/learning-format';
import type { LearningProvenance } from '../../src/semantic/semantic-classifier.service';
import type { SemanticLearningConfig } from '../../src/semantic/semantic.config';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
const REDIS_URL = process.env['REDIS_URL'];
if (REDIS_URL === undefined && process.env['CI'] !== undefined) {
  throw new Error('[semantic-learning e2e] CI is set but REDIS_URL is missing.');
}
const suite = REDIS_URL !== undefined ? describe : describe.skip;

const SECRET = 'e2e-learning-secret';
const KEY = deriveTenantHmacKey(SECRET);
const DIMS = 8;
const unit = (hot: number): Float32Array => {
  const v = new Float32Array(DIMS);
  v[hot] = 1;
  return v;
};
const PROV: LearningProvenance = {
  bundled: { high: unit(0), low: unit(1) },
  embedderId: 'emb-e2e',
  dims: DIMS,
  anchorSetId: 'anchors-e2e',
  extractorVersion: 1,
  highThreshold: 0.15,
  lowThreshold: 0.15,
};
const QUALITY = 0.5;
const EMPTY_SNAPSHOT: RoutingSnapshot = {
  tiers: [],
  entriesByTierId: new Map(),
  rules: [],
  models: [],
};
const REV = resolveLearningEvidenceRevision(EMPTY_SNAPSHOT, PROV, QUALITY);
const CFG: SemanticLearningConfig = {
  minCohort: 8,
  minSamples: 50,
  alpha: 0.2,
  maxDrift: 0.35,
  cooldownH: 24,
  stateTtlD: 30,
  maxCohorts: 4096,
  // OFF: this suite drives the sweep directly (queue-free); it never exercises
  // the BullMQ scheduler, so a live Worker would only leak handles.
  schedEnabled: false,
  schedCron: '0 3 * * *',
};
const silent = { warn: () => {}, log: () => {} };
const hmacOf = (owner: string): string => tenantHmac(KEY, owner);

suite('semantic-learning e2e (sweep + port CAS + accumulator)', () => {
  let app: INestApplication;
  let pool: Pool;
  let port: PersistencePort;
  let redis: Redis;
  const owners: string[] = [];

  const now = (): number => Date.now();
  const loadSnapshot = (): Promise<RoutingSnapshot> => Promise.resolve(EMPTY_SNAPSHOT);
  const run = (store: RedisLearningStore): ReturnType<typeof runSemanticLearningOccurrence> =>
    runSemanticLearningOccurrence(
      port,
      store,
      PROV,
      loadSnapshot,
      CFG,
      QUALITY,
      hmacOf,
      now(),
      silent,
    );

  async function seedLearningTenant(
    label: string,
  ): Promise<{ owner: string; principal: Principal }> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${String(Date.now())}-${String(owners.length)}@learn.test`],
    );
    const owner = rows[0]!.id;
    owners.push(owner);
    const principal = userPrincipal(owner);
    await port.routingSettings.upsert(principal, {
      structuralEnabled: true,
      cascadeEnabled: true,
      semanticEnabled: true,
      semanticLearningEnabled: true,
    });
    return { owner, principal };
  }

  const seedPending = (
    owner: string,
    label: 'high' | 'low',
    count: number,
    rev = REV,
  ): Promise<void> =>
    seedPendingBucket(redis, hmacOf(owner), 0, label, rev, dayStamp(now()), unit(0), count, 3600);

  const auditRows = (
    owner: string,
  ): Promise<{ trigger: string; generation: number; high_samples: number }[]> =>
    pool
      .query<{ trigger: string; generation: number; high_samples: number }>(
        `SELECT trigger, generation, high_samples FROM semantic_learning_event WHERE owner_user_id = $1 ORDER BY created_at`,
        [owner],
      )
      .then((r) => r.rows);

  beforeAll(async () => {
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({ imports: [RoutingConfigModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  }, 60_000);

  afterAll(async () => {
    if (owners.length > 0) {
      const keys = await redis.keys('sem:*');
      if (keys.length > 0) await redis.del(...keys);
      await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [owners]);
    }
    await redis.quit();
    await app.close();
    await pool.end();
  });

  it('below-floor: no apply, no audit row, generation unchanged', async () => {
    const { owner, principal } = await seedLearningTenant('below');
    const store = new RedisLearningStore(redis, now);
    await seedPending(owner, 'high', 30); // < 50 floor
    const sum = await run(store);
    expect(sum.applied).toBe(0);
    expect(await auditRows(owner)).toHaveLength(0);
    const pref = await port.routingSettings.get(principal);
    expect(pref?.semanticLearningGeneration).toBe(0);
  });

  it('above-floor: applies within one txn — audit row + generation bump + promoted active', async () => {
    const { owner, principal } = await seedLearningTenant('above');
    const store = new RedisLearningStore(redis, now);
    await seedPending(owner, 'high', 60);
    const sum = await run(store);
    expect(sum.applied).toBe(1);
    const rows = await auditRows(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: 'apply', generation: 1, high_samples: 60 });
    expect((await port.routingSettings.get(principal))?.semanticLearningGeneration).toBe(1);
    // Promoted → the learned state is readable at the committed coordinates.
    const active = await store.readActive(hmacOf(owner), {
      epoch: 0,
      generation: 1,
      revision: REV,
    });
    expect(active).not.toBeNull();
  });

  it('cooldown blocks a second apply the same day', async () => {
    const { owner } = await seedLearningTenant('cooldown');
    const store = new RedisLearningStore(redis, now);
    await seedPending(owner, 'high', 60);
    expect((await run(store)).applied).toBe(1);
    await seedPending(owner, 'high', 60); // fresh evidence, but within cooldown
    expect((await run(store)).applied).toBe(0);
    expect((await auditRows(owner)).filter((r) => r.trigger === 'apply')).toHaveLength(1);
  });

  it('stale-revision evidence is discarded (audited), current applies', async () => {
    const { owner } = await seedLearningTenant('discard');
    const store = new RedisLearningStore(redis, now);
    await seedPending(owner, 'high', 60, 'sha256:staleRev'); // stale
    await seedPending(owner, 'high', 60); // current
    const sum = await run(store);
    expect(sum.discarded).toBe(1);
    expect(sum.applied).toBe(1);
    const triggers = (await auditRows(owner)).map((r) => r.trigger);
    expect(triggers).toContain('discard_revision');
    expect(triggers).toContain('apply');
  });

  it('port CAS is idempotent: a crash-after-commit retry returns duplicate, one audit row', async () => {
    const { owner, principal } = await seedLearningTenant('idem');
    const event = {
      occurrenceId: `${owner}:idem`,
      trigger: 'apply' as const,
      epoch: 0,
      generation: 1,
      highSamples: 60,
      reason: 'apply',
    };
    const first = await port.routingSettings.recordLearningApply(
      principal,
      { epoch: 0, generation: 0 },
      event,
    );
    const retry = await port.routingSettings.recordLearningApply(
      principal,
      { epoch: 0, generation: 0 },
      event,
    );
    expect(first).toBe('applied');
    expect(retry).toBe('duplicate');
    expect(await auditRows(owner)).toHaveLength(1);
    expect((await port.routingSettings.get(principal))?.semanticLearningGeneration).toBe(1);
  });

  it('revert bumps the epoch, resets the generation, and audits', async () => {
    const { owner, principal } = await seedLearningTenant('revert');
    const store = new RedisLearningStore(redis, now);
    await seedPending(owner, 'high', 60);
    await run(store); // generation → 1, active promoted
    const coords = await port.routingSettings.revertLearning(principal, 'test revert');
    expect(coords).toEqual({ epoch: 1, generation: 0 });
    const pref = await port.routingSettings.get(principal);
    expect(pref?.semanticLearningEpoch).toBe(1);
    expect(pref?.semanticLearningGeneration).toBe(0);
    expect((await auditRows(owner)).map((r) => r.trigger)).toContain('revert');
  });

  it('accumulator flushes only a ≥ MIN_COHORT sum to Redis — never a count-1 raw embedding', async () => {
    const { owner } = await seedLearningTenant('cohort');
    const acc = new EvidenceAccumulator(redis, SECRET);
    const hmac = hmacOf(owner);
    const opts = { minCohort: 8, maxCohorts: 4096, ttlSeconds: 3600 };
    const key = pendingBucketKey(hmac, 0, 'low', REV, dayStamp(Date.now()));
    for (let i = 0; i < 7; i += 1) acc.contribute(hmac, 0, 'low', REV, unit(1), opts);
    await new Promise((r) => setTimeout(r, 50));
    expect(await redis.exists(key)).toBe(0); // 7 < 8 → nothing persisted (no count-1)
    acc.contribute(hmac, 0, 'low', REV, unit(1), opts); // the 8th fills the cohort
    await new Promise((r) => setTimeout(r, 100));
    const buf = await redis.getBuffer(key);
    expect(buf).not.toBeNull();
    const nl = (buf as Buffer).indexOf(0x0a);
    expect(Number((buf as Buffer).subarray(0, nl).toString())).toBe(8); // count is the cohort, never 1
    acc.onApplicationShutdown();
  });
});
