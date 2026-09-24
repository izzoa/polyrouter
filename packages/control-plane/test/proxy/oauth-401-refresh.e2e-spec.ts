// add-provider-health-signals (task 6.3): an upstream 401 on an OAuth-connected
// provider triggers ONE bounded, out-of-band forced refresh keyed on the credential
// the failing attempt used — over the real proxy, the REAL SubscriptionOauthService,
// Postgres and Redis, with a stub identity provider and an adapter factory that
// accepts only the currently-valid access token.
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
  serializeOauthCredential,
  serializePlainCredential,
  userPrincipal,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  ProviderError,
  type ProviderAdapter,
  type ProviderConfig,
} from '@polyrouter/data-plane';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import { mintAgentKey } from '../../src/agents/agent-keys';
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
import { NotificationProducers } from '../../src/producers/notification-producers';
import { BudgetService } from '../../src/budgets/budget-service';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { WorkloadRouter } from '../../src/proxy/workload/workload-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { RecordingModule } from '../../src/recording/recording.module';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { DatabaseModule } from '../../src/database/database.module';
import { SemanticModule } from '../../src/semantic/semantic.module';
import { ProvidersModule } from '../../src/providers/providers.module';
import { SubscriptionOauthModule } from '../../src/subscription-oauth/subscription-oauth.module';
import {
  OAUTH_PRESET_LOOKUP,
  OAUTH_TOKEN_FETCH,
} from '../../src/subscription-oauth/subscription-oauth.service';
import { TokenEndpointError, type TokenSet } from '../../src/subscription-oauth/oauth-client';
import type { OauthPreset } from '../../src/subscription-oauth/presets';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import '../../src/redis/redis.config';

const HMAC = 'a'.repeat(64);
const CRED_KEY = 'e'.repeat(64);
const HOURS_240 = 240 * 60 * 60 * 1000;

const PRESET: OauthPreset = {
  id: 'stub-claude-401',
  displayName: 'Stub Claude',
  baseUrl: 'https://1.1.1.1/v1',
  protocol: 'anthropic_compatible',
  authorizeUrl: 'https://idp.example/authorize',
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'client-e2e',
  scopes: 'user:inference',
  redirectUri: 'https://idp.example/oauth/code/callback',
  tokenRequestEncoding: 'json',
  includeStateInExchange: true,
  oauthBeta: 'oauth-2025-04-20',
  modelsSource: 'endpoint',
  enabled: true,
};

@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.path.startsWith('/api')) return true;
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

