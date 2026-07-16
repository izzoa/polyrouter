// Budget reconcile + enforcement e2e against real Postgres + Redis. Exercises the
// BUDGET_READER SQL (both ledgers, row-level micros, agentId join), the shared
// Redis counter (no per-instance drift), the named fail mode, and once-per-period
// alerts — without mounting the proxy (that path is asserted in budget-proxy.e2e).
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  userPrincipal,
  type PersistencePort,
} from '@polyrouter/shared/server';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { DatabaseModule } from '../../src/database/database.module';
import { RedisModule } from '../../src/redis/redis.module';
import { BUDGET_READER, type BudgetReader } from '../../src/database/budget.reader';
import { SpendCounter } from '../../src/budgets/spend-counter';
import { BudgetCache } from '../../src/budgets/budget-cache';
import { BudgetService, BudgetEnforcementUnavailableError } from '../../src/budgets/budget-service';
import { BudgetScheduler, runBudgetOccurrence } from '../../src/budgets/budget.scheduler';
import { periodInfo } from '../../src/budgets/period';
import { NotificationProducers } from '../../src/producers/notification-producers';
import type { BudgetsConfig } from '../../src/budgets/budgets.config';
import type { ProducersConfig } from '../../src/producers/producers.config';
import type { NotificationService } from '../../src/notifications/notification.service';
import type { NotificationEvent } from '../../src/notifications/notification.types';
import '../../src/database/database.config';
import '../../src/redis/redis.config';

const HINT = 'Dev Postgres/Redis unreachable — docker compose -f docker-compose.dev.yml up -d';
const STALE_MS = 180_000;

const CFG = (failOpen: boolean): BudgetsConfig => ({
  redisTimeoutMs: 1_000,
  cacheTtlMs: 10_000,
  cacheMax: 5_000,
  failOpen,
  schedEnabled: false,
  schedCron: '* * * * *',
  staleMs: STALE_MS,
});

const PRODUCERS_CFG: ProducersConfig = {
  mode: 'selfhosted',
  allowedEndpoints: [],
  systemSmtp: undefined,
  failureThreshold: 3,
  failureWindowMs: 900_000,
  weeklyEnabled: false,
  weeklyCron: '0 8 * * 1',
};

function capture(): { svc: NotificationService; events: NotificationEvent[] } {
  const events: NotificationEvent[] = [];
  const svc = {
    emit: (e: NotificationEvent) => {
      events.push(e);
      return Promise.resolve();
    },
  } as unknown as NotificationService;
  return { svc, events };
}

