/* eslint-disable @typescript-eslint/require-await -- fake async generators in tests */
// Plan-cooldown e2e (classify-plan-quota-errors task 8.1): real Postgres and real Redis, a FAKE
// adapter factory, and key-preset rows on their REAL pinned hosts (never dialled: the factory is
// fake). The SSRF guard still DNS-resolves those hosts at adapter build, so this suite needs
// outbound DNS, the same posture as output-cap-guardrails.
//
// Two apps run side by side over the same Redis:
//  - `real`: the production wiring (PROXY_BREAKER_PROVIDER + PlanCooldownModule + ProvidersModule),
//    so the shared-store identity, the lift endpoint and the default windows are the real ones;
//  - `short`: a breaker whose store has SHORT windows, for the expiry-by-itself proof.
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
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
  ProviderError,
  RedisBreakerStore,
  RedisPlanCooldownStore,
  withBreaker,
  type NormalizedRequest,
  type NormalizedResponse,
  type NormalizedStreamEvent,
  type PlanCooldownConfig,
  type PlanCooldownStore,
  type ProviderAdapter,
  type ProviderConfig,
} from '@polyrouter/data-plane';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { configureApp } from '../../src/app.setup';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
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
import { PlanUsageModule } from '../../src/plan-usage/plan-usage.module';
import { PROXY_BREAKER_PROVIDER } from '../../src/proxy/proxy.module';
import { ROUTING_CONFIG, loadRoutingConfig } from '../../src/proxy/routing.config';
import {
  CALIBRATION_RAILS,
  loadCalibrationConfig,
  railsOf,
  type CalibrationRails,
} from '../../src/calibration/calibration.config';
import { ProxyService } from '../../src/proxy/proxy.service';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { BudgetService } from '../../src/budgets/budget-service';
import { BodyCaptureService } from '../../src/body-capture/body-capture.service';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { WorkloadRouter } from '../../src/proxy/workload/workload-router';
import { StructuralBaselineStore } from '../../src/proxy/structural/structural-baseline.store';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { LogWriter } from '../../src/recording/log-writer';
import { RecordingModule } from '../../src/recording/recording.module';
import { DatabaseModule } from '../../src/database/database.module';
import { SemanticModule } from '../../src/semantic/semantic.module';
import { RedisModule } from '../../src/redis/redis.module';
import { boundedBreakerRedis } from '../../src/redis/bounded-breaker-redis';
import { PlanCooldownModule } from '../../src/plan-cooldown/plan-cooldown.module';
import { PLAN_COOLDOWN_STORE } from '../../src/plan-cooldown/plan-cooldown.tokens';
import { ProvidersModule } from '../../src/providers/providers.module';
import { ProvidersService } from '../../src/providers/providers.service';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';
import { ZAI_CODING_PLAN_PRESET } from '../../src/subscription-presets/key-presets';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';

const HMAC = 'a'.repeat(64);
const ZAI = ZAI_CODING_PLAN_PRESET.regions[0]!;
const MINUTE = 60_000;

/** What the fake upstream does for the Z.ai member. */
let zaiMode: 'quota' | 'ok' = 'quota';
/** Every adapter the factory built, by pinned host: proves "no factory call" for a skip. */
const built: ProviderConfig[] = [];
const zaiBuilds = (): number => built.filter((c) => c.baseUrl === ZAI.baseUrl).length;
/** Every dispatched upstream call. */
const dispatched: string[] = [];

const quotaError = (): ProviderError =>
  new ProviderError('quota_exhausted', 'Usage limit reached for 5 hours', {
    status: 429,
    planReset: { window: 'short' },
  });

