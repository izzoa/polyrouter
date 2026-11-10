/* eslint-disable @typescript-eslint/require-await -- fake async generators in tests */
// Plan-usage e2e (add-subscription-quota-display task 6.6): real Postgres and real Redis, a FAKE
// adapter factory (a subscription row cannot sit at a loopback stub: SSRF), and a recording FAKE
// `PLAN_USAGE_READER`. Subscription rows sit on their REAL pinned hosts, which are never dialled;
// the SSRF guard still DNS-resolves them at adapter build, so this suite needs outbound DNS (the
// same posture as plan-cooldown.e2e-spec).
//
// Usage endpoints ship enabled (add-subscription-usage-history). This suite WITHDRAWS them where a
// test needs a row without one, through ONE test seam, a spy on
// `SubscriptionOauthService.prototype.identityBindingFor`; production constants are untouched. Two apps boot over the same Redis (A and B), each with the
// production wiring (PROXY_BREAKER_PROVIDER + PlanCooldownModule + PlanUsageModule +
// ProvidersModule).
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  encryptSecret,
  serializePlainCredential,
  userPrincipal,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import {
  CircuitBreaker,
  RedisPlanUsageStore,
  type NormalizedRequest,
  type NormalizedResponse,
  type NormalizedStreamEvent,
  type PlanUsageObservation,
  type PlanUsageRecorder,
  type PlanUsageReadResult,
  type PlanUsageStore,
  type ProviderAdapter,
  type ProviderConfig,
  type CallContext,
  MERGE_LUA,
} from '@polyrouter/data-plane';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
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
import {
  PLAN_USAGE_READER,
  PLAN_USAGE_RECORDER,
  PLAN_USAGE_STORE,
  PlanUsageModule,
} from '../../src/plan-usage/plan-usage.module';
import { ProvidersModule } from '../../src/providers/providers.module';
import {
  PROVIDER_ADAPTER_FACTORY,
  type ProviderAdapterFactory,
} from '../../src/providers/providers.service';
import {
  OAUTH_TOKEN_FETCH,
  SubscriptionOauthService,
} from '../../src/subscription-oauth/subscription-oauth.service';
import { CLAUDE_PRESET, OAUTH_PRESETS } from '../../src/subscription-oauth/presets';
import { KIMI_CODE_PRESET, OPENCODE_GO_PRESET } from '../../src/subscription-presets/key-presets';
import { uniqueEmail } from '../auth/auth-harness';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/providers/providers.config';
import '../../src/redis/redis.config';

const HMAC = 'a'.repeat(64);
const KEY = 'c'.repeat(64);
const GO = OPENCODE_GO_PRESET.regions[0]!;
const KIMI = KIMI_CODE_PRESET.regions[0]!;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ------------------------------------------------------------------ the fakes

let enableProbes = true;
/** The model ids dispatched upstream, in order. */
const dispatched: string[] = [];
/** The observation the fake upstream "reports" for a model (null = report nothing). */
let obsFor: (model: string) => PlanUsageObservation | null = () => null;
/** Models whose upstream call is held until their gate opens (an in-flight request). */
const holds = new Map<string, Promise<void>>();

/** Reported to the callback ONLY when the built config carries a dialect, as the real adapter. */
function report(config: ProviderConfig, model: string, ctx: CallContext | undefined): void {
  if (config.usageDialect === undefined) return;
  const obs = obsFor(model);
  if (obs !== null) ctx?.onPlanUsage?.(obs);
}

function fakeAdapterFactory(config: ProviderConfig): ProviderAdapter {
  const answer = (req: NormalizedRequest): NormalizedResponse => ({
    id: 'stub-1',
    model: req.model,
    content: [{ type: 'text', text: 'stubbed answer' }],
    stopReason: 'stop',
  });
  return {
    protocol: config.protocol,
    chat: async (req: NormalizedRequest, ctx?: CallContext) => {
      dispatched.push(req.model);
      await holds.get(req.model);
      report(config, req.model, ctx);
      return answer(req);
    },
    chatStream: async function* (
      req: NormalizedRequest,
      ctx?: CallContext,
    ): AsyncGenerator<NormalizedStreamEvent> {
      dispatched.push(req.model);
      await holds.get(req.model);
      report(config, req.model, ctx);
      yield { type: 'message_start', id: 'm1', model: req.model, role: 'assistant' };
      yield { type: 'text_delta', index: 0, text: 'hi' };
      yield { type: 'message_delta', stopReason: 'stop' };
      yield { type: 'message_stop' };
    },
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
  } as unknown as ProviderAdapter;
}

const obs = (
  usedPercent: number,
  billing: PlanUsageObservation['billing'] = 'plan',
  resetInMs: number = HOUR,
): PlanUsageObservation => ({
  windows: [
    {
      key: 'account:5h',
      group: 'account',
      span: '5h',
      minutes: 300,
      scope: null,
      usedPercent,
      reset: { inMs: resetInMs },
    },
  ],
  billing,
});

