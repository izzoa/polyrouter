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
import { ProxyMetrics } from '../../src/observability/proxy-metrics';
import type { BudgetsConfig } from '../../src/budgets/budgets.config';
import type { ProducersConfig } from '../../src/producers/producers.config';
import type { NotificationService } from '../../src/notifications/notification.service';
import type { NotificationEvent } from '../../src/notifications/notification.types';
import '../../src/database/database.config';
import '../../src/redis/redis.config';

const HINT = 'Dev Postgres/Redis unreachable — docker compose -f docker-compose.dev.yml up -d';
const STALE_MS = 180_000;

const METRICS = new ProxyMetrics();
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

  /** Rows for a request no provider ran, as the recorder writes them
   * (zero-cost-unbilled-errors): an `error` row with the routing-grade token estimate
   * and a snapshot-source rate kept as evidence, and `cost = 0` + `billed = false`.
   * `legacy` writes the PRE-change shape of the same request instead: the estimate
   * priced into `cost` (54,040 tokens at $2/1M) with the marker NULL. */
  async function seedBurst(
    owner: string,
    count: number,
    shape: 'not_billed' | 'legacy',
    at: Date,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      await pool.query(
        `INSERT INTO request_log
          (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens, duration_ms, status, cost, usage_estimated, price_source, provider_kind, billed, created_at)
         VALUES ($1,$2,'default','test',54040,0,1,'error',$3,true,'native_family','api_key',$4,$5)`,
        [
          randomUUID(),
          owner,
          shape === 'legacy' ? 0.10808 : 0,
          shape === 'legacy' ? null : false,
          at,
        ],
      );
    }
  }
  /** One billed, exactly-priced success row: the real spend a burst must not move. */
  async function seedExact(owner: string, cost: number, at: Date): Promise<void> {
    await pool.query(
      `INSERT INTO request_log
        (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens, duration_ms, status, cost, price_source, provider_kind, billed, created_at)
       VALUES ($1,$2,'default','test',0,0,1,'success',$3,'bundled','api_key',true,$4)`,
      [randomUUID(), owner, cost, at],
    );
  }
  async function globalBudget(
    owner: string,
    action: 'block' | 'alert',
    amount: number,
  ): Promise<void> {
    await port.budgets.insert(userPrincipal(owner), {
      name: `${action}-burst`,
      scope: 'global',
      agentId: null,
      window: 'month',
      action,
      amount,
      notifyChannelIds: '',
      enabled: true,
    });
  }

  const globalKey = (owner: string, w: 'day' | 'week' | 'month') =>
    counter.key(owner, 'global', 'global', w, periodInfo(w, new Date()).periodId, 'notional');
  const agentKey = (owner: string, agentId: string, w: 'day' | 'week' | 'month') =>
    counter.key(owner, 'agent', agentId, w, periodInfo(w, new Date()).periodId, 'notional');

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

    const svc = new BudgetService(
      new BudgetCache(port, CFG(true)),
      counter,
      producers,
      METRICS,
      reader,
      CFG(true),
    );
    const hit = await svc.checkBlocked(principal, null);
    expect(hit).not.toBeNull();
    expect(hit!.budget.amount).toBe(5);
    expect(hit!.spentMicros).toBe(12_000_000);

    // a different owner (no budgets, no spend) is unaffected
    const other = await makeUser('blk-other');
    expect(await svc.checkBlocked(userPrincipal(other), null)).toBeNull();
  });

  describe('requests no provider ran (zero-cost-unbilled-errors)', () => {
    const service = (producers: NotificationProducers): BudgetService =>
      new BudgetService(
        new BudgetCache(port, CFG(true)),
        counter,
        producers,
        METRICS,
        reader,
        CFG(true),
      );

    it('a burst of not-billed rows leaves the reconciled counter unchanged and the next request admitted', async () => {
      const owner = await makeUser('burst');
      const principal = userPrincipal(owner);
      const now = new Date();
      // $3 of real spend under a $3.50 block cap.
      await seedExact(owner, 3, now);
      await globalBudget(owner, 'block', 3.5);
      const producers = capturingProducers();
      await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS);
      expect((await counter.read([globalKey(owner, 'month')]))[0]).toBe(3_000_000);
      expect(await service(producers).checkBlocked(principal, null)).toBeNull();

      // The field report: six `auto` requests in four seconds, every chain member
      // skipped by an open circuit. Priced as before, they would add $0.65 and trip the cap.
      await seedBurst(owner, 6, 'not_billed', new Date());
      await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS);

      expect((await counter.read([globalKey(owner, 'month')]))[0]).toBe(3_000_000);
      const spend = await reader.spendMicrosFor(
        owner,
        null,
        new Date(now.getTime() - 60_000),
        new Date(Date.now() + 60_000),
        'notional',
      );
      expect(spend).toMatchObject({ micros: 3_000_000, estimatedMicros: 0 });
      // The next request is admitted: nothing blocks the agent.
      expect(await service(producers).checkBlocked(principal, null)).toBeNull();
    });

    it('the same burst recorded the pre-change way trips the block (the contrast)', async () => {
      const owner = await makeUser('burst-legacy');
      const principal = userPrincipal(owner);
      const now = new Date();
      await seedExact(owner, 3, now);
      await seedBurst(owner, 6, 'legacy', now);
      await globalBudget(owner, 'block', 3.5);
      const producers = capturingProducers();
      await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS);
      // 3.00 + 6 x round(0.10808 x 1e6) µ$: legacy rows keep metering exactly as recorded,
      // and the estimate provenance they raise is still reported.
      expect((await counter.read([globalKey(owner, 'month')]))[0]).toBe(3_648_480);
      const hit = await service(producers).checkBlocked(principal, null);
      expect(hit).not.toBeNull();
      expect(hit!.spentMicros).toBe(3_648_480);
      const spend = await reader.spendMicrosFor(
        owner,
        null,
        new Date(now.getTime() - 60_000),
        new Date(Date.now() + 60_000),
        'notional',
      );
      expect(spend.estimatedMicros).toBe(648_480);
    });

    it('the alert is not flagged as estimated when its only estimates are not-billed rows', async () => {
      const clean = await makeUser('alert-unbilled');
      const legacy = await makeUser('alert-legacy');
      const now = new Date();
      for (const owner of [clean, legacy]) {
        await seedExact(owner, 10, now);
        await seedBurst(owner, 4, owner === clean ? 'not_billed' : 'legacy', now);
        await globalBudget(owner, 'alert', 5);
      }
      const { svc, events } = capture();
      const producers = new NotificationProducers(svc, redis, PRODUCERS_CFG);
      await runBudgetOccurrence(reader, counter, producers, Date.now(), STALE_MS);

      const alertFor = (owner: string) =>
        events.filter((e) => e.type === 'budget_alert' && e.scope.ownerUserId === owner);
      expect(alertFor(clean)).toHaveLength(1);
      // The producer carries `spendEstimated` only when true or unknown: absent = exact.
      expect(alertFor(clean)[0]!.fields).toMatchObject({ spent: '$10.00', threshold: '$5.00' });
      expect(alertFor(clean)[0]!.fields).not.toHaveProperty('spendEstimated');
      // The legacy shape of the same burst still says the figure is an estimate.
      expect(alertFor(legacy)).toHaveLength(1);
      expect(alertFor(legacy)[0]!.fields).toMatchObject({ spendEstimated: 'true' });
    });
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
      METRICS,
      reader,
      CFG(true),
    );
    expect(await open.checkBlocked(principal, null)).toBeNull(); // fail-open allows

    const closed = new BudgetService(
      new BudgetCache(port, CFG(false)),
      counter,
      capturingProducers(),
      METRICS,
      reader,
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