function fakeAdapterFactory(config: ProviderConfig): ProviderAdapter {
  built.push(config);
  const answer = (req: NormalizedRequest): NormalizedResponse => ({
    id: 'stub-1',
    model: req.model,
    content: [{ type: 'text', text: 'stubbed answer' }],
    stopReason: 'stop',
  });
  const mayFail = (req: NormalizedRequest): void => {
    dispatched.push(req.model);
    if (req.model.startsWith('glm') && zaiMode === 'quota') throw quotaError();
  };
  return {
    protocol: config.protocol,
    chat: async (req: NormalizedRequest) => {
      mayFail(req);
      return answer(req);
    },
    chatStream: async function* (req: NormalizedRequest): AsyncGenerator<NormalizedStreamEvent> {
      mayFail(req);
      yield { type: 'message_start', id: 'm1', model: req.model, role: 'assistant' };
      yield { type: 'text_delta', index: 0, text: 'hi' };
      yield { type: 'message_delta', stopReason: 'stop' };
      yield { type: 'message_stop' };
    },
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
  } as unknown as ProviderAdapter;
}

/** The session plane is stubbed for the management routes; `/v1` has its own agent-key guard. */
@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.path.startsWith('/v1')) return true;
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

interface Booted {
  readonly app: INestApplication;
  readonly server: App;
  readonly writer: LogWriter;
}

