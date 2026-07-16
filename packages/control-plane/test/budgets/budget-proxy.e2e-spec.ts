// Budget block enforcement through the real proxy path (#16). A slim proxy module
// wires the REAL BudgetService (fail-closed here) over a shared Redis counter that
// an out-of-band reconcile sets, plus a request-counting stub upstream — so we can
// assert a 402/503 is returned BEFORE any upstream call, streaming included.
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  userPrincipal,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  createProviderAdapter,
} from '@polyrouter/data-plane';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { configureApp } from '../../src/app.setup';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import { mintAgentKey } from '../../src/agents/agent-keys';
import { ChatCompletionsController } from '../../src/proxy/chat-completions.controller';
import { MessagesController } from '../../src/proxy/messages.controller';
import { ProxyExceptionFilter } from '../../src/proxy/proxy-exception.filter';
import {
  PROXY_ADAPTER_FACTORY,
  PROXY_BREAKER,
  PROXY_RUNTIME,
  loadProxyRuntime,
} from '../../src/proxy/proxy.config';
import { ProxyService } from '../../src/proxy/proxy.service';
import { RequestRecorder } from '../../src/recording/request-recorder';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { BudgetService } from '../../src/budgets/budget-service';
import { BudgetCache } from '../../src/budgets/budget-cache';
import { SpendCounter } from '../../src/budgets/spend-counter';
import { BUDGETS_CONFIG, resolveBudgetsConfig } from '../../src/budgets/budgets.config';
import { BUDGET_READER, type BudgetReader } from '../../src/database/budget.reader';
import { runBudgetOccurrence } from '../../src/budgets/budget.scheduler';
import { DatabaseModule } from '../../src/database/database.module';
import { RedisModule } from '../../src/redis/redis.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import type { StubUpstream } from '../proxy/stub-upstream';
import '../../src/database/database.config';
import '../../src/redis/redis.config';
import '../../src/auth/auth.config';
import '../../src/budgets/budgets.config';

const HMAC = 'b'.repeat(64);
const HEARTBEAT = 'budget:reconcile:heartbeat';

interface Tenant {
  principal: Principal;
  userId: string;
  key: string;
}

let blockThrows = false;