describe('budget reconcile + enforcement — real infra (#16)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let reader: BudgetReader;
  let port: PersistencePort;
  let counter: SpendCounter;
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,false)',
      [id, label, `${label}-${id}@budget.test`],
    );
    userIds.push(id);
    return id;
  }

  async function seedLog(
    owner: string,
    agentId: string | null,
    cost: number | null,
    at: Date,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO request_log
        (id, owner_user_id, agent_id, decision_layer, routing_reason, input_tokens, output_tokens, duration_ms, status, cost, created_at)
       VALUES ($1,$2,$3,'default','test',0,0,1,'success',$4,$5)`,
      [id, owner, agentId, cost, at],
    );
    return id;
  }
  async function seedAttempt(
    logId: string,
    owner: string,
    cost: number | null,
    at: Date,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO request_attempt
        (id, request_log_id, owner_user_id, attempt_index, input_tokens, output_tokens, status, cost, created_at)
       VALUES ($1,$2,$3,0,0,0,'success',$4,$5)`,
      [randomUUID(), logId, owner, cost, at],
    );
  }

  const globalKey = (owner: string, w: 'day' | 'week' | 'month') =>
    counter.key(owner, 'global', 'global', w, periodInfo(w, new Date()).periodId);
  const agentKey = (owner: string, agentId: string, w: 'day' | 'week' | 'month') =>
    counter.key(owner, 'agent', agentId, w, periodInfo(w, new Date()).periodId);

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
      imports: [DatabaseModule, RedisModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    reader = app.get<BudgetReader>(BUDGET_READER);
    redis = app.get<Redis>(REDIS_CLIENT);
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    counter = new SpendCounter(redis, CFG(true));
    await counter.waitReady();
  }, 60_000);

  afterAll(async () => {
    if (userIds.length > 0) await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [userIds]);
    counter.onApplicationShutdown();
    await app?.close();
    await pool?.end();
  });

  it('reconciles both ledgers as row-level micros, honoring scope + the agentId join', async () => {
    const owner = await makeUser('rec');
    const principal = userPrincipal(owner);
    const now = new Date();
    const log1 = await seedLog(owner, 'ag1', 1.5, now); // agent ag1
    await seedAttempt(log1, owner, 0.5, now); //           attempt attributed to ag1 via parent
    await seedLog(owner, 'ag2', 10, now); //               a different agent
    await seedLog(owner, 'ag1', null, now); //             unpriced → 0

    await port.budgets.insert(principal, {
      name: 'g',
      scope: 'global',
      agentId: null,
      window: 'month',
      action: 'block',
      amount: 1000,
      notifyChannelIds: '',
      enabled: true,
    });
    await port.budgets.insert(principal, {
      name: 'a',
      scope: 'agent',
      agentId: 'ag1',
      window: 'month',
      action: 'block',
      amount: 1000,
      notifyChannelIds: '',
      enabled: true,
    });

    const producers = new NotificationProducers(capture().svc, redis, PRODUCERS_CFG);
    await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS);

    const [g, a] = await counter.read([globalKey(owner, 'month'), agentKey(owner, 'ag1', 'month')]);
    expect(g).toBe(12_000_000); // 1.5 + 0.5 + 10 (+ 0)
    expect(a).toBe(2_000_000); //  1.5 + 0.5 (ag2 excluded; null → 0)
  });

  it('the shared counter is seen identically from a second instance (no per-instance drift)', async () => {
    const owner = await makeUser('drift');
    const principal = userPrincipal(owner);
    await seedLog(owner, null, 7, new Date());
    await port.budgets.insert(principal, {
      name: 'g',
      scope: 'global',
      agentId: null,
      window: 'day',
      action: 'block',
      amount: 1000,
      notifyChannelIds: '',
      enabled: true,
    });
    const producers = new NotificationProducers(capture().svc, redis, PRODUCERS_CFG);
    await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS);

    const other = new SpendCounter(redis, CFG(true));
    await other.waitReady();
    const [v] = await other.read([globalKey(owner, 'day')]);
    expect(v).toBe(7_000_000);
    other.onApplicationShutdown();
  });

  it('checkBlocked returns a hit at/over threshold and is owner-scoped', async () => {
    const owner = await makeUser('blk');
    const principal = userPrincipal(owner);
    await seedLog(owner, null, 12, new Date());
    await port.budgets.insert(principal, {
      name: 'cap',
      scope: 'global',
      agentId: null,
      window: 'month',
      action: 'block',
      amount: 5,
      notifyChannelIds: '',
      enabled: true,
    });
    const producers = new NotificationProducers(capture().svc, redis, PRODUCERS_CFG);
    await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS);

    const svc = new BudgetService(new BudgetCache(port, CFG(true)), counter, producers, CFG(true));
    const hit = await svc.checkBlocked(principal, null);
    expect(hit).not.toBeNull();
    expect(hit!.budget.amount).toBe(5);
    expect(hit!.spentMicros).toBe(12_000_000);

    // a different owner (no budgets, no spend) is unaffected
    const other = await makeUser('blk-other');
    expect(await svc.checkBlocked(userPrincipal(other), null)).toBeNull();
  });

  it('routes a stale reconcile heartbeat through the named fail mode', async () => {
    const owner = await makeUser('stale');
    const principal = userPrincipal(owner);
    await port.budgets.insert(principal, {
      name: 'cap',
      scope: 'global',
      agentId: null,
      window: 'day',
      action: 'block',
      amount: 1,
      notifyChannelIds: '',
      enabled: true,
    });
    // A healthy Redis but a stale heartbeat (scheduler stopped): counters can't be trusted.
    await redis.set('budget:reconcile:heartbeat', String(Date.now() - STALE_MS - 5_000));

    const open = new BudgetService(
      new BudgetCache(port, CFG(true)),
      counter,
      capturingProducers(),
      CFG(true),
    );
    expect(await open.checkBlocked(principal, null)).toBeNull(); // fail-open allows

    const closed = new BudgetService(
      new BudgetCache(port, CFG(false)),
      counter,
      capturingProducers(),
      CFG(false),
    );
    await expect(closed.checkBlocked(principal, null)).rejects.toBeInstanceOf(
      BudgetEnforcementUnavailableError,
    );
  });

  it('emits budget_alert at most once per period, targeted to the budget’s channels', async () => {
    const owner = await makeUser('alert');
    const principal = userPrincipal(owner);
    await seedLog(owner, null, 10, new Date());
    await port.budgets.insert(principal, {
      name: 'watch',
      scope: 'global',
      agentId: null,
      window: 'month',
      action: 'alert',
      amount: 5,
      notifyChannelIds: 'chX,chY',
      enabled: true,
    });
    const { svc, events } = capture();
    const producers = new NotificationProducers(svc, redis, PRODUCERS_CFG);
    await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS);
    await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS); // same period → deduped

    const alerts = events.filter((e) => e.type === 'budget_alert' && e.scope.ownerUserId === owner);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.channelIds).toEqual(['chX', 'chY']);
    expect(alerts[0]!.fields).toMatchObject({ spent: '$10.00', threshold: '$5.00' });
  });

  it('scheduler bootstrap is non-blocking and reconciles cleanly on its own queue', async () => {
    const scheduler = new BudgetScheduler(redis, reader, counter, capturingProducers(), {
      ...CFG(true),
      schedEnabled: true,
    });
    // onApplicationBootstrap is fire-and-forget: returns synchronously, never throws
    // — so a down Redis at boot can't gate Layer 0 (invariant 1).
    expect(scheduler.onApplicationBootstrap()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 800)); // let the background reconcile register
    await scheduler.onApplicationShutdown();
    // remove the registered schedule so it doesn't linger on the dedicated queue.
    const conn = new Redis(loadConfig<{ REDIS_URL: string }>().REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    const q = new (await import('bullmq')).Queue('budget-eval', { connection: conn });
    await q.removeJobScheduler('budget-eval').catch(() => undefined);
    await q.close();
    conn.disconnect();
  }, 20_000);

  function capturingProducers(): NotificationProducers {
    return new NotificationProducers(capture().svc, redis, PRODUCERS_CFG);
  }
});
