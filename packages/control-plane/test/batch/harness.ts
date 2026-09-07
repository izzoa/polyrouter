// Shared composition for the batch e2e suites (add-batch-inference Phase B).
// Boots the real batch surface against the dev Postgres/Redis and a local stub
// upstream serving OpenRouter- and Anthropic-shaped batch routes.
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
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
  createOpenAiBatchAdapter,
  createOpenRouterBatchAdapter,
  createProviderAdapter,
} from '@polyrouter/data-plane';
import type { BatchFactory } from '@polyrouter/data-plane';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { configureApp } from '../../src/app.setup';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import { mountBodyParsing } from '../../src/auth/mount';
import { mintAgentKey } from '../../src/agents/agent-keys';
import { BatchAdminController } from '../../src/batch/batch-admin.controller';
import { BatchController } from '../../src/batch/batch.controller';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { BatchService } from '../../src/batch/batch.service';
import { BatchSettlement } from '../../src/batch/batch-settlement';
import { BatchPoller } from '../../src/batch/batch.poller';
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
import { ProxyMetrics } from '../../src/observability/proxy-metrics';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { WorkloadRouter } from '../../src/proxy/workload/workload-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { DashboardEvents } from '../../src/events/dashboard-events';
import { BudgetService } from '../../src/budgets/budget-service';
import { BudgetCache } from '../../src/budgets/budget-cache';
import { SpendCounter } from '../../src/budgets/spend-counter';
import { BUDGETS_CONFIG, resolveBudgetsConfig } from '../../src/budgets/budgets.config';
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

/**
 * Stands in for `SessionGuard` on the `/api` plane only — exactly as the real one
 * does, it early-returns for every other path so `/v1` keeps going through the
 * agent-key guard.
 */
@Injectable()
export class TestSessionGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.path.toLowerCase().startsWith('/api')) return true;
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

export const HMAC = 'd'.repeat(64);
export const HEARTBEAT = 'budget:reconcile:heartbeat';
/** The `/v1` mount limit for these suites: a batch body legitimately exceeds it. */
export const PROXY_LIMIT = 2_048;
export const BATCH_LIMIT = 262_144;

export interface Tenant {
  /** Provider ids the mode/servicing tests address directly. */
  providers?: { ant: string; plain: string; or: string };
  principal: Principal;
  userId: string;
  key: string;
  agentId: string;
  models: Record<string, string>;
}

export interface StallRecord {
  ownerUserId: string;
  jobId: string;
  kind: string;
  status: string;
  stalledMinutes: number;
}

/**
 * Attach the OpenRouter / Anthropic batch seams by base-URL suffix. The stub
 * serves both shapes from one host, so the production family rule (host-derived)
 * cannot pick between them here; a `/plain` provider carries no seam at all —
 * the `batch_not_supported` case.
 */
const seamBySuffix = (baseUrl: string): BatchFactory | undefined => {
  if (baseUrl.endsWith('/or')) return createOpenRouterBatchAdapter;
  if (baseUrl.endsWith('/ant')) return createAnthropicBatchAdapter;
  if (baseUrl.endsWith('/oai')) return createOpenAiBatchAdapter;
  return undefined;
};

export const e2eBatchFactory: BatchAdapterFactory = (config, deps = {}) => {
  const suffix = seamBySuffix(config.baseUrl);
  // Mirror the production predicate SPLIT (add-batch-mode-routing). The stub serves
  // every shape from one host, so the real family rule cannot pick between them here
  // and the suffix stands in for it — but the `kind` half of that rule is real and
  // must be honoured, or the subscription refusal would be untestable end-to-end. A
  // `servicing` purpose keeps the seam for a job that was already accepted.
  const gated =
    config.kind === 'subscription' && deps.batchPurpose !== 'servicing' ? undefined : suffix;
  return createProviderAdapter(config, gated !== undefined ? { ...deps, batch: gated } : deps);
};

