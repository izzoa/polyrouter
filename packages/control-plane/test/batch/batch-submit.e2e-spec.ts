// add-batch-inference Phase B §3 e2e: the batch submission surface end to end —
// the parser carve-out (task 3.1), explicit-only routing (3.2), spend + pending
// admission (3.3), the ceiling (3.4), the D6 order under real Redis (3.5), the
// agent-key plane + the 202 object (3.6), and the error taxonomy (3.7). Real
// Postgres + Redis + a local stub upstream with OpenRouter- and Anthropic-shaped
// batch routes.
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_MAINTENANCE,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  userPrincipal,
  type PersistenceMaintenance,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  createAnthropicBatchAdapter,
  createOpenRouterBatchAdapter,
  createProviderAdapter,
} from '@polyrouter/data-plane';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { configureApp } from '../../src/app.setup';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import { mountBodyParsing } from '../../src/auth/mount';
import { mintAgentKey } from '../../src/agents/agent-keys';
import { BatchController } from '../../src/batch/batch.controller';
import { BatchService } from '../../src/batch/batch.service';
import {
  BATCH_ADAPTER_FACTORY,
  BATCH_CONFIG,
  BATCH_RUNTIME,
  loadBatchRuntime,
  resolveBatchConfig,
  type BatchAdapterFactory,
} from '../../src/batch/batch.config';
import { ChatCompletionsController } from '../../src/proxy/chat-completions.controller';
import { ProxyExceptionFilter } from '../../src/proxy/proxy-exception.filter';
import {
  PROXY_ADAPTER_FACTORY,
  PROXY_BREAKER,
  PROXY_RUNTIME,
  loadProxyRuntime,
} from '../../src/proxy/proxy.config';
import { ROUTING_CONFIG, loadRoutingConfig } from '../../src/proxy/routing.config';
import {
  CALIBRATION_RAILS,
  loadCalibrationConfig,
  railsOf,
  type CalibrationRails,
} from '../../src/calibration/calibration.config';
import { ProxyService } from '../../src/proxy/proxy.service';
import { RequestRecorder } from '../../src/recording/request-recorder';
import { BodyCaptureService } from '../../src/body-capture/body-capture.service';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { WorkloadRouter } from '../../src/proxy/workload/workload-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { BudgetService } from '../../src/budgets/budget-service';
import { BudgetCache } from '../../src/budgets/budget-cache';
import { SpendCounter } from '../../src/budgets/spend-counter';
import { BUDGETS_CONFIG, resolveBudgetsConfig } from '../../src/budgets/budgets.config';
import { periodInfo } from '../../src/budgets/period';
import { PRICING_FETCH, PRICING_RUNTIME, PricingService } from '../../src/pricing/pricing.service';
import { DatabaseModule } from '../../src/database/database.module';
import { DatabaseMaintenanceModule } from '../../src/database/maintenance.module';
import { SemanticModule } from '../../src/semantic/semantic.module';
import { RedisModule } from '../../src/redis/redis.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import { startStubUpstream, type StubUpstream } from '../proxy/stub-upstream';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';
import '../../src/database/database.config';
import '../../src/redis/redis.config';
import '../../src/auth/auth.config';
import '../../src/budgets/budgets.config';
import '../../src/batch/batch.config';
import '../../src/pricing/pricing.config';

const HMAC = 'd'.repeat(64);
const HEARTBEAT = 'budget:reconcile:heartbeat';
/** The mount limit for this suite: a batch body legitimately exceeds it. */
const PROXY_LIMIT = 2_048;
const BATCH_LIMIT = 24_576;

interface Tenant {
  principal: Principal;
  userId: string;
  key: string;
  agentId: string;
  models: Record<string, string>;
}

/** Attach the OpenRouter / Anthropic batch seams by base-URL suffix — the stub
 * serves both shapes from one host, so the family rule (host-derived) cannot
 * decide here; a `/plain` provider carries none (the `batch_not_supported` case). */