async function seedTenant(
  port: PersistencePort,
  pool: Pool,
  label: string,
  stubUrl: string,
  budget: { amount: number },
): Promise<Tenant> {
  const userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${Date.now()}@bproxy.test`],
    )
  ).rows[0]!.id;
  const principal = userPrincipal(userId);
  const provider = await port.providers.insert(principal, {
    name: 'stub',
    kind: 'local',
    protocol: 'openai_compatible',
    baseUrl: stubUrl,
  });
  const model = await port.models.createForProvider(principal, provider.id, {
    externalModelId: 'gpt-4o',
  });
  await port.ensureDefaultTier(principal);
  const def = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
  await port.routingEntries.replaceForTier(principal, def.id, [model!.id]);
  await port.budgets.insert(principal, {
    name: `${label}-cap`,
    scope: 'global',
    agentId: null,
    window: 'month',
    action: 'block',
    amount: budget.amount,
    notifyChannelIds: '',
    enabled: true,
  });
  const minted = mintAgentKey(HMAC);
  await pool.query(
    `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
     VALUES (gen_random_uuid(), $1, 'agent', $2, $3, 'curl')`,
    [userId, minted.hash, minted.prefix],
  );
  return { principal, userId, key: minted.key };
}

describe('budget block enforcement — proxy path (#16)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let redis: Redis;
  let reader: BudgetReader;
  let counter: SpendCounter;
  let stub: StubUpstream;
  let over: Tenant; // spend far above its budget
  let under: Tenant; // spend far below its budget

  async function seedSpend(owner: string, cost: number): Promise<void> {
    await pool.query(
      `INSERT INTO request_log
        (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens, duration_ms, status, cost, created_at)
       VALUES (gen_random_uuid(),$1,'default','test',0,0,1,'success',$2, now())`,
      [owner, cost],
    );
  }
  const reconcile = () =>
    runBudgetOccurrence(reader, counter, app.get(NotificationProducers), Date.now(), 180_000);
  const freshHeartbeat = () => redis.set(HEARTBEAT, String(Date.now()));
  const staleHeartbeat = () => redis.set(HEARTBEAT, String(Date.now() - 10 * 180_000));

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    process.env['BUDGET_FAIL_OPEN'] = 'false'; // fail-closed so a stale heartbeat → 503
    const { startStubUpstream } = await import('../proxy/stub-upstream');
    stub = await startStubUpstream();

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, RedisModule],
      controllers: [ChatCompletionsController, MessagesController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        StreamDrainRegistry,
        {
          provide: RequestRecorder,
          useValue: { record: () => undefined, recordAttempt: () => undefined },
        },
        {
          provide: StructuralRouter,
          useValue: { enabled: false, evaluate: () => Promise.resolve({ kind: 'skip' }) },
        },
        { provide: CascadeRouter, useValue: { enabled: false, plan: () => null } },
        {
          // A throwing producer proves notifyBlocked can't block enforcement.
          provide: NotificationProducers,
          useValue: {
            providerDown: () => undefined,
            onRequestFailed: () => Promise.resolve(),
            budgetAlert: () => undefined,
            budgetBlock: () => {
              if (blockThrows) throw new Error('notify down');
            },
          },
        },
        { provide: BUDGETS_CONFIG, useFactory: resolveBudgetsConfig },
        SpendCounter,
        BudgetCache,
        BudgetService,
        { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
        { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
        { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.enableShutdownHooks();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();

    const port = app.get<PersistencePort>(PERSISTENCE_PORT);
    reader = app.get<BudgetReader>(BUDGET_READER);
    counter = app.get(SpendCounter);
    redis = app.get<Redis>(REDIS_CLIENT);
    await counter.waitReady();

    over = await seedTenant(port, pool, 'over', stub.url, { amount: 5 });
    under = await seedTenant(port, pool, 'under', stub.url, { amount: 100 });
    await seedSpend(over.userId, 20); // $20 spent vs a $5 cap
    await seedSpend(under.userId, 1); // $1 spent vs a $100 cap
    await reconcile(); // sole writer sets both counters + the heartbeat
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[over.userId, under.userId]]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  beforeEach(() => {
    blockThrows = false;
  });

  const chat = (key: string, body: unknown) =>
    request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send(body as object);

  it('rejects an over-budget request with 402 and makes NO upstream call', async () => {
    await freshHeartbeat();
    const before = stub.requests.length;
    const res = await chat(over.key, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('budget_exceeded');
    expect(res.body.error.message).toMatch(/budget exceeded: over-cap \(resets /);
    expect(stub.requests.length).toBe(before); // pre-upstream rejection
  });

  it('rejects an over-budget STREAMING request cleanly before the first byte', async () => {
    await freshHeartbeat();
    const before = stub.requests.length;
    const res = await chat(over.key, {
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('budget_exceeded');
    expect(stub.requests.length).toBe(before);
  });

  it('lets an under-budget request proceed to the upstream (200)', async () => {
    await freshHeartbeat();
    const before = stub.requests.length;
    const res = await chat(under.key, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(stub.requests.length).toBe(before + 1);
  });

  it('a stopped scheduler (stale heartbeat) fails closed with 503, no upstream call', async () => {
    await staleHeartbeat();
    const before = stub.requests.length;
    const res = await chat(over.key, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('budget_enforcement_unavailable');
    expect(stub.requests.length).toBe(before);
  });

  it('a broken notification channel never blocks the rejection (fire-and-forget)', async () => {
    await freshHeartbeat();
    blockThrows = true; // producers.budgetBlock throws
    const res = await chat(over.key, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(402); // still promptly rejected
  });
});