// Stub identity provider + the one access token the "upstream" accepts.
let exchanges = 0;
let tokenQueue: Array<() => Promise<TokenSet>> = [];
let validToken = 'at-new';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('401-triggered forced refresh (add-provider-health-signals)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let redis: Redis;
  let userId: string;
  let principal: Principal;
  let key: string;
  let n = 0;

  const chat = (model: string) =>
    request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send({ model, messages: [{ role: 'user', content: 'hi' }] });

  /** An OAuth-connected subscription provider whose stored access token is `token`. */
  async function oauthProvider(
    token: string,
    expiresInMs: number,
  ): Promise<{ id: string; model: string }> {
    const tag = `${Date.now()}-${++n}`;
    const expiresAt = Date.now() + expiresInMs;
    const p = await port.providers.insert(principal, {
      name: `sub-${tag}`,
      kind: 'subscription',
      protocol: 'anthropic_compatible',
      baseUrl: PRESET.baseUrl,
      oauthPreset: PRESET.id,
      credentialExpiresAt: new Date(expiresAt),
      encryptedCredentials: encryptSecret(
        serializeOauthCredential({
          preset: PRESET.id,
          accessToken: token,
          refreshToken: 'rt-1',
          expiresAt,
        }),
        CRED_KEY,
      ),
    });
    const model = `sub-model-${tag}`;
    await port.models.createForProvider(principal, p.id, { externalModelId: model });
    return { id: p.id, model };
  }

  async function apiKeyProvider(): Promise<{ id: string; model: string }> {
    const tag = `${Date.now()}-${++n}`;
    const p = await port.providers.insert(principal, {
      name: `key-${tag}`,
      kind: 'api_key',
      protocol: 'anthropic_compatible',
      baseUrl: 'https://1.1.1.1/v1',
      encryptedCredentials: encryptSecret(serializePlainCredential('sk-rejected'), CRED_KEY),
    });
    const model = `key-model-${tag}`;
    await port.models.createForProvider(principal, p.id, { externalModelId: model });
    return { id: p.id, model };
  }

  const tokenSet =
    (access: string): (() => Promise<TokenSet>) =>
    () =>
      Promise.resolve({
        accessToken: access,
        refreshToken: `rt-${access}`,
        expiresAt: Date.now() + HOURS_240,
      });

  async function until(pred: () => Promise<boolean> | boolean, ms = 3_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return;
      await sleep(25);
    }
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = CRED_KEY;
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    // The "upstream": accepts only the currently-valid access token.
    const factory = (cfg: ProviderConfig): ProviderAdapter =>
      ({
        protocol: 'anthropic_compatible',
        chat: () =>
          cfg.credential === validToken
            ? Promise.resolve({
                id: 'r',
                model: 'm',
                content: [{ type: 'text', text: 'served' }],
                stopReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1 },
              })
            : Promise.reject(new ProviderError('auth', 'provider auth failed (401)')),
        chatStream: async function* () {
          /* n/a */
        },
        listModels: () => Promise.resolve([]),
        testConnection: () => Promise.resolve({ ok: true, models: 0 }),
      }) as unknown as ProviderAdapter;

    const moduleRef = await Test.createTestingModule({
      imports: [
        SemanticModule,
        DatabaseModule,
        RecordingModule,
        ObservabilityModule,
        ProvidersModule,
        SubscriptionOauthModule,
      ],
      controllers: [ChatCompletionsController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        StreamDrainRegistry,
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
          useValue: { providerDown: () => undefined, onRequestFailed: () => Promise.resolve() },
        },
        {
          provide: BudgetService,
          useValue: { checkBlocked: () => Promise.resolve(null), notifyBlocked: () => undefined },
        },
        { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
        { provide: PROXY_ADAPTER_FACTORY, useValue: factory },
        { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
        { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
        {
          provide: CALIBRATION_RAILS,
          useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()),
        },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
        { provide: APP_GUARD, useClass: TestPrincipalGuard },
      ],
    })
      .overrideProvider(OAUTH_TOKEN_FETCH)
      .useValue(() => {
        exchanges += 1;
        const next = tokenQueue.shift();
        return next ? next() : Promise.reject(new TokenEndpointError('transient'));
      })
      .overrideProvider(OAUTH_PRESET_LOOKUP)
      .useValue({
        find: (id: string) => (id === PRESET.id ? PRESET : undefined),
        list: () => [PRESET],
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    redis = app.get<Redis>(REDIS_CLIENT);

    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'o401', $1, true) RETURNING id`,
        [`o401-${Date.now()}@t.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);
    await port.ensureDefaultTier(principal);
    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl')`,
      [userId, minted.hash, minted.prefix],
    );
    key = minted.key;
  }, 60_000);

  beforeEach(async () => {
    exchanges = 0;
    tokenQueue = [];
    validToken = 'at-new';
    const stale = [
      ...(await redis.keys('oauth:forced:*')),
      ...(await redis.keys('oauth:backoff:*')),
      ...(await redis.keys('oauth:verified:*')),
    ];
    if (stale.length > 0) await redis.del(...stale);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await app.close();
    await pool.end();
  });

  it('a 240h token rejected with 401 heals: the failing request is unchanged, one exchange, the next request is served', async () => {
    const control = await apiKeyProvider(); // a 401 with no refresh trigger at all
    const controlRes = await chat(control.model);
    const p = await oauthProvider('at-old', HOURS_240);
    tokenQueue = [tokenSet('at-new')];
    const failing = await chat(p.model);
    // Identical client-facing outcome to a provider whose 401 triggers nothing.
    expect(failing.status).toBe(controlRes.status);
    expect(failing.body.error?.type).toBe(controlRes.body.error?.type);
    await until(() => exchanges >= 1);
    expect(exchanges).toBe(1);
    await sleep(100); // let the refresh's write commit
    const healed = await chat(p.model);
    expect(healed.status).toBe(200);
    expect(healed.body.choices[0].message.content).toBe('served');
  });

  it('a 401 on the credential the attempt had JUST lazily refreshed is still repaired', async () => {
    // 60s from expiry: the request's own build refreshes (exchange 1 → at-mid), the
    // upstream rejects at-mid, and the forced refresh keyed on at-mid proceeds.
    const p = await oauthProvider('at-old', 60_000);
    tokenQueue = [tokenSet('at-mid'), tokenSet('at-new')];
    const failing = await chat(p.model);
    expect(failing.status).not.toBe(200);
    await until(() => exchanges >= 2);
    expect(exchanges).toBe(2);
    await sleep(100);
    expect((await chat(p.model)).status).toBe(200);
  });

  it('invalid_grant from the forced refresh becomes durable reauthorize_required', async () => {
    const p = await oauthProvider('at-old', HOURS_240);
    tokenQueue = [() => Promise.reject(new TokenEndpointError('invalid_grant'))];
    await chat(p.model);
    await until(async () => {
      const r = await pool.query<{ credential_error: string | null }>(
        'SELECT credential_error FROM provider WHERE id = $1',
        [p.id],
      );
      return r.rows[0]!.credential_error === 'reauthorize_required';
    });
    const row = (
      await pool.query<Record<string, unknown>>(
        'SELECT credential_error, status, last_error_kind, status_source FROM provider WHERE id = $1',
        [p.id],
      )
    ).rows[0]!;
    expect(row).toMatchObject({
      credential_error: 'reauthorize_required',
      status: 'error',
      last_error_kind: 'credential',
      status_source: 'refresh',
    });
  });

  it('a burst of 401s on one credential dials the identity provider at most once', async () => {
    const p = await oauthProvider('at-old', HOURS_240);
    tokenQueue = [
      () => sleep(200).then(tokenSet('at-new')),
      tokenSet('at-extra-1'),
      tokenSet('at-extra-2'),
    ];
    await Promise.all(Array.from({ length: 5 }, () => chat(p.model).then((r) => r)));
    await sleep(500);
    expect(exchanges).toBe(1);
  });

  it('the cooldown is per credential: a 401 on the renewed credential still triggers its own refresh', async () => {
    const p = await oauthProvider('at-old', HOURS_240);
    validToken = 'never'; // every token is rejected — e.g. the account lost access
    tokenQueue = [tokenSet('at-2'), tokenSet('at-3')];
    await chat(p.model);
    await until(() => exchanges >= 1);
    await sleep(100);
    await chat(p.model); // built with at-2 — a NEW credential, so a new claim
    await until(() => exchanges >= 2);
    expect(exchanges).toBe(2);
  });

  it('a 401 from an api_key provider never dials the identity provider', async () => {
    const control = await apiKeyProvider();
    await chat(control.model);
    await sleep(200);
    expect(exchanges).toBe(0);
  });
});