export async function seedTenant(
  port: PersistencePort,
  pool: Pool,
  label: string,
  stubUrl: string,
  budget: { amount: number } | null,
): Promise<Tenant> {
  const userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@batch.test`],
    )
  ).rows[0]!.id;
  const principal = userPrincipal(userId);
  const or = await port.providers.insert(principal, {
    name: `openrouter-${label}`,
    kind: 'local',
    protocol: 'openai_compatible',
    baseUrl: `${stubUrl}/or`,
  });
  const ant = await port.providers.insert(principal, {
    name: `anthropic-${label}`,
    kind: 'local',
    protocol: 'anthropic_compatible',
    baseUrl: `${stubUrl}/ant`,
  });
  const oai = await port.providers.insert(principal, {
    name: `openai-${label}`,
    kind: 'local',
    protocol: 'openai_compatible',
    baseUrl: `${stubUrl}/oai`,
  });
  const plain = await port.providers.insert(principal, {
    name: `plain-${label}`,
    kind: 'local',
    protocol: 'openai_compatible',
    baseUrl: `${stubUrl}/plain`,
  });
  // A flat-rate SUBSCRIPTION provider on the Anthropic-shaped route
  // (add-batch-mode-routing task 1.3). Its suffix WOULD attach a seam, so a refusal
  // here can only come from the `kind` rule — the shape that shipped carrying one.
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
  await add(or.id, 'gpt-4o-norate');
  await add(or.id, 'batch-srvfail');
  await add(or.id, 'batch-srvfail:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1,
    listedOutputPricePer1m: 1,
  });
  await add(or.id, 'batch-batchreject');
  await add(or.id, 'batch-batchreject:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1,
    listedOutputPricePer1m: 1,
  });
  await add(ant.id, 'claude-x');
  // Behaviour markers for the results route (see the stub's id marker rule).
  await add(ant.id, 'claude-bigresults');
  await add(ant.id, 'claude-bigresults:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1,
    listedOutputPricePer1m: 1,
  });
  await add(ant.id, 'claude-midfail');
  await add(ant.id, 'claude-midfail:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1,
    listedOutputPricePer1m: 1,
  });
  await add(ant.id, 'claude-x:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1.5,
    listedOutputPricePer1m: 7.5,
  });
  // The OpenAI file plane (Phase C): a direct provider whose batch surface is
  // files + batches rather than an inline array.
  await add(oai.id, 'oai-gpt-4o');
  await add(oai.id, 'oai-gpt-4o:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1.25,
    listedOutputPricePer1m: 5,
  });
  await add(oai.id, 'oai-batchreject');
  await add(oai.id, 'oai-batchreject:batch', {
    variant: 'batch',
    listedInputPricePer1m: 1,
    listedOutputPricePer1m: 1,
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
  return {
    principal,
    userId,
    key: minted.key,
    agentId,
    models,
    providers: { ant: ant.id, plain: plain.id, or: or.id },
  };
}

export const item = (id: string, body: Record<string, unknown> = {}): Record<string, unknown> => ({
  custom_id: id,
  body: { messages: [{ role: 'user', content: `hi ${id}` }], max_tokens: 8, ...body },
});

/** `endpoint` and `model` FIRST — the ordering the API requires. */
export const doc = (model: string, items: unknown[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({ endpoint: '/v1/chat/completions', model, ...over, requests: items });

export interface BatchHarness {
  app: INestApplication;
  pool: Pool;
  redis: Redis;
  port: PersistencePort;
  maintenance: PersistenceMaintenance;
  counter: SpendCounter;
  metrics: ProxyMetrics;
  events: DashboardEvents;
  stub: StubUpstream;
  /** Present only when `withPoller` was requested. */
  poller?: BatchPoller;
  settlement?: BatchSettlement;
  stalls: StallRecord[];
  close(userIds: string[]): Promise<void>;
}

/** Boot the batch surface. `withPoller` additionally wires the real poller +
 * settlement (its BullMQ scheduler is never started — tests drive `sweep()`). */
export async function createBatchHarness(
  opts: { withPoller?: boolean; failOpen?: boolean } = {},
): Promise<BatchHarness> {
  process.env['NODE_ENV'] = 'test';
  process.env['MODE'] = 'selfhosted';
  process.env['BIND_ADDRESS'] = '127.0.0.1';
  process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
  process.env['API_KEY_HMAC_SECRET'] = HMAC;
  process.env['BUDGET_FAIL_OPEN'] = opts.failOpen === true ? 'true' : 'false';
  process.env['PROXY_MAX_BODY_BYTES'] = String(PROXY_LIMIT);
  process.env['BATCH_MAX_BODY_BYTES'] = String(BATCH_LIMIT);
  process.env['BATCH_MAX_ITEMS'] = '2000';
  const stub = await startStubUpstream();

  const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
  }

  const stalls: StallRecord[] = [];
  const producers = {
    providerDown: () => undefined,
    onRequestFailed: () => Promise.resolve(),
    budgetAlert: () => undefined,
    budgetBlock: () => undefined,
    batchStalled: (a: StallRecord) => {
      stalls.push(a);
    },
  } as unknown as NotificationProducers;

  const moduleRef = await Test.createTestingModule({
    imports: [
      SemanticModule,
      DatabaseModule,
      DatabaseMaintenanceModule,
      RedisModule,
      ObservabilityModule,
    ],
    controllers: [BatchController, BatchAdminController, ChatCompletionsController],
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
      { provide: PRICING_FETCH, useValue: () => Promise.reject(new Error('no refresh here')) },
      ProxyService,
      {
        provide: SubscriptionOauthService,
        useValue: { resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')) },
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
      { provide: NotificationProducers, useValue: producers },
      { provide: BUDGETS_CONFIG, useFactory: resolveBudgetsConfig },
      SpendCounter,
      BudgetCache,
      BudgetService,
      DashboardEvents,
      { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
      { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
      { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
      { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
      {
        provide: CALIBRATION_RAILS,
        useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()),
      },
      { provide: APP_FILTER, useClass: ProxyExceptionFilter },
      { provide: APP_GUARD, useClass: TestSessionGuard },
      ...(opts.withPoller === true ? [BatchSettlement, BatchPoller] : []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  app.enableShutdownHooks();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  // The production mount, at this suite's tiny `/v1` limit — the carve-out is
  // what lets a batch body exceed it (task 3.1).
  mountBodyParsing((app as NestExpressApplication).getHttpAdapter().getInstance(), PROXY_LIMIT);
  await app.init();

  const counter = app.get(SpendCounter);
  await counter.waitReady();
  const redis = app.get<Redis>(REDIS_CLIENT);
  await redis.set(HEARTBEAT, String(Date.now()));

  return {
    app,
    pool,
    redis,
    port: app.get<PersistencePort>(PERSISTENCE_PORT),
    maintenance: app.get<PersistenceMaintenance>(PERSISTENCE_MAINTENANCE),
    counter,
    metrics: app.get(ProxyMetrics),
    events: app.get(DashboardEvents),
    stub,
    ...(opts.withPoller === true
      ? { poller: app.get(BatchPoller), settlement: app.get(BatchSettlement) }
      : {}),
    stalls,
    async close(userIds: string[]) {
      if (userIds.length > 0) {
        await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [userIds]);
      }
      await app.close();
      await pool.end();
      await stub.close();
    },
  };
}
