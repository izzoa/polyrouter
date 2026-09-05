// add-batch-inference task 3.5: the pending reservation against REAL Redis + Postgres
// — the atomic check-and-reserve under a two-instance race, the interleaved
// reconciliation, the leaked-reservation heal, the fail mode, and the key-slot
// proof that every key one script invocation touches shares one cluster slot.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_MAINTENANCE,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  userPrincipal,
  type BatchJobInsertInput,
  type PersistenceMaintenance,
  type PersistencePort,
} from '@polyrouter/shared/server';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { DatabaseModule } from '../../src/database/database.module';
import { DatabaseMaintenanceModule } from '../../src/database/maintenance.module';
import { RedisModule } from '../../src/redis/redis.module';
import { BUDGET_READER, type BudgetReader } from '../../src/database/budget.reader';
import { SpendCounter } from '../../src/budgets/spend-counter';
import { BudgetCache } from '../../src/budgets/budget-cache';
import { BudgetService, BudgetEnforcementUnavailableError } from '../../src/budgets/budget-service';
import { runBudgetOccurrence } from '../../src/budgets/budget.scheduler';
import { periodInfo, toMicros } from '../../src/budgets/period';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { ProxyMetrics } from '../../src/observability/proxy-metrics';
import type { BudgetsConfig } from '../../src/budgets/budgets.config';
import '../../src/database/database.config';
import '../../src/redis/redis.config';

const HINT = 'Dev Postgres/Redis unreachable — docker compose -f docker-compose.dev.yml up -d';
const STALE_MS = 180_000;
const HEARTBEAT = 'budget:reconcile:heartbeat';

const CFG = (failOpen: boolean): BudgetsConfig => ({
  redisTimeoutMs: 1_000,
  reconcileTimeoutMs: 2_000,
  cacheTtlMs: 10_000,
  cacheMax: 5_000,
  failOpen,
  schedEnabled: false,
  schedCron: '* * * * *',
  staleMs: STALE_MS,
});

/** Redis Cluster's key → slot function: CRC16/XMODEM over the hash tag (the
 * text between the first `{` and the next `}`) or, without one, the whole key. */