async function bootApp(opts: {
  readonly breaker: Provider;
  readonly extraImports?: readonly unknown[];
}): Promise<Booted> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SemanticModule,
      DatabaseModule,
      RecordingModule,
      RedisModule,
      ObservabilityModule,
      ...((opts.extraImports ?? []) as never[]),
    ],
    controllers: [ChatCompletionsController, MessagesController],
    providers: [
      AgentApiKeyGuard,
      ProxyService,
      {
        provide: SubscriptionOauthService,
        useValue: {
          resolveCredential: () =>
            Promise.resolve({ credential: 'sub-token', authScheme: 'api_key' }),
          availableClientIdentity: () => null,
          identityBindingFor: () => undefined,
        },
      },
      StreamDrainRegistry,
      StructuralRouter,
      WorkloadRouter,
      CascadeRouter,
      {
        provide: BodyCaptureService,
        useValue: {
          maxBytes: 262_144,
          contextFor: () =>
            Promise.resolve({ mode: 'off', override: null, retentionDays: null, epoch: 0 }),
        },
      },
      {
        provide: NotificationProducers,
        useValue: { providerDown: () => undefined, onRequestFailed: () => Promise.resolve() },
      },
      {
        provide: BudgetService,
        useValue: { checkBlocked: () => Promise.resolve(null), notifyBlocked: () => undefined },
      },
      { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
      { provide: PROXY_ADAPTER_FACTORY, useValue: fakeAdapterFactory },
      opts.breaker,
      { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
      {
        provide: CALIBRATION_RAILS,
        useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()),
      },
      {
        provide: StructuralBaselineStore,
        inject: [REDIS_CLIENT],
        useFactory: (redis: Redis): StructuralBaselineStore =>
          new StructuralBaselineStore(redis, HMAC),
      },
      { provide: APP_FILTER, useClass: ProxyExceptionFilter },
      { provide: APP_GUARD, useClass: TestPrincipalGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.init();
  return { app, server: app.getHttpServer(), writer: app.get(LogWriter) };
}

const SHORT: PlanCooldownConfig = {
  minMs: 200,
  maxMs: 60_000,
  quotaShortMs: 1_500,
  quotaLongMs: 3_000,
  riskControlMs: 1_500,
  planInactiveMs: 1_500,
};

describe('plan cooldown e2e (classify-plan-quota-errors)', () => {
  let real: Booted;
  let short: Booted;
  let pool: Pool;
  let port: PersistencePort;
  let redis: Redis;
  let userId: string;
  let principal: Principal;
  let key: string;
  let zaiId: string;
  let payId: string;
  const modelId: Record<string, string> = {};

  /** The Redis SERVER clock: Docker's VM clock may differ from this process's. */
  const redisNow = async (): Promise<number> => {
    const [s, us] = await redis.time();
    return Number(s) * 1000 + Math.floor(Number(us) / 1000);
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const realStore = (): PlanCooldownStore => real.app.get<PlanCooldownStore>(PLAN_COOLDOWN_STORE);
  const breakerKey = (): string => `cb:${zaiId}`;

  async function setBand(matchType: 'auto_high' | 'auto_low', tierKey: string): Promise<void> {
    for (const r of (await port.routingRules.list(principal)).filter(
      (r) => r.matchType === matchType,
    )) {
      await port.routingRules.remove(principal, r.id);
    }
    await port.routingRules.insert(principal, {
      matchType,
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: `tier:${tierKey}`,
      priority: 0,
    });
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    process.env['ROUTING_AUTO_LAYERS'] = 'structural,cascade';

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    // The production wiring: the real PROXY_BREAKER factory over the real PlanCooldownModule and PlanUsageModule.
    real = await bootApp({
      breaker: PROXY_BREAKER_PROVIDER,
      extraImports: [PlanCooldownModule, PlanUsageModule, ProvidersModule],
    });
    // Short windows over the same Redis, built from the same pieces.
    short = await bootApp({
      breaker: {
        provide: PROXY_BREAKER,
        inject: [REDIS_CLIENT],
        useFactory: (r: Redis): CircuitBreaker =>
          new CircuitBreaker(new RedisBreakerStore(boundedBreakerRedis(r)), {
            fallback: new InMemoryBreakerStore(),
            planCooldowns: new RedisPlanCooldownStore(boundedBreakerRedis(r), 'pcd:', SHORT),
            planCooldownConfig: SHORT,
          }),
      },
    });
    port = real.app.get<PersistencePort>(PERSISTENCE_PORT);
    redis = real.app.get<Redis>(REDIS_CLIENT);

    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'pc', $1, true) RETURNING id`,
        [`plancd-${Date.now()}@pc.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);

    // A Z.ai coding-plan key-preset row on its REAL pinned host (never dialled)...
    const zai = await port.providers.insert(principal, {
      name: 'plancd-zai',
      kind: 'subscription',
      protocol: ZAI.protocol,
      baseUrl: ZAI.baseUrl,
      keyPreset: ZAI_CODING_PLAN_PRESET.id,
    });
    await pool.query(`UPDATE provider SET encrypted_credentials = 'stub' WHERE id = $1`, [zai.id]);
    zaiId = zai.id;
    // ...and a pay-per-token member.
    const pay = await port.providers.insert(principal, {
      name: 'plancd-pay',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com',
    });
    payId = pay.id;

    const add = async (providerId: string, ext: string): Promise<void> => {
      modelId[ext] = (await port.models.createForProvider(principal, providerId, {
        externalModelId: ext,
      }))!.id;
    };
    await add(zai.id, 'glm-5');
    // A subscription row honours no model-own rate; its provider's captured listed estimate is
    // what gives a not-billed row a price snapshot to keep (record-listed-price-fallback).
    await pool.query(
      `UPDATE model SET listed_input_price_per_1m = 2, listed_output_price_per_1m = 10, listed_is_free = false,
              listed_price_captured_at = now() WHERE id = $1`,
      [modelId['glm-5']],
    );
    await add(pay.id, 'pay-1');
    await add(pay.id, 'pay-strong');

    await port.ensureDefaultTier(principal);
    const tiers = new Map((await port.tiers.list(principal)).map((t) => [t.key, t.id]));
    const setTier = async (keyName: string, exts: string[]): Promise<void> => {
      let id = tiers.get(keyName);
      if (id === undefined) {
        id = (await port.tiers.insert(principal, { key: keyName })).id;
        tiers.set(keyName, id);
      }
      await port.routingEntries.replaceForTier(
        principal,
        id,
        exts.map((e) => modelId[e]!),
      );
    };
    await setTier('default', ['pay-1']);
    await setTier('zai-first', ['glm-5', 'pay-1']);
    await setTier('zai-only', ['glm-5']);
    await setTier('cheap-zai', ['glm-5']);
    await setTier('strong-pay', ['pay-strong']);
    await setBand('auto_high', 'strong-pay');
    await setBand('auto_low', 'cheap-zai');

    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl')`,
      [userId, minted.hash, minted.prefix],
    );
    key = minted.key;
  }, 90_000);

  afterAll(async () => {
    if (redis && zaiId) await redis.del(`pcd:${zaiId}`, breakerKey());
    if (userId) await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await real.app.close();
    await short.app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userId]);
    await redis.del(`pcd:${zaiId}`, breakerKey());
    zaiMode = 'quota';
    built.length = 0;
    dispatched.length = 0;
  });

  const chatVia = async (
    booted: Booted,
    body: Record<string, unknown>,
  ): Promise<request.Response> => {
    const res = await request(booted.server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send(body);
    await booted.writer.flush();
    return res;
  };
  const chat = (body: Record<string, unknown>): Promise<request.Response> => chatVia(real, body);
  const msg = { messages: [{ role: 'user', content: 'hello' }] };

  interface LogRow {
    status: string;
    error_kind: string | null;
    routing_reason: string;
    billed: boolean | null;
    cost: string | null;
    model_id: string | null;
    escalated: boolean;
    attempt_failures: Array<Record<string, unknown>> | null;
    error_status: number | null;
    error_message: string | null;
    usage_estimated: boolean;
    price_source: string | null;
    input_price_snapshot: number | null;
    output_price_snapshot: number | null;
  }
  const lastLog = async (): Promise<LogRow> =>
    (
      await pool.query<LogRow>(
        `SELECT status, error_kind, routing_reason, billed, cost, model_id, escalated, attempt_failures,
               error_status, error_message, usage_estimated, price_source,
               input_price_snapshot, output_price_snapshot
           FROM request_log WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )
    ).rows[0]!;

  it('the fake factory receives errorDialect zai for the preset row and none for a pay-per-token member', async () => {
    const res = await chat({ model: 'zai-first', ...msg });
    expect(res.status).toBe(200);
    const zaiConfig = built.find((c) => c.baseUrl === ZAI.baseUrl)!;
    expect(zaiConfig.errorDialect).toBe('zai');
    const payConfig = built.find((c) => c.baseUrl !== ZAI.baseUrl)!;
    expect('errorDialect' in payConfig).toBe(false);
  });

  it('a quota failure falls back to the pay member, records quota_exhausted, and pauses the provider', async () => {
    const res = await chat({ model: 'zai-first', ...msg });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual(['glm-5', 'pay-1']);
    const row = await lastLog();
    expect(row.status).toBe('fallback');
    expect(row.routing_reason).toContain('quota_exhausted@glm-5');
    const pause = await realStore().check(zaiId);
    expect(pause).toMatchObject({ kind: 'quota_exhausted', source: 'default' });
    // The stored end is the kind's default from the Redis server clock (15 min short window).
    const left = pause!.until - (await redisNow());
    expect(left).toBeGreaterThan(14 * MINUTE);
    expect(left).toBeLessThanOrEqual(15 * MINUTE);
  });

  it('the next request skips the paused member with no factory call, and records paused@ with skipReason', async () => {
    await chat({ model: 'zai-first', ...msg }); // pauses
    // Give the provider a REAL breaker record (one tripping failure, below the threshold), so
    // "untouched" compares something rather than two empty hashes.
    await withBreaker(real.app.get<CircuitBreaker>(PROXY_BREAKER), zaiId, () =>
      Promise.reject(new ProviderError('unavailable', 'seed failure', { status: 503 })),
    ).catch(() => undefined);
    built.length = 0;
    dispatched.length = 0;
    const before = await redis.hgetall(breakerKey());
    expect(Object.keys(before).length).toBeGreaterThan(0);

    const res = await chat({ model: 'zai-first', ...msg });
    expect(res.status).toBe(200);
    expect(zaiBuilds()).toBe(0); // no adapter was even built for it
    expect(dispatched).toEqual(['pay-1']);
    const row = await lastLog();
    expect(row.status).toBe('fallback');
    expect(row.routing_reason).toContain('paused@glm-5');
    expect(row.routing_reason).not.toContain('quota_exhausted@glm-5');
    // The entry marks a never-dispatched member skipped by the plan pause, with no upstream status.
    expect(row.attempt_failures).toEqual([
      {
        index: 0,
        providerId: zaiId,
        model: 'glm-5',
        kind: 'quota_exhausted',
        dispatched: false,
        skipReason: 'plan_cooldown',
      },
    ]);
    // The skip touched no breaker record.
    expect(await redis.hgetall(breakerKey())).toEqual(before);
  });

  it('a streamed request pre-commit skips the paused member the same way', async () => {
    await chat({ model: 'zai-first', ...msg }); // pauses
    built.length = 0;
    dispatched.length = 0;
    const res = await chat({ model: 'zai-first', ...msg, stream: true });
    expect(res.status).toBe(200);
    expect(res.text).toContain('hi');
    expect(zaiBuilds()).toBe(0);
    expect(dispatched).toEqual(['pay-1']);
    expect((await lastLog()).routing_reason).toContain('paused@glm-5');
  });

  it('a second instance on the same Redis also skips the provider (cross-instance)', async () => {
    await chat({ model: 'zai-first', ...msg }); // instance A records the pause
    const other = new CircuitBreaker(new InMemoryBreakerStore(), {
      planCooldowns: new RedisPlanCooldownStore(boundedBreakerRedis(redis)),
    });
    expect(await other.planCooldownFor(zaiId)).toMatchObject({ kind: 'quota_exhausted' });
    // And the SHORT-window app, a genuinely separate app and breaker, skips it too.
    built.length = 0;
    const res = await chatVia(short, { model: 'zai-first', ...msg });
    expect(res.status).toBe(200);
    expect(zaiBuilds()).toBe(0);
  });

  it('the PROXY_BREAKER, the injected store and the provider view all share one store', async () => {
    const breaker = real.app.get<CircuitBreaker>(PROXY_BREAKER);
    const store = realStore();
    expect(await breaker.planCooldownFor(zaiId)).toBeNull();
    // A record made through the injected store is read by the proxy's breaker...
    const rec = await store.record(zaiId, { kind: 'plan_inactive', default: 30 * MINUTE });
    expect(await breaker.planCooldownFor(zaiId)).toEqual(rec);
    // ...and shown by ProvidersService (an @Optional() that was never injected would give null).
    const view = await real.app.get(ProvidersService).get(principal, zaiId);
    expect(view.planCooldown).toMatchObject({ kind: 'plan_inactive', untilSource: 'default' });
    // A record made through the BREAKER (the walker's path) is read through the store.
    await store.lift(zaiId);
    await breaker.recordPlanCooldown(
      zaiId,
      new ProviderError('risk_control', 'throttled', { status: 429 }),
    );
    expect(await store.check(zaiId)).toMatchObject({ kind: 'risk_control' });
  });

  it('an all-paused chain answers 429 rate_limit_error in both envelopes, not billed, never waiting', async () => {
    await chat({ model: 'zai-only', ...msg }); // dispatches, fails, pauses (nobody to fall back to)
    expect(await realStore().check(zaiId)).not.toBeNull();
    built.length = 0;
    dispatched.length = 0;

    const started = Date.now();
    const openai = await chat({ model: 'zai-only', ...msg });
    expect(Date.now() - started).toBeLessThan(5_000); // a pause is skipped at once, never waited out
    expect(openai.status).toBe(429);
    expect(openai.body.error).toMatchObject({
      type: 'rate_limit_error',
      message: 'upstream plan usage limit reached',
      code: 'plan_quota_exhausted',
    });
    expect(zaiBuilds()).toBe(0);
    expect(dispatched).toEqual([]);
    const row = await lastLog();
    expect(row.status).toBe('error');
    expect(row.error_kind).toBe('quota_exhausted');
    expect(row.billed).toBe(false);
    expect(Number(row.cost ?? 0)).toBe(0);
    // No provider answered: no status and no message, but the estimate and price snapshot stay.
    expect(row.error_status).toBeNull();
    expect(row.error_message).toBeNull();
    expect(row.usage_estimated).toBe(true);
    expect(row.price_source).not.toBeNull();
    expect(row.input_price_snapshot).not.toBeNull();
    expect(row.output_price_snapshot).not.toBeNull();
    expect(row.attempt_failures).toEqual([
      expect.objectContaining({
        kind: 'quota_exhausted',
        dispatched: false,
        skipReason: 'plan_cooldown',
        terminal: true,
      }),
    ]);

    const anthropic = await request(real.server)
      .post('/v1/messages')
      .set('x-api-key', key)
      .send({ model: 'zai-only', max_tokens: 16, ...msg });
    await real.writer.flush();
    expect(anthropic.status).toBe(429);
    expect(anthropic.body).toMatchObject({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'upstream plan usage limit reached' },
    });
  });

  it('a cascade whose cheap leg is all paused escalates to the strong leg', async () => {
    await chat({ model: 'zai-only', ...msg }); // pause the only cheap member
    expect(await realStore().check(zaiId)).not.toBeNull();
    built.length = 0;
    dispatched.length = 0;
    const res = await chat({
      model: 'auto',
      max_completion_tokens: 2,
      messages: [
        { role: 'system', content: `uniq-${Date.now()}-plancd` },
        { role: 'user', content: 'Z'.repeat(8_000) },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'f',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(zaiBuilds()).toBe(0); // the cheap leg was skipped, never dispatched
    expect(dispatched).toEqual(['pay-strong']);
    const row = await lastLog();
    expect(row.escalated).toBe(true);
    expect(row.model_id).toBe(modelId['pay-strong']);
  });

  it('DELETE …/plan-cooldown resumes routing', async () => {
    await chat({ model: 'zai-first', ...msg }); // pauses
    built.length = 0;
    dispatched.length = 0;
    await chat({ model: 'zai-first', ...msg });
    expect(zaiBuilds()).toBe(0); // paused

    const lifted = await request(real.server)
      .delete(`/api/providers/${zaiId}/plan-cooldown`)
      .set('x-test-user', userId);
    expect(lifted.status).toBe(204);
    expect(await realStore().check(zaiId)).toBeNull();

    zaiMode = 'ok';
    built.length = 0;
    dispatched.length = 0;
    const res = await chat({ model: 'zai-first', ...msg });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual(['glm-5']); // the Z.ai member is sent traffic again
    expect((await lastLog()).status).toBe('success');
  });

  describe('with short windows', () => {
    it('the pause ends at its own end although requests keep arriving, and the provider is sent traffic again', async () => {
      const first = await chatVia(short, { model: 'zai-first', ...msg });
      expect(first.status).toBe(200);
      const store = new RedisPlanCooldownStore(boundedBreakerRedis(redis), 'pcd:', SHORT);
      const initial = (await store.check(zaiId))!;
      expect(initial.source).toBe('default');
      expect(initial.until - (await redisNow())).toBeLessThanOrEqual(SHORT.quotaShortMs);

      // Requests arrive throughout the pause, including inside its last default-length stretch
      // (the whole pause is one default-length window). Each is skipped, and none extends it.
      let skips = 0;
      while ((await redisNow()) < initial.until - 400) {
        built.length = 0;
        const res = await chatVia(short, { model: 'zai-first', ...msg });
        expect(res.status).toBe(200);
        expect(zaiBuilds()).toBe(0);
        skips += 1;
        expect((await store.check(zaiId))?.until).toBe(initial.until); // never extended
        await sleep(80);
      }
      expect(skips).toBeGreaterThanOrEqual(2);

      // At its end the record expires by itself, with no write by any caller.
      while ((await redisNow()) < initial.until + 150) await sleep(50);
      expect(await store.check(zaiId)).toBeNull();

      // Routing resumes: the Z.ai member is dispatched again.
      zaiMode = 'ok';
      built.length = 0;
      dispatched.length = 0;
      const after = await chatVia(short, { model: 'zai-first', ...msg });
      expect(after.status).toBe(200);
      expect(dispatched).toEqual(['glm-5']);
      expect(zaiBuilds()).toBe(1);
    }, 30_000);
  });

  it('a pay member that is not a plan row never reads the cooldown store', async () => {
    const spy = jest.spyOn(realStore(), 'check');
    const res = await chat({ model: 'default', ...msg });
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(payId).toBeDefined();
    spy.mockRestore();
  });
});