interface ReaderCall {
  readonly credential: string;
  readonly url: string;
}
const readerCalls: ReaderCall[] = [];
let readerImpl: () => Promise<PlanUsageReadResult> = () =>
  Promise.resolve({ ok: true, observation: obs(25, null) });
const recordingReader = (
  config: ProviderConfig,
  probe: { readonly url: string },
): Promise<PlanUsageReadResult> => {
  readerCalls.push({ credential: config.credential, url: probe.url });
  return readerImpl();
};

const deferred = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
};

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

/** ProxyService's own OAuth seam: the REAL preset lookup (`identityBindingFor`, so the attempt
 * builder sees the real sources) with the credential stubbed. */
function proxyOauthSeam(): SubscriptionOauthService {
  const seam = Object.create(SubscriptionOauthService.prototype) as SubscriptionOauthService;
  Object.assign(seam, {
    presets: {
      find: (id: string) => OAUTH_PRESETS.find((p) => p.id === id),
      list: () => OAUTH_PRESETS,
    },
    resolveCredential: () => Promise.resolve({ credential: 'sub-token', authScheme: 'api_key' }),
    availableClientIdentity: () => null,
  });
  return seam;
}

/** The slice of the provider wire view this suite reads. */
interface WireWindow {
  span: string | null;
  usedPercent: number | null;
  resetAt: string | null;
  observedAt: string;
  source: string;
}
interface WireProvider {
  id: string;
  planUsage: {
    windows: WireWindow[];
    billing: { state: string; observedAt: string } | null;
  } | null;
  planUsageRefresh: { availableAt: string | null } | null;
}

interface Booted {
  readonly app: INestApplication;
  readonly server: App;
  readonly writer: LogWriter;
}

async function bootApp(): Promise<Booted> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SemanticModule,
      DatabaseModule,
      RecordingModule,
      RedisModule,
      ObservabilityModule,
      PlanCooldownModule,
      PlanUsageModule,
      ProvidersModule,
    ],
    controllers: [ChatCompletionsController, MessagesController],
    providers: [
      AgentApiKeyGuard,
      ProxyService,
      { provide: SubscriptionOauthService, useValue: proxyOauthSeam() },
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
      PROXY_BREAKER_PROVIDER,
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
  })
    .overrideProvider(PROVIDER_ADAPTER_FACTORY)
    .useValue(fakeAdapterFactory as unknown as ProviderAdapterFactory)
    .overrideProvider(PLAN_USAGE_READER)
    .useValue(recordingReader)
    .overrideProvider(OAUTH_TOKEN_FETCH)
    .useValue(() =>
      Promise.resolve({
        accessToken: 'at-e2e-1',
        refreshToken: 'rt-e2e-1',
        expiresAt: Date.now() + 3_600_000,
      }),
    )
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.init();
  return { app, server: app.getHttpServer(), writer: app.get(LogWriter) };
}