function crc16(buf: Buffer): number {
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
function keySlot(key: string): number {
  const s = key.indexOf('{');
  if (s !== -1) {
    const e = key.indexOf('}', s + 1);
    if (e > s + 1) return crc16(Buffer.from(key.slice(s + 1, e))) % 16384;
  }
  return crc16(Buffer.from(key)) % 16384;
}

describe('batch reservations — real infra (add-batch-inference D8)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let reader: BudgetReader;
  let port: PersistencePort;
  let maintenance: PersistenceMaintenance;
  const counters: SpendCounter[] = [];
  const userIds: string[] = [];
  const producers = {
    budgetAlert: () => undefined,
    budgetBlock: () => undefined,
  } as unknown as NotificationProducers;

  async function makeUser(label: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,false)',
      [id, label, `${label}-${id}@reservation.test`],
    );
    userIds.push(id);
    return id;
  }

  /** A budget service the way a proxy INSTANCE holds one: its own counter connections. */
  function instance(failOpen = true): { svc: BudgetService; counter: SpendCounter } {
    const counter = new SpendCounter(redis, CFG(failOpen));
    counters.push(counter);
    const cache = new BudgetCache(port, CFG(failOpen));
    const svc = new BudgetService(
      cache,
      counter,
      producers,
      new ProxyMetrics(),
      reader,
      CFG(failOpen),
    );
    return { svc, counter };
  }

  const jobValues = (agentId: string, ceiling: number | null): BatchJobInsertInput => ({
    id: `job-${randomUUID()}`,
    agentId,
    providerId: 'p',
    modelId: 'm',
    tierAssigned: null,
    endpoint: '/v1/chat/completions',
    protocol: 'openai_compatible',
    providerKind: 'api_key',
    itemCount: 1,
    estimatedInputTokens: 10,
    priceMode: 'batch',
    inputPriceSnapshot: 1,
    outputPriceSnapshot: 2,
    cacheReadPriceSnapshot: null,
    cacheWritePriceSnapshot: null,
    priceVersionId: 'v',
    priceSource: 'bundled',
    reservedCeilingMicros: ceiling,
    completionWindowMs: 86_400_000,
  });

  const monthKey = (owner: string, counter: SpendCounter): string =>
    counter.key(
      owner,
      'global',
      'global',
      'month',
      periodInfo('month', new Date()).periodId,
      'notional',
    );

  beforeAll(async () => {
    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      await pool.end();
      throw new Error(`${HINT}\n(${(e as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, DatabaseMaintenanceModule, RedisModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    reader = app.get<BudgetReader>(BUDGET_READER);
    redis = app.get<Redis>(REDIS_CLIENT);
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    maintenance = app.get<PersistenceMaintenance>(PERSISTENCE_MAINTENANCE);
    await redis.set(HEARTBEAT, String(Date.now()));
  }, 60_000);

  afterAll(async () => {
    if (userIds.length > 0) await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [userIds]);
    for (const c of counters) c.onApplicationShutdown();
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    await redis.set(HEARTBEAT, String(Date.now()));
  });

  async function budgetedUser(label: string, amount: number): Promise<string> {
    const owner = await makeUser(label);
    await port.budgets.insert(userPrincipal(owner), {
      name: `${label}-cap`,
      scope: 'global',
      agentId: null,
      window: 'month',
      action: 'block',
      amount,
      notifyChannelIds: '',
      enabled: true,
    });
    return owner;
  }

  it('two instances racing for one remaining budget admit exactly one', async () => {
    const owner = await budgetedUser('race', 10);
    const principal = userPrincipal(owner);
    const a = instance();
    const b = instance();
    await Promise.all([a.counter.waitReady(), b.counter.waitReady()]);
    const results = await Promise.all(
      Array.from(
        { length: 6 },
        (_, i) => (i % 2 === 0 ? a : b).svc.reserveForBatch(principal, null, toMicros(6)), // $6 each; $10 fits one
      ),
    );
    const outcomes = results.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'reserved')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'rejected')).toHaveLength(5);
    const [v] = await a.counter.readWithPending([monthKey(owner, a.counter)]);
    expect(v).toEqual({ spend: 0, pending: toMicros(6) });
    // The rejection names the budget and carries what it saw.
    const rejected = results.find((r) => r.outcome === 'rejected');
    if (rejected?.outcome === 'rejected') {
      expect(rejected.hit.budget.name).toBe('race-cap');
      expect(rejected.hit.pendingMicros).toBe(toMicros(6));
      expect(rejected.ceilingMicros).toBe(toMicros(6));
    }
  });

  it('a reconciliation interleaved between the job row and the Redis add cannot erase the reservation', async () => {
    const owner = await budgetedUser('interleave', 100);
    const principal = userPrincipal(owner);
    const { svc, counter } = instance();
    await counter.waitReady();
    // (1) the job row, with its ceiling, BEFORE the Redis add (D6/D8)
    const row = await port.batchJobs.insert(principal, jobValues('ag', toMicros(4)));
    // (2) the scheduler runs in between: pending is recomputed FROM the rows
    await runBudgetOccurrence(
      reader,
      counter,
      producers,
      Date.now(),
      STALE_MS,
      maintenance.reservations,
    );
    let [v] = await counter.readWithPending([monthKey(owner, counter)]);
    expect(v!.pending).toBe(toMicros(4)); // the submitting row is already counted
    // (3) the Redis add lands: a brief over-count — the reservation was never lost
    expect((await svc.reserveForBatch(principal, 'ag', toMicros(4))).outcome).toBe('reserved');
    [v] = await counter.readWithPending([monthKey(owner, counter)]);
    expect(v!.pending).toBe(toMicros(8));
    // (4) the next reconcile settles on the rows' truth
    await runBudgetOccurrence(
      reader,
      counter,
      producers,
      Date.now(),
      STALE_MS,
      maintenance.reservations,
    );
    [v] = await counter.readWithPending([monthKey(owner, counter)]);
    expect(v!.pending).toBe(toMicros(4));
    // and once the job is terminal, the reservation is gone at the next reconcile
    await port.batchJobs.update(principal, row.id, { status: 'finalizing' });
    await port.batchJobs.settle(principal, row.id, {
      status: 'completed',
      completedCount: 1,
      failedCount: 0,
      settledCostMicros: 1,
      terminalAt: new Date(),
    });
    await runBudgetOccurrence(
      reader,
      counter,
      producers,
      Date.now(),
      STALE_MS,
      maintenance.reservations,
    );
    [v] = await counter.readWithPending([monthKey(owner, counter)]);
    expect(v!.pending).toBe(0);
  });

  it('a leaked reservation (no row behind it) heals after one reconcile; a null ceiling reserves nothing', async () => {
    const owner = await budgetedUser('leak', 100);
    const principal = userPrincipal(owner);
    const { svc, counter } = instance();
    await counter.waitReady();
    expect((await svc.reserveForBatch(principal, null, toMicros(7))).outcome).toBe('reserved'); // the poller then "crashes" before releasing
    await port.batchJobs.insert(principal, jobValues('ag', null)); // an unbounded job admitted without a block budget elsewhere: contributes 0
    await runBudgetOccurrence(
      reader,
      counter,
      producers,
      Date.now(),
      STALE_MS,
      maintenance.reservations,
    );
    const [v] = await counter.readWithPending([monthKey(owner, counter)]);
    expect(v!.pending).toBe(0);
  });

  it('a stale heartbeat follows the named fail mode, exactly like the synchronous check', async () => {
    const owner = await budgetedUser('stale', 100);
    const principal = userPrincipal(owner);
    await redis.set(HEARTBEAT, String(Date.now() - 10 * STALE_MS));
    const open = instance(true);
    await open.counter.waitReady();
    expect((await open.svc.reserveForBatch(principal, null, toMicros(1))).outcome).toBe(
      'unenforced',
    );
    const closed = instance(false);
    await closed.counter.waitReady();
    await expect(closed.svc.reserveForBatch(principal, null, toMicros(1))).rejects.toBeInstanceOf(
      BudgetEnforcementUnavailableError,
    );
    // Nothing was recorded either way (the row's ceiling is what the reconcile reads).
    const [v] = await open.counter.readWithPending([monthKey(owner, open.counter)]);
    expect(v!.pending).toBe(0);
  });

  it('every key one check-and-reserve touches shares one cluster slot (the real slot function)', () => {
    expect(keySlot('foo')).toBe(12182); // the documented reference vector
    expect(keySlot('{user1000}.following')).toBe(keySlot('{user1000}.followers'));
    const counter = new SpendCounter(redis, CFG(true));
    counters.push(counter);
    for (const [scope, sid, window, basis] of [
      ['global', 'global', 'day', 'notional'],
      ['agent', 'ag-1', 'week', 'cash'],
      ['global', 'global', 'month', 'cash'],
    ] as const) {
      const spend = counter.key('owner-1', scope, sid, window, '2026-09', basis);
      const pending = counter.pendingKeyFor(spend);
      expect(spend).not.toContain('{'); // the spend key is untouched (upgrade-safe)
      expect(keySlot(pending)).toBe(keySlot(spend));
    }
    // Different budgets need not share a slot — which is exactly why the script
    // runs once per budget key rather than once per owner.
    const g = counter.key('owner-1', 'global', 'global', 'day', '2026-09-05', 'notional');
    const a = counter.key('owner-1', 'agent', 'ag-1', 'day', '2026-09-05', 'notional');
    expect(g).not.toBe(a);
  });
});