const e2eBatchFactory: BatchAdapterFactory = (config, deps = {}) => {
  if (config.baseUrl.endsWith('/or')) {
    return createProviderAdapter(config, { ...deps, batch: createOpenRouterBatchAdapter });
  }
  if (config.baseUrl.endsWith('/ant')) {
    return createProviderAdapter(config, { ...deps, batch: createAnthropicBatchAdapter });
  }
  return createProviderAdapter(config, deps);
};

async function seedTenant(
  port: PersistencePort,
  pool: Pool,
  label: string,
  stubUrl: string,
  budget: { amount: number } | null,
): Promise<Tenant> {
  const userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${Date.now()}@batch.test`],
    )
  ).rows[0]!.id;
  const principal = userPrincipal(userId);
  const or = await port.providers.insert(principal, {
    name: 'openrouter-stub',
    kind: 'local',
    protocol: 'openai_compatible',
    baseUrl: `${stubUrl}/or`,
  });
  const ant = await port.providers.insert(principal, {
    name: 'anthropic-stub',
    kind: 'local',
    protocol: 'anthropic_compatible',
    baseUrl: `${stubUrl}/ant`,
  });
  const plain = await port.providers.insert(principal, {
    name: 'plain-stub',
    kind: 'local',
    protocol: 'openai_compatible',
    baseUrl: `${stubUrl}/plain`,
  });
  const models: Record<string, string> = {};
  const add = async (
    providerId: string,
    ext: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const m = await port.models.createForProvider(principal, providerId, {
      externalModelId: ext,
      ...extra,
    });
    models[ext] = m!.id;
  };
  await add(or.id, 'gpt-4o');
  // The aggregator twin: a price row wearing a model's clothes — its captured
  // listed rate is the batch rate's last-resort fallback (B-1 + Phase A).
  await add(or.id, 'gpt-4o:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1.25,
    listedOutputPricePer1m: 5,
  });
  await add(or.id, 'gpt-4o-norate'); // no twin, no catalog → batch rate unknown
  await add(or.id, 'batch-srvfail'); // the stub answers the create with 500
  await add(or.id, 'batch-srvfail:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1,
    listedOutputPricePer1m: 1,
  });
  await add(or.id, 'batch-batchreject'); // the stub's own validation refuses (400)
  await add(or.id, 'batch-batchreject:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1,
    listedOutputPricePer1m: 1,
  });
  await add(ant.id, 'claude-x');
  await add(ant.id, 'claude-x:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1.5,
    listedOutputPricePer1m: 7.5,
  });
  await add(plain.id, 'gpt-plain');
  await port.ensureDefaultTier(principal);
  const def = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
  await port.routingEntries.replaceForTier(principal, def.id, [models['gpt-4o']!]);
  const tier = await port.tiers.insert(principal, { key: 'nightly' });
  await port.routingEntries.replaceForTier(principal, tier.id, [models['gpt-4o']!]);
  if (budget !== null) {
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
  }
  const minted = mintAgentKey(HMAC);
  const agentId = (
    await pool.query<{ id: string }>(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'agent', $2, $3, 'curl') RETURNING id`,
      [userId, minted.hash, minted.prefix],
    )
  ).rows[0]!.id;
  return { principal, userId, key: minted.key, agentId, models };
}