describe('plan usage e2e (add-subscription-quota-display)', () => {
  let a: Booted;
  let b: Booted;
  let pool: Pool;
  let port: PersistencePort;
  let redis: Redis;
  let userA: string;
  let userB: string;
  let principalA: Principal;
  let agentKey: string;
  let claude: ProviderRow;
  let go: ProviderRow;
  let kimi: ProviderRow;
  let pay: ProviderRow;
  const modelId: Record<string, string> = {};
  const seeded: ProviderRow[] = [];
  let bindingSpy: jest.SpyInstance;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const redisNow = async (): Promise<number> => {
    const [s, us] = await redis.time();
    return Number(s) * 1000 + Math.floor(Number(us) / 1000);
  };
  const usageKeys = (id: string): string[] => [`pu:${id}`, `pur:${id}`, `pug:${id}`];
  const store = (booted: Booted = a): PlanUsageStore => booted.app.get(PLAN_USAGE_STORE);
  const recorder = (booted: Booted): PlanUsageRecorder => booted.app.get(PLAN_USAGE_RECORDER);
  const snapshotOf = async (id: string): Promise<Record<string, unknown> | null> => {
    const raw = await redis.get(`pu:${id}`);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  };
  const waitFor = async (cond: () => Promise<boolean>, ms = 3_000): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await sleep(25);
    }
    throw new Error('waitFor timed out');
  };

  async function insertProvider(
    over: Parameters<PersistencePort['providers']['insert']>[1],
  ): Promise<ProviderRow> {
    const row = await port.providers.insert(principalA, over);
    seeded.push(row);
    return row;
  }
  const encrypted = (plain: string): string => encryptSecret(serializePlainCredential(plain), KEY);

  /** Forget everything a test could have left for `ids`: Redis keys, both apps' recorders (so a
   * fresh observation is written at once), and the breaker/cooldown keys. */
  async function resetUsage(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await redis.del(...usageKeys(id), `cb:${id}`, `pcd:${id}`);
      recorder(a).noteCleared(id, 0);
      recorder(b).noteCleared(id, 0);
    }
  }
  const allIds = (): string[] => seeded.map((p) => p.id);

  const as = (user: string, method: 'get' | 'post' | 'patch', path: string): request.Test => {
    const agent = request(a.server);
    const req =
      method === 'get' ? agent.get(path) : method === 'post' ? agent.post(path) : agent.patch(path);
    return req.set('x-test-user', user).set('Cookie', 'session_token=cookie-1');
  };
  const view = async (id: string, booted: Booted = a): Promise<WireProvider> => {
    const res = await request(booted.server).get(`/api/providers/${id}`).set('x-test-user', userA);
    expect(res.status).toBe(200);
    return res.body as WireProvider;
  };
  const refresh = (id: string, booted: Booted = a, user: string = userA): request.Test =>
    request(booted.server).post(`/api/providers/${id}/plan-usage/refresh`).set('x-test-user', user);
  const chat = async (
    model: string,
    extra: Record<string, unknown> = {},
    booted: Booted = a,
  ): Promise<request.Response> => {
    const res = await request(booted.server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ model, messages: [{ role: 'user', content: 'hello' }], ...extra });
    await booted.writer.flush();
    return res;
  };

  interface LogRow {
    status: string;
    model_id: string | null;
    provider_kind: string | null;
    routing_reason: string;
    billed: boolean | null;
    cost: string | null;
    price_source: string | null;
    input_price_snapshot: number | null;
    output_price_snapshot: number | null;
  }
  const lastLog = async (): Promise<LogRow> =>
    (
      await pool.query<LogRow>(
        `SELECT status, model_id, provider_kind, routing_reason, billed, cost, price_source,
                input_price_snapshot, output_price_snapshot
           FROM request_log WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userA],
      )
    ).rows[0]!;
  const health = async (id: string): Promise<Record<string, unknown>> =>
    (
      await pool.query(
        `SELECT status, last_error_kind, status_source, status_changed_at, status_rev, traffic_state,
                traffic_error_kind, traffic_at, traffic_seq, traffic_rev, health_rev
           FROM provider WHERE id = $1`,
        [id],
      )
    ).rows[0] as Record<string, unknown>;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = KEY;
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    process.env['ROUTING_AUTO_LAYERS'] = 'structural';

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    // The ONE test seam: withdraw every usage probe while `enableProbes` is false (they ship
    // enabled since add-subscription-usage-history).
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-invoked below with `.call(this, …)`
    const original = SubscriptionOauthService.prototype.identityBindingFor;
    bindingSpy = jest
      .spyOn(SubscriptionOauthService.prototype, 'identityBindingFor')
      .mockImplementation(function (this: SubscriptionOauthService, row) {
        const binding = original.call(this, row);
        const probe = binding?.usage?.probe;
        if (enableProbes || binding === undefined || probe === undefined) return binding;
        return { ...binding, usage: { ...binding.usage, probe: { ...probe, enabled: false } } };
      });

    a = await bootApp();
    b = await bootApp();
    port = a.app.get<PersistencePort>(PERSISTENCE_PORT);
    redis = a.app.get<Redis>(REDIS_CLIENT);

    const mkUser = async (label: string): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
          [label, uniqueEmail(`pu-${label}`)],
        )
      ).rows[0]!.id;
    userA = await mkUser('pu-a');
    userB = await mkUser('pu-b');
    principalA = userPrincipal(userA);

    // A Claude OAuth-preset row at its REAL pin, an OpenCode Go and a Kimi key-preset row at
    // theirs (never dialled), and a pay-per-token member.
    claude = await insertProvider({
      name: 'pu-claude',
      kind: 'subscription',
      protocol: CLAUDE_PRESET.protocol,
      baseUrl: CLAUDE_PRESET.baseUrl,
      oauthPreset: CLAUDE_PRESET.id,
      encryptedCredentials: encrypted('claude-token'),
    });
    go = await insertProvider({
      name: 'pu-go',
      kind: 'subscription',
      protocol: GO.protocol,
      baseUrl: GO.baseUrl,
      keyPreset: OPENCODE_GO_PRESET.id,
      encryptedCredentials: encrypted('go-key-1'),
    });
    kimi = await insertProvider({
      name: 'pu-kimi',
      kind: 'subscription',
      protocol: KIMI.protocol,
      baseUrl: KIMI.baseUrl,
      keyPreset: KIMI_CODE_PRESET.id,
      encryptedCredentials: encrypted('kimi-key-1'),
    });
    pay = await insertProvider({
      name: 'pu-pay',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com',
    });

    const add = async (provider: ProviderRow, ext: string): Promise<void> => {
      modelId[ext] = (await port.models.createForProvider(principalA, provider.id, {
        externalModelId: ext,
      }))!.id;
      // A subscription row honours no model-own rate; the captured listed estimate gives it a
      // price snapshot (record-listed-price-fallback).
      await pool.query(
        `UPDATE model SET listed_input_price_per_1m = 2, listed_output_price_per_1m = 10, listed_is_free = false,
                listed_price_captured_at = now() WHERE id = $1`,
        [modelId[ext]],
      );
    };
    await add(claude, 'claude-test-1');
    await add(go, 'go-test-1');
    await add(pay, 'pay-1');

    await port.ensureDefaultTier(principalA);
    const tiers = new Map((await port.tiers.list(principalA)).map((t) => [t.key, t.id]));
    const setTier = async (keyName: string, exts: string[]): Promise<void> => {
      let id = tiers.get(keyName);
      if (id === undefined) {
        id = (await port.tiers.insert(principalA, { key: keyName })).id;
        tiers.set(keyName, id);
      }
      await port.routingEntries.replaceForTier(
        principalA,
        id,
        exts.map((e) => modelId[e]!),
      );
    };
    await setTier('default', ['pay-1']);
    await setTier('claude-only', ['claude-test-1']);
    await setTier('claude-first', ['claude-test-1', 'pay-1']);
    await setTier('go-only', ['go-test-1']);

    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl')`,
      [userA, minted.hash, minted.prefix],
    );
    agentKey = minted.key;
  }, 120_000);

  afterAll(async () => {
    bindingSpy.mockRestore();
    if (redis) {
      const ids = (
        await pool.query<{ id: string }>('SELECT id FROM provider WHERE owner_user_id = $1', [
          userA,
        ])
      ).rows.map((r) => r.id);
      for (const id of ids) await redis.del(...usageKeys(id), `cb:${id}`, `pcd:${id}`);
    }
    if (userA) await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[userA, userB]]);
    await a?.app.close();
    await b?.app.close();
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userA]);
    // Reset the per-principal + per-IP OAuth connect throttles (shared 10/min window).
    const throttles = [...(await redis.keys('rl:oauthp:*')), ...(await redis.keys('rl:oauthc:*'))];
    if (throttles.length > 0) await redis.del(...throttles);
    await resetUsage(allIds());
    enableProbes = true;
    dispatched.length = 0;
    readerCalls.length = 0;
    holds.clear();
    obsFor = () => null;
    readerImpl = () => Promise.resolve({ ok: true, observation: obs(25, null) });
  });

  // ------------------------------------------------------------------ capture and the view

  it('capture: a Claude preset row served a request shows its windows on GET /api/providers', async () => {
    obsFor = (m) => (m === 'claude-test-1' ? obs(42, 'plan') : null);
    const res = await chat('claude-only');
    expect(res.status).toBe(200);
    await waitFor(async () => (await redis.exists(`pu:${claude.id}`)) === 1);

    const list = await request(a.server).get('/api/providers').set('x-test-user', userA);
    expect(list.status).toBe(200);
    const row = (list.body as WireProvider[]).find((p) => p.id === claude.id)!;
    // add-subscription-usage-history: the Claude preset now declares a usage endpoint, yet
    // serving traffic calls no usage endpoint (only Refresh usage and the schedule do).
    expect(row.planUsageRefresh).toEqual({ availableAt: null });
    expect(readerCalls).toHaveLength(0);
    expect(await redis.exists(`pur:${claude.id}`)).toBe(0);
    expect(row.planUsage!.windows).toHaveLength(1);
    expect(row.planUsage!.windows[0]).toMatchObject({
      span: '5h',
      usedPercent: 42,
      source: 'traffic',
    });
    expect(new Date(row.planUsage!.windows[0]!.observedAt).toISOString()).toBe(
      row.planUsage!.windows[0]!.observedAt,
    );
    expect(new Date(row.planUsage!.windows[0]!.resetAt!).getTime()).toBeGreaterThan(Date.now());
    expect(row.planUsage!.billing!.state).toBe('plan');
    // The wire never carries a dialect, an endpoint or an auth style.
    expect(JSON.stringify(row)).not.toMatch(/dialect|usageProbe|bearer|parser/i);
    // A pay-per-token row carries nothing.
    const payRow = (list.body as WireProvider[]).find((p) => p.id === pay.id)!;
    expect(payRow.planUsage).toBeNull();
    expect(payRow.planUsageRefresh).toBeNull();
  });

  it('a row with no usage source pays nothing: the pay member is served and nothing is written', async () => {
    obsFor = () => obs(10);
    await chat('default'); // the pay member, no usage source
    await sleep(100);
    expect(await redis.exists(`pu:${pay.id}`)).toBe(0);
  });

  // ------------------------------------------------------------------ ordering through the real Lua

  describe('ordering through the real Lua', () => {
    const lua = (): RedisPlanUsageStore => new RedisPlanUsageStore(boundedBreakerRedis(redis));
    const freshId = (): string => `00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0')}`;
    const atMs = async (offset: number): Promise<number> => (await redisNow()) + offset;
    const win = (
      pct: number,
      resetAt: number | null,
      key = 'account:5h',
    ): PlanUsageObservation['windows'][number] => ({
      key,
      group: 'account',
      span: '5h',
      minutes: 300,
      scope: null,
      usedPercent: pct,
      reset: resetAt === null ? null : { atMs: resetAt },
    });

    it('two observations merge out of order: the higher percent of one reset wins', async () => {
      const id = freshId();
      const reset = await atMs(2 * HOUR);
      await lua().merge(id, { windows: [win(42, reset)], billing: null }, 0, 'traffic');
      await lua().merge(id, { windows: [win(40, reset + 5_000)], billing: null }, 0, 'traffic');
      const stored = (await snapshotOf(id))!;
      expect((stored['windows'] as Array<Record<string, unknown>>)[0]!['usedPercent']).toBe(42);
      await redis.del(...usageKeys(id));
    });

    it('a delayed pre-reset extra_usage observation after a post-reset plan one leaves plan', async () => {
      const id = freshId();
      await lua().merge(
        id,
        { windows: [win(3, await atMs(5 * HOUR))], billing: 'plan' },
        0,
        'traffic',
      );
      const late = await lua().merge(
        id,
        { windows: [win(98, await atMs(HOUR))], billing: 'extra_usage' },
        0,
        'traffic',
      );
      expect(late.applied).toBe(true);
      const stored = (await snapshotOf(id))!;
      expect((stored['billing'] as Record<string, unknown>)['state']).toBe('plan');
      expect((stored['windows'] as Array<Record<string, unknown>>)[0]!['usedPercent']).toBe(3);
      await redis.del(...usageKeys(id));
    });

    it('a delayed observation with one earlier-reset window leaves plan even beside a same-reset window', async () => {
      const id = freshId();
      const weeklyReset = await atMs(3 * 24 * HOUR);
      const weekly = (pct: number): PlanUsageObservation['windows'][number] => ({
        ...win(pct, weeklyReset, 'account:weekly'),
        span: 'weekly',
        minutes: 10_080,
      });
      await lua().merge(
        id,
        { windows: [win(3, await atMs(5 * HOUR)), weekly(50)], billing: 'plan' },
        0,
        'traffic',
      );
      await lua().merge(
        id,
        { windows: [win(98, await atMs(HOUR)), weekly(55)], billing: 'extra_usage' },
        0,
        'traffic',
      );
      const stored = (await snapshotOf(id))!;
      expect((stored['billing'] as Record<string, unknown>)['state']).toBe('plan');
      await redis.del(...usageKeys(id));
    });

    it('a null-reset window never displaces a dated one', async () => {
      const id = freshId();
      await lua().merge(
        id,
        { windows: [win(10, await atMs(3 * HOUR))], billing: null },
        0,
        'traffic',
      );
      await lua().merge(id, { windows: [win(77, null)], billing: null }, 0, 'traffic');
      const stored = (await snapshotOf(id))!;
      const w = (stored['windows'] as Array<Record<string, unknown>>)[0]!;
      expect(w['usedPercent']).toBe(10);
      expect(w['resetMs']).not.toBeNull();
      await redis.del(...usageKeys(id));
    });

    it('a reset in milliseconds in a seconds field is dropped by the Lua bound', async () => {
      const id = freshId();
      // 1764554400 s read as ms then scaled again: a year ~57000 instant.
      await lua().merge(
        id,
        { windows: [win(20, 1_764_554_400_000 * 1000)], billing: null },
        0,
        'traffic',
      );
      const stored = (await snapshotOf(id))!;
      const w = (stored['windows'] as Array<Record<string, unknown>>)[0]!;
      expect(w['usedPercent']).toBe(20);
      expect(w['resetMs'] ?? null).toBeNull(); // kept with an unknown reset (absent = null); the bad instant is never stored
      await redis.del(...usageKeys(id));
    });
  });

  // ------------------------------------------------------------------ the hot path

  it('hot path: 50 identical requests make exactly one pu: write', async () => {
    obsFor = (m) => (m === 'claude-test-1' ? obs(10, 'plan') : null);
    const evalSpy = jest.spyOn(redis, 'eval');
    try {
      for (let i = 0; i < 50; i += 1) {
        const res = await chat('claude-only');
        expect(res.status).toBe(200);
      }
      await sleep(300);
      const merges = evalSpy.mock.calls.filter((c) => c[0] === MERGE_LUA);
      expect(merges).toHaveLength(1);
      expect(merges[0]![2]).toBe(`pu:${claude.id}`); // KEYS[1] is the snapshot key
      expect(await redis.exists(`pu:${claude.id}`)).toBe(1);
    } finally {
      evalSpy.mockRestore();
    }
  }, 60_000);

  // ------------------------------------------------------------------ tenant isolation

  it('tenant isolation: B cannot see A usage, and B refreshing A id is 404 with no read', async () => {
    await store().merge(kimi.id, obs(33, null), 0, 'refresh');
    const list = await request(a.server).get('/api/providers').set('x-test-user', userB);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain('usedPercent');
    const get = await request(a.server).get(`/api/providers/${kimi.id}`).set('x-test-user', userB);
    expect(get.status).toBe(404);
    expect(JSON.stringify(get.body)).not.toContain('usedPercent');
    const res = await refresh(kimi.id, a, userB);
    expect(res.status).toBe(404);
    expect(readerCalls).toHaveLength(0);
    expect(await redis.exists(`pur:${kimi.id}`)).toBe(0); // not even a claim
  });

  // ------------------------------------------------------------------ refresh

  describe('refresh', () => {
    it('422 for a provider with no enabled usage endpoint, with no claim and no read', async () => {
      enableProbes = false;
      for (const row of [kimi, go, claude, pay]) {
        const res = await refresh(row.id);
        expect(res.status).toBe(422);
      }
      expect(readerCalls).toHaveLength(0);
      for (const row of [kimi, go]) expect(await redis.exists(`pur:${row.id}`)).toBe(0);
      // And the card offers none.
      expect((await view(kimi.id))['planUsageRefresh']).toBeNull();
    });

    it('a refreshable row with no data offers refresh now', async () => {
      const v = await view(kimi.id);
      expect(v['planUsage']).toBeNull();
      expect(v['planUsageRefresh']).toEqual({ availableAt: null });
    });

    it('success: 200 ok with the view, source refresh, and availableAt five minutes out', async () => {
      const before = await redisNow();
      const res = await refresh(kimi.id);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.ok).toBe(true);
      expect(res.body.provider.planUsage.windows[0]).toMatchObject({
        usedPercent: 25,
        source: 'refresh',
      });
      const availableAt = new Date(res.body.provider.planUsageRefresh.availableAt).getTime();
      expect(availableAt - before).toBeGreaterThan(4 * MINUTE + 50_000);
      expect(availableAt - before).toBeLessThanOrEqual(5 * MINUTE + 5_000);
      expect(readerCalls).toEqual([{ credential: 'kimi-key-1', url: KIMI.usageProbe!.url }]);
    });

    it('429 with Retry-After while the cooldown holds, and nothing is sent', async () => {
      expect((await refresh(kimi.id)).status).toBe(200);
      const second = await refresh(kimi.id);
      expect(second.status).toBe(429);
      const retry = Number(second.headers['retry-after']);
      expect(Number.isInteger(retry)).toBe(true);
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(300);
      expect(new Date(second.body.availableAt).getTime()).toBeGreaterThan(Date.now());
      expect(readerCalls).toHaveLength(1);
    });

    it('503 when Redis is paused through the bounded race, and nothing is sent', async () => {
      const ctl = redis.duplicate();
      try {
        await ctl.call('CLIENT', 'PAUSE', '1500', 'ALL');
        const res = await refresh(kimi.id);
        expect(res.status).toBe(503);
        expect(readerCalls).toHaveLength(0);
      } finally {
        ctl.disconnect();
      }
      // The paused claim may still land when Redis resumes; wait it out, then clean up.
      await sleep(1_800);
      await redis.del(...usageKeys(kimi.id));
    }, 20_000);

    it('a failed read answers 200 ok:false with a fixed message, keeps the old usage and the cooldown', async () => {
      await store().merge(kimi.id, obs(60, null), 0, 'refresh');
      readerImpl = () =>
        Promise.resolve({
          ok: false,
          kind: 'auth',
          message: 'The provider rejected the credential for its usage endpoint.',
        });
      const res = await refresh(kimi.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, kind: 'auth' });
      expect(res.body.message).toMatch(/rejected the credential/);
      expect(res.body.provider.planUsage.windows[0].usedPercent).toBe(60);
      expect((await refresh(kimi.id)).status).toBe(429);
      expect(readerCalls).toHaveLength(1);
    });

    it('an upstream 429 Retry-After extends the shared cooldown', async () => {
      readerImpl = () =>
        Promise.resolve({
          ok: false,
          kind: 'rate_limit',
          message: 'The usage endpoint is rate limiting reads.',
          retryAfterMs: 15 * MINUTE,
        });
      const before = await redisNow();
      const res = await refresh(kimi.id);
      const availableAt = new Date(res.body.provider.planUsageRefresh.availableAt).getTime();
      expect(availableAt - before).toBeGreaterThan(14 * MINUTE);
      expect(availableAt - before).toBeLessThanOrEqual(15 * MINUTE + 5_000);
    });

    it('two app instances on one Redis make one reader call between them', async () => {
      const [first, second] = await Promise.all([refresh(kimi.id, a), refresh(kimi.id, b)]);
      expect([first.status, second.status].sort()).toEqual([200, 429]);
      expect(readerCalls).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ health-silent

  it('health-silent: refreshes and captures change no check or traffic record, cb: or pcd: key', async () => {
    // A refresh on a provider with no traffic: its whole health surface stays as it was.
    await redis.hset(`cb:${kimi.id}`, 'seed', '1');
    const kimiHealth = await health(kimi.id);
    const kimiCb = await redis.hgetall(`cb:${kimi.id}`);
    expect((await refresh(kimi.id)).status).toBe(200);
    await redis.del(`pur:${kimi.id}`);
    expect((await refresh(kimi.id)).status).toBe(200);
    expect(await health(kimi.id)).toEqual(kimiHealth);
    expect(await redis.hgetall(`cb:${kimi.id}`)).toEqual(kimiCb);
    expect(await redis.exists(`pcd:${kimi.id}`)).toBe(0);

    // A captured request: after one served request the provider is displayed ok; further
    // captures with CHANGED usage touch nothing of the health surface.
    obsFor = (m) => (m === 'claude-test-1' ? obs(10, 'plan') : null);
    await chat('claude-only');
    await sleep(150);
    const claudeHealth = await health(claude.id);
    // Every served request advances the breaker's own `lastSeq` (a property of the TRAFFIC, with or
    // without capture), so it is excluded; state, failures, generation and the open/probe times
    // are what capture must never touch.
    const breakerOf = async (id: string): Promise<Record<string, string>> => {
      const { lastSeq: _seq, ...rest } = await redis.hgetall(`cb:${id}`);
      return rest;
    };
    const claudeCb = await breakerOf(claude.id);
    obsFor = (m) => (m === 'claude-test-1' ? obs(55, 'extra_usage') : null);
    await chat('claude-only');
    await waitFor(async () => {
      const snap = await snapshotOf(claude.id);
      return (
        (snap?.['billing'] as Record<string, unknown> | undefined)?.['state'] === 'extra_usage'
      );
    });
    expect(await health(claude.id)).toEqual(claudeHealth);
    expect(await breakerOf(claude.id)).toEqual(claudeCb);
    expect(await redis.exists(`pcd:${claude.id}`)).toBe(0);
  });

  // ------------------------------------------------------------------ display-only

  it('display-only: a 100% snapshot changes no routing, cost, provider_kind, cooldown or client header', async () => {
    // Control: no snapshot.
    const control = await chat('claude-first');
    expect(control.status).toBe(200);
    expect(dispatched).toEqual(['claude-test-1']);
    const controlLog = await lastLog();

    // Capture a 100% window with usage credits billing.
    obsFor = (m) => (m === 'claude-test-1' ? obs(100, 'extra_usage') : null);
    await chat('claude-first');
    await waitFor(async () => (await redis.exists(`pu:${claude.id}`)) === 1);
    expect((await view(claude.id)).planUsage!.windows[0]!.usedPercent).toBe(100);

    dispatched.length = 0;
    await pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userA]);
    const res = await chat('claude-first');
    expect(res.status).toBe(200);
    // Still routed to the same member at its configured position.
    expect(dispatched).toEqual(['claude-test-1']);
    const log = await lastLog();
    expect(log).toMatchObject({
      status: controlLog.status,
      model_id: controlLog.model_id,
      provider_kind: controlLog.provider_kind,
      billed: controlLog.billed,
      cost: controlLog.cost,
      price_source: controlLog.price_source,
      input_price_snapshot: controlLog.input_price_snapshot,
      output_price_snapshot: controlLog.output_price_snapshot,
    });
    expect(log.routing_reason).toBe(controlLog.routing_reason);
    // No plan cooldown from a snapshot. (The fake adapter cannot emit upstream headers, so the
    // header drop itself is asserted in the data-plane http-adapter spec, "clients never see
    // quota headers"; this only guards the proxy response path against copying any.)
    expect(await redis.exists(`pcd:${claude.id}`)).toBe(0);
    for (const name of Object.keys(res.headers)) {
      expect(name).not.toMatch(/^anthropic-ratelimit-unified-|^x-codex-/);
    }
  });

  // ------------------------------------------------------------------ clearing

  describe('clearing', () => {
    it('a credential patch clears the snapshot and keeps the cooldown', async () => {
      expect((await refresh(kimi.id)).status).toBe(200);
      expect(await redis.exists(`pu:${kimi.id}`)).toBe(1);
      const cooldown = await redis.pttl(`pur:${kimi.id}`);
      expect(cooldown).toBeGreaterThan(0);

      const patched = await as(userA, 'patch', `/api/providers/${kimi.id}`).send({
        credential: 'kimi-key-2',
      });
      expect(patched.status).toBe(200);
      expect(await redis.exists(`pu:${kimi.id}`)).toBe(0);
      expect(await redis.get(`pug:${kimi.id}`)).toBe('1');
      expect(await redis.pttl(`pur:${kimi.id}`)).toBeGreaterThan(0); // the cooldown stands
      expect(patched.body.planUsage).toBeNull();
      expect(patched.body.planUsageRefresh.availableAt).not.toBeNull();
      // A name-only patch clears nothing.
      await store().merge(kimi.id, obs(12, null), 1, 'refresh');
      await as(userA, 'patch', `/api/providers/${kimi.id}`).send({ name: 'pu-kimi' }).expect(200);
      expect(await redis.exists(`pu:${kimi.id}`)).toBe(1);
      // Re-sending the SAME key still keeps the cooldown (never shortens it).
      await as(userA, 'patch', `/api/providers/${kimi.id}`).send({ credential: 'kimi-key-2' });
      expect(await redis.pttl(`pur:${kimi.id}`)).toBeGreaterThan(0);
      expect((await refresh(kimi.id)).status).toBe(429);
      // Restore the original key for later tests.
      await pool.query(`UPDATE provider SET encrypted_credentials = $2 WHERE id = $1`, [
        kimi.id,
        encrypted('kimi-key-1'),
      ]);
    });

    it('an observation from an attempt built before the patch, delivered after it, is dropped', async () => {
      obsFor = (m) => (m === 'go-test-1' ? obs(0, 'extra_usage') : null);
      const gate = deferred();
      holds.set('go-test-1', gate.promise);
      const inflight = chat('go-only', { stream: true });
      await waitFor(() => Promise.resolve(dispatched.includes('go-test-1')));

      const patched = await as(userA, 'patch', `/api/providers/${go.id}`).send({
        credential: 'go-key-2',
      });
      expect(patched.status).toBe(200);
      expect(await redis.get(`pug:${go.id}`)).toBe('1');
      gate.open(); // the old stream ends AFTER the rotation
      expect((await inflight).status).toBe(200);
      await sleep(300);
      expect(await redis.exists(`pu:${go.id}`)).toBe(0); // dropped by the real Lua

      // A request built AFTER the rotation carries the new generation and IS recorded.
      holds.clear();
      dispatched.length = 0;
      await chat('go-only');
      await waitFor(async () => (await redis.exists(`pu:${go.id}`)) === 1);
      await pool.query(`UPDATE provider SET encrypted_credentials = $2 WHERE id = $1`, [
        go.id,
        encrypted('go-key-1'),
      ]);
    });

    it('a refresh whose reader is held across a key rotation completes without recreating pu:', async () => {
      const gate = deferred();
      readerImpl = async () => {
        await gate.promise;
        return { ok: true, observation: obs(70, null) };
      };
      const inflight = refresh(kimi.id).then((r) => r);
      await waitFor(() => Promise.resolve(readerCalls.length === 1));
      const patched = await as(userA, 'patch', `/api/providers/${kimi.id}`).send({
        credential: 'kimi-key-3',
      });
      expect(patched.status).toBe(200);
      gate.open();
      const done = await inflight;
      expect(done.status).toBe(200);
      expect(done.body.ok).toBe(false); // superseded by the rotation
      expect(await redis.exists(`pu:${kimi.id}`)).toBe(0);
      expect(await redis.pttl(`pur:${kimi.id}`)).toBeGreaterThan(0);
      await pool.query(`UPDATE provider SET encrypted_credentials = $2 WHERE id = $1`, [
        kimi.id,
        encrypted('kimi-key-1'),
      ]);
    });

    it('a reconnect through the OAuth complete path drops an in-flight Claude observation', async () => {
      // Connect the REAL Claude preset through start/complete, then add a model and a tier on it.
      const start = await as(userA, 'post', '/api/providers/oauth/start').send({
        preset: 'claude',
      });
      expect(start.status).toBe(200);
      const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
      const created = await as(userA, 'post', '/api/providers/oauth/complete').send({
        sessionId: start.body.sessionId,
        pasted: `the-code#${state}`,
      });
      expect(created.status).toBe(200);
      const id = created.body.id as string;
      seeded.push((await port.providers.findById(principalA, id))!);
      modelId['claude-conn-1'] = (await port.models.createForProvider(principalA, id, {
        externalModelId: 'claude-conn-1',
      }))!.id;
      await pool.query(
        `UPDATE model SET listed_input_price_per_1m = 2, listed_output_price_per_1m = 10, listed_is_free = false,
                listed_price_captured_at = now() WHERE id = $1`,
        [modelId['claude-conn-1']],
      );
      const tier = await port.tiers.insert(principalA, { key: 'claude-conn' });
      await port.routingEntries.replaceForTier(principalA, tier.id, [modelId['claude-conn-1']!]);
      expect(await redis.get(`pug:${id}`)).toBe('1'); // the connect itself cleared once

      obsFor = (m) => (m === 'claude-conn-1' ? obs(80, 'extra_usage') : null);
      const gate = deferred();
      holds.set('claude-conn-1', gate.promise);
      const inflight = chat('claude-conn');
      await waitFor(() => Promise.resolve(dispatched.includes('claude-conn-1')));

      // Reconnect (reauthorize) into the SAME row while the call is in flight.
      const re = await as(userA, 'post', `/api/providers/oauth/reauthorize/${id}`).send({});
      expect(re.status).toBe(200);
      const reState = new URL(re.body.authorizeUrl).searchParams.get('state')!;
      const done = await as(userA, 'post', '/api/providers/oauth/complete').send({
        sessionId: re.body.sessionId,
        pasted: `code-2#${reState}`,
      });
      expect(done.status).toBe(200);
      expect(done.body.id).toBe(id);
      expect(await redis.get(`pug:${id}`)).toBe('2');

      gate.open(); // the old call's headers arrive after the reconnect
      expect((await inflight).status).toBe(200);
      await sleep(300);
      expect(await redis.exists(`pu:${id}`)).toBe(0);
      // The view carries no usage until a new response is observed.
      expect((await view(id))['planUsage']).toBeNull();
      holds.clear();
      await chat('claude-conn');
      await waitFor(async () => (await redis.exists(`pu:${id}`)) === 1);
      await redis.del(...usageKeys(id));
    }, 60_000);
  });

  it('the PROXY_BREAKER, the injected store and the recorder share one instance per app', async () => {
    const breaker = a.app.get<CircuitBreaker>(PROXY_BREAKER);
    // A generation learned through the shared recorder is read by the proxy's breaker.
    recorder(a).noteCleared(go.id, 7);
    expect(breaker.planUsageGeneration(go.id)).toBe(7);
    recorder(a).noteCleared(go.id, 0);
  });
});