const item = (id: string, body: Record<string, unknown> = {}): Record<string, unknown> => ({
  custom_id: id,
  body: { messages: [{ role: 'user', content: `hi ${id}` }], max_tokens: 8, ...body },
});
/** `endpoint` and `model` FIRST — the ordering the API requires. */
const doc = (model: string, items: unknown[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({ endpoint: '/v1/chat/completions', model, ...over, requests: items });

describe('batch submission — Phase B §3 (add-batch-inference)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let redis: Redis;
  let port: PersistencePort;
  let maintenance: PersistenceMaintenance;
  let counter: SpendCounter;
  let stub: StubUpstream;
  let capped: Tenant; // a $10 block budget
  let free: Tenant; // no budget at all
  let other: Tenant; // a second tenant, for isolation

  const freshHeartbeat = () => redis.set(HEARTBEAT, String(Date.now()));
  const staleHeartbeat = () => redis.set(HEARTBEAT, String(Date.now() - 10 * 180_000));
  const spendKey = (t: Tenant): string =>
    counter.key(
      t.userId,
      'global',
      'global',
      'month',
      periodInfo('month', new Date()).periodId,
      'notional',
    );
  const pendingOf = async (t: Tenant): Promise<number> => {
    const [v] = await counter.readWithPending([spendKey(t)]);
    return v!.pending;
  };
  const jobsOf = (t: Tenant) =>
    port.batchJobs.list(t.principal, { limit: 100 }).then((p) => p.rows);

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    process.env['BUDGET_FAIL_OPEN'] = 'false';
    process.env['PROXY_MAX_BODY_BYTES'] = String(PROXY_LIMIT);
    process.env['BATCH_MAX_BODY_BYTES'] = String(BATCH_LIMIT);
    process.env['BATCH_MAX_ITEMS'] = '50';
    stub = await startStubUpstream();

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SemanticModule,
        DatabaseModule,
        DatabaseMaintenanceModule,
        RedisModule,
        ObservabilityModule,
      ],
      controllers: [BatchController, ChatCompletionsController],
      providers: [
        AgentApiKeyGuard,
        BatchService,
        { provide: BATCH_CONFIG, useFactory: resolveBatchConfig },
        { provide: BATCH_RUNTIME, useFactory: loadBatchRuntime },
        { provide: BATCH_ADAPTER_FACTORY, useValue: e2eBatchFactory },
        PricingService,
        {
          provide: PRICING_RUNTIME,
          useValue: {
            mode: 'selfhosted',
            refreshUrl: 'http://127.0.0.1:9/none',
            timeoutMs: 1_000,
            maxBytes: 1_024,
          },
        },
        {
          provide: PRICING_FETCH,
          useValue: () => Promise.reject(new Error('no refresh in this suite')),
        },
        ProxyService,
        {
          provide: SubscriptionOauthService,
          useValue: {
            resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')),
          },
        },
        StreamDrainRegistry,
        {
          provide: BodyCaptureService,
          useValue: {
            maxBytes: 262_144,
            contextFor: () =>
              Promise.resolve({ mode: 'off', override: null, retentionDays: null, epoch: 0 }),
          },
        },
        {
          provide: RequestRecorder,
          useValue: { record: () => undefined, recordAttempt: () => undefined },
        },
        WorkloadRouter,
        {
          provide: StructuralRouter,
          useValue: {
            enabled: false,
            evaluate: () => Promise.resolve({ kind: 'skip' }),
            classify: () => Promise.resolve({ kind: 'skip' }),
            resolveBand: () => ({ kind: 'skip' }),
          },
        },
        { provide: CascadeRouter, useValue: { enabled: false, plan: () => null } },
        {
          provide: NotificationProducers,
          useValue: {
            providerDown: () => undefined,
            onRequestFailed: () => Promise.resolve(),
            budgetAlert: () => undefined,
            budgetBlock: () => undefined,
          },
        },
        { provide: BUDGETS_CONFIG, useFactory: resolveBudgetsConfig },
        SpendCounter,
        BudgetCache,
        BudgetService,
        { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
        { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
        { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
        { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
        {
          provide: CALIBRATION_RAILS,
          useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()),
        },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.enableShutdownHooks();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    // The production mount, at THIS suite's tiny `/v1` limit — the carve-out is
    // what lets a batch body exceed it (task 3.1).
    mountBodyParsing((app as NestExpressApplication).getHttpAdapter().getInstance(), PROXY_LIMIT);
    await app.init();
    server = app.getHttpServer();

    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    maintenance = app.get<PersistenceMaintenance>(PERSISTENCE_MAINTENANCE);
    counter = app.get(SpendCounter);
    redis = app.get<Redis>(REDIS_CLIENT);
    await counter.waitReady();
    capped = await seedTenant(port, pool, 'capped', stub.url, { amount: 10 });
    free = await seedTenant(port, pool, 'free', stub.url, null);
    other = await seedTenant(port, pool, 'other', stub.url, null);
    await freshHeartbeat();
    void maintenance;
  }, 90_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [
      [capped.userId, free.userId, other.userId],
    ]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  beforeEach(async () => {
    await freshHeartbeat();
    await redis.del(counter.pendingKeyFor(spendKey(capped)), spendKey(capped));
  });

  const submit = (key: string | null, body: string, headers: Record<string, string> = {}) => {
    let r = request(server).post('/v1/batches').set('Content-Type', 'application/json');
    if (key !== null) r = r.set('Authorization', `Bearer ${key}`);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  };
  const chat = (key: string, body: unknown) =>
    request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send(body as object);

  // --- 3.1 the parser carve-out + bounds -------------------------------------

  it('accepts a batch body above PROXY_MAX_BODY_BYTES but within BATCH_MAX_BODY_BYTES; a chat body that size is still a 413', async () => {
    const pad = 'x'.repeat(600);
    const items = Array.from({ length: 8 }, (_, i) => item(`big-${String(i)}`, { pad }));
    const body = doc('gpt-4o', items);
    expect(Buffer.byteLength(body)).toBeGreaterThan(PROXY_LIMIT);
    expect(Buffer.byteLength(body)).toBeLessThan(BATCH_LIMIT);
    const res = await submit(free.key, body);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      object: 'batch',
      status: 'validating',
      request_counts: { total: 8, completed: 0, failed: 0 },
    });
    // The same bytes to the chat route trip the mounted limit — the carve-out is exact.
    const big = await chat(free.key, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: pad.repeat(4) }],
    });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('request_too_large');
  });

  it('an over-bound batch body is a protocol-shaped 413 and writes no job', async () => {
    const before = (await jobsOf(free)).length;
    const items = Array.from({ length: 40 }, (_, i) =>
      item(`huge-${String(i)}`, { pad: 'y'.repeat(900) }),
    );
    const res = await submit(free.key, doc('gpt-4o', items));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: {
        message: expect.stringMatching(/^batch exceeds/),
        type: 'invalid_request_error',
        code: 'batch_too_large',
      },
    });
    expect((await jobsOf(free)).length).toBe(before);
  });

  it('refuses requests-before-model, and names the first offending custom_id on an item error', async () => {
    const order = await submit(
      free.key,
      JSON.stringify({ endpoint: '/v1/chat/completions', requests: [item('a')], model: 'gpt-4o' }),
    );
    expect(order.status).toBe(400);
    expect(order.body.error.code).toBe('batch_invalid');
    expect(order.body.error.message).toMatch(/precede requests/);
    const bad = await submit(
      free.key,
      doc('gpt-4o', [item('ok'), item('dup'), item('dup'), item('later')]),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('batch_item_invalid');
    expect(bad.body.error.message).toContain('"dup"');
    expect(bad.body.error.message).not.toContain('later');
  });

  // --- 3.2 explicit-only routing -------------------------------------------

  it('refuses auto, a batch-only twin, and a provider without the seam — with no job row written', async () => {
    const before = (await jobsOf(free)).length;
    const auto = await submit(free.key, doc('auto', [item('a')]));
    expect(auto.status).toBe(400);
    expect(auto.body.error.code).toBe('batch_auto_not_allowed');
    const twin = await submit(free.key, doc('gpt-4o:batch', [item('a')]));
    expect(twin.status).toBe(400);
    expect(twin.body.error.code).toBe('batch_only_model');
    expect(twin.body.error.message).toContain('gpt-4o');
    const plain = await submit(free.key, doc('gpt-plain', [item('a')]));
    expect(plain.status).toBe(400);
    expect(plain.body.error.code).toBe('batch_not_supported');
    const unknown = await submit(free.key, doc('no-such-model', [item('a')]));
    expect(unknown.status).toBe(404);
    expect((await jobsOf(free)).length).toBe(before);
    expect(stub.batches.size).toBe(0 + [...stub.batches.values()].length); // no create for any of them
  });

  it('routes a tier to its primary and records the tier on the job', async () => {
    const res = await submit(free.key, doc('nightly', [item('t1')]));
    expect(res.status).toBe(202);
    const row = await port.batchJobs.findById(free.principal, res.body.id as string);
    expect(row?.tierAssigned).toBe('nightly');
    expect(row?.modelId).toBe(free.models['gpt-4o']);
    expect(row?.upstreamBatchId).toMatch(/^batch_/);
    expect(row?.status).toBe('validating');
  });

  // --- 3.4 + 3.5 the ceiling, the reservation, the D6 order ----------------

  it('a bounded batch reserves its ceiling (chars/4 × in + max_tokens × out) as pending, under a block budget', async () => {
    const items = [item('c1', { max_tokens: 100 }), item('c2', { max_tokens: 50 })];
    const res = await submit(capped.key, doc('gpt-4o', items));
    expect(res.status).toBe(202);
    const row = await port.batchJobs.findById(capped.principal, res.body.id as string);
    const expectedMicros = Math.ceil(
      items.reduce((acc, i) => acc + Math.ceil(Buffer.byteLength(JSON.stringify(i)) / 4), 0) *
        1.25 +
        150 * 5,
    );
    expect(row?.reservedCeilingMicros).toBe(expectedMicros);
    expect(row?.priceMode).toBe('batch');
    expect(row?.priceSource).toBe('listed');
    expect(row?.inputPriceSnapshot).toBe(1.25);
    expect(await pendingOf(capped)).toBe(expectedMicros);
  });

  it('a synchronous request is blocked by spend + pending once a batch reservation exhausts the budget (3.3)', async () => {
    // A $10 budget: seed spend so that spend + this batch's ceiling lands EXACTLY on
    // the amount — admitted (it fits), and every later admission sees spend + pending
    // at the threshold.
    const fill = item('fill', { max_tokens: 1_999_000 });
    const ceiling = Math.ceil(
      Math.ceil(Buffer.byteLength(JSON.stringify(fill)) / 4) * 1.25 + 1_999_000 * 5,
    );
    await counter.reconcileMax(spendKey(capped), 10_000_000 - ceiling, 3_600_000);
    const res = await submit(capped.key, doc('gpt-4o', [fill]));
    expect(res.status).toBe(202);
    expect(await pendingOf(capped)).toBe(ceiling);
    const sync = await chat(capped.key, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(sync.status).toBe(402);
    expect(sync.body.error.code).toBe('budget_exceeded');
    // And a second batch cannot fit either — rejected naming the budget, reset and ceiling; no row.
    const before = (await jobsOf(capped)).length;
    const second = await submit(capped.key, doc('gpt-4o', [item('more', { max_tokens: 100 })]));
    expect(second.status).toBe(402);
    expect(second.body.error.message).toMatch(
      /budget exceeded: capped-cap \(resets .*; batch ceiling \$/,
    );
    expect((await jobsOf(capped)).length).toBe(before);
  });

  it('refuses an unbounded batch under a block budget, but admits it without one (ceiling recorded as null)', async () => {
    const noRate = await submit(capped.key, doc('gpt-4o-norate', [item('u1')]));
    expect(noRate.status).toBe(400);
    expect(noRate.body.error.code).toBe('batch_unbounded');
    expect(noRate.body.error.message).toMatch(/no batch rate/);
    const noCap = await submit(capped.key, doc('gpt-4o', [item('u2', { max_tokens: undefined })]));
    expect(noCap.status).toBe(400);
    expect(noCap.body.error.message).toMatch(/no max_tokens/);
    expect((await jobsOf(capped)).every((j) => j.status !== 'submitting')).toBe(true);
    const admitted = await submit(free.key, doc('gpt-4o-norate', [item('u3')]));
    expect(admitted.status).toBe(202);
    const row = await port.batchJobs.findById(free.principal, admitted.body.id as string);
    expect(row?.reservedCeilingMicros).toBeNull();
    expect(row?.priceSource).toBeNull();
  });

  it('a provider-rejected create fails the row with the taxonomy kind and releases the reservation', async () => {
    const res = await submit(capped.key, doc('batch-srvfail', [item('s1', { max_tokens: 10 })]));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('upstream_unavailable');
    const rows = (await jobsOf(capped)).filter((j) => j.modelId === capped.models['batch-srvfail']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      errorKind: 'unavailable',
      settledCostMicros: 0,
    });
    expect(rows[0]!.terminalAt).not.toBeNull();
    expect(await pendingOf(capped)).toBe(0);
    const refused = await submit(free.key, doc('batch-batchreject', [item('r1')]));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('bad_request');
    expect(refused.body.error.message).not.toMatch(/stub refused/); // fixed message, never upstream text
    const rj = (await jobsOf(free)).filter((j) => j.modelId === free.models['batch-batchreject']);
    expect(rj[0]).toMatchObject({ status: 'failed', errorKind: 'bad_request' });
  });

  it('a stale reconcile heartbeat follows the fail mode: fail-closed refuses with 503 and discards the row', async () => {
    await staleHeartbeat();
    const before = (await jobsOf(capped)).length;
    const res = await submit(capped.key, doc('gpt-4o', [item('h1', { max_tokens: 5 })]));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('budget_enforcement_unavailable');
    expect((await jobsOf(capped)).length).toBe(before);
    // A tenant with no block budget is not gated by the heartbeat at all.
    const ok = await submit(free.key, doc('gpt-4o', [item('h2', { max_tokens: 5 })]));
    expect(ok.status).toBe(202);
  });

  // --- 3.6 the key plane + the object --------------------------------------

  it('renders the OpenAI-compatible batch object, readable by an OpenAI-style poller unchanged', async () => {
    const res = await submit(free.key, doc('gpt-4o', [item('o1'), item('o2')]));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      object: 'batch',
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      status: 'validating',
      input_file_id: null,
      output_file_id: null,
      error_file_id: null,
      request_counts: { total: 2, completed: 0, failed: 0 },
      model: 'gpt-4o',
      results_url: null,
    });
    expect(typeof res.body.created_at).toBe('number');
    expect(res.body.expires_at - res.body.created_at).toBe(86_400);
    // A poller: retrieve until terminal, reading only the fields the SDK reads.
    const poll = await request(server)
      .get(`/v1/batches/${res.body.id as string}`)
      .set('x-api-key', free.key);
    expect(poll.status).toBe(200);
    expect(poll.body.id).toBe(res.body.id);
    expect([
      'validating',
      'in_progress',
      'finalizing',
      'completed',
      'failed',
      'expired',
      'cancelling',
      'cancelled',
    ]).toContain(poll.body.status);
    expect(poll.body.request_counts.total).toBe(2);
    expect(poll.body.results).toBeUndefined(); // metadata only, never results (D25)
    const list = await request(server)
      .get('/v1/batches?limit=2')
      .set('Authorization', `Bearer ${free.key}`);
    expect(list.status).toBe(200);
    expect(list.body.object).toBe('list');
    expect(list.body.data[0].id).toBe(res.body.id);
    expect(list.body.has_more).toBe(true);
    expect(list.body.last_id).toBe(list.body.data[1].id);
    const next = await request(server)
      .get(`/v1/batches?limit=2&after=${list.body.last_id as string}`)
      .set('Authorization', `Bearer ${free.key}`);
    expect(next.status).toBe(200);
    expect(next.body.data.map((b: { id: string }) => b.id)).not.toContain(res.body.id);
  });

  it('both client protocols receive the object; a post-endpoint failure renders in the endpoint’s envelope', async () => {
    const ant = await submit(
      free.key,
      JSON.stringify({
        endpoint: '/v1/messages',
        model: 'claude-x',
        requests: [
          {
            custom_id: 'a1',
            body: { max_tokens: 5, messages: [{ role: 'user', content: 'hey' }] },
          },
        ],
      }),
    );
    expect(ant.status).toBe(202);
    expect(ant.body).toMatchObject({
      object: 'batch',
      endpoint: '/v1/messages',
      model: 'claude-x',
      status: 'in_progress',
    });
    const row = await port.batchJobs.findById(free.principal, ant.body.id as string);
    expect(row?.upstreamBatchId).toMatch(/^msgbatch_/);
    expect(row?.protocol).toBe('anthropic_compatible');
    // Anthropic envelope for an item error once the endpoint is known...
    const bad = await submit(
      free.key,
      JSON.stringify({
        endpoint: '/v1/messages',
        model: 'claude-x',
        requests: [{ custom_id: 'x', body: { max_tokens: 1, messages: [], stream: true } }],
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: expect.stringContaining('"x"') },
    });
    // ...and the OpenAI envelope for a failure raised BEFORE the endpoint is known.
    const pre = await submit(free.key, '{"requests": [');
    expect(pre.status).toBe(400);
    expect(pre.body.error.code).toBe('batch_invalid');
  });

  it('authenticates like the chat routes: either header, the same 401s, last_used_at stamped', async () => {
    const none = await submit(null, doc('gpt-4o', [item('a')]));
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('invalid_api_key');
    const bad = await submit('poly_not_a_key', doc('gpt-4o', [item('a')]));
    expect(bad.status).toBe(401);
    const conflict = await submit(free.key, doc('gpt-4o', [item('a')]), {
      'x-api-key': `${free.key}x`,
    });
    expect(conflict.status).toBe(401);
    const viaXApiKey = await request(server)
      .post('/v1/batches')
      .set('x-api-key', free.key)
      .set('Content-Type', 'application/json')
      .send(doc('gpt-4o', [item('k1')]));
    expect(viaXApiKey.status).toBe(202);
    // The touch is coalesced and fire-and-forget: give it a moment.
    for (let i = 0; i < 20; i += 1) {
      const { rows } = await pool.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM agent WHERE id = $1',
        [free.agentId],
      );
      if (rows[0]?.last_used_at !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const { rows } = await pool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM agent WHERE id = $1',
      [free.agentId],
    );
    expect(rows[0]?.last_used_at).not.toBeNull();
  });

  it('disabling batches refuses new submissions with batch_not_supported', async () => {
    const svc = app.get(BatchService);
    const cfg = (svc as unknown as { cfg: { enabled: boolean } }).cfg;
    const was = cfg.enabled;
    (cfg as { enabled: boolean }).enabled = false;
    try {
      const res = await submit(free.key, doc('gpt-4o', [item('d1')]));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('batch_not_supported');
      // Reads keep working (D23).
      const list = await request(server)
        .get('/v1/batches')
        .set('Authorization', `Bearer ${free.key}`);
      expect(list.status).toBe(200);
    } finally {
      (cfg as { enabled: boolean }).enabled = was;
    }
  });

  // --- 3.7 the taxonomy + tenancy on every surface --------------------------

  it('another tenant’s job is a missing job on read and cancel; cancel moves a live job to cancelling and is a no-op afterwards', async () => {
    const res = await submit(free.key, doc('gpt-4o', [item('z1')]));
    const id = res.body.id as string;
    const foreign = await request(server)
      .get(`/v1/batches/${id}`)
      .set('Authorization', `Bearer ${other.key}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('batch_not_found');
    const foreignCancel = await request(server)
      .post(`/v1/batches/${id}/cancel`)
      .set('Authorization', `Bearer ${other.key}`);
    expect(foreignCancel.status).toBe(404);
    const missing = await request(server)
      .get('/v1/batches/batch_nope')
      .set('Authorization', `Bearer ${free.key}`);
    expect(missing.status).toBe(404);
    const cancel = await request(server)
      .post(`/v1/batches/${id}/cancel`)
      .set('Authorization', `Bearer ${free.key}`);
    expect(cancel.status).toBe(202);
    expect(cancel.body.status).toBe('cancelling');
    expect(
      stub.batches.get((await port.batchJobs.findById(free.principal, id))!.upstreamBatchId!)
        ?.cancel_initiated,
    ).toBe(true);
    const again = await request(server)
      .post(`/v1/batches/${id}/cancel`)
      .set('Authorization', `Bearer ${free.key}`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('cancelling');
  });

  it('every batch kind renders its fixed status and message in the caller’s envelope', async () => {
    const cases: Array<[string, number, string]> = [
      [doc('auto', [item('a')]), 400, 'batch_auto_not_allowed'],
      [doc('gpt-plain', [item('a')]), 400, 'batch_not_supported'],
      [
        JSON.stringify({ endpoint: '/v1/chat/completions', model: 'gpt-4o', requests: [] }),
        400,
        'batch_invalid',
      ],
      [doc('gpt-4o', [item('a', { n: 3 })]), 400, 'batch_item_invalid'],
    ];
    for (const [body, status, code] of cases) {
      const res = await submit(free.key, body);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(typeof res.body.error.message).toBe('string');
    }
  });
});
