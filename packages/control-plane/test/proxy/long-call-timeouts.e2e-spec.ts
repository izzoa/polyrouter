// fix-long-call-timeouts e2e: a per-provider patience override beats the
// instance bound on BOTH paths (small numbers: instance 200ms first-byte,
// override 2s, stub pre-headers delay 1s), the timeout-defaults read, and the
// override CRUD semantics (set → preserved-on-omit → null-clears → 4xx).
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
import { startStubUpstream } from './stub-upstream';
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
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { RecordingModule } from '../../src/recording/recording.module';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { DatabaseModule } from '../../src/database/database.module';
import { SemanticModule } from '../../src/semantic/semantic.module';
import { ProvidersModule } from '../../src/providers/providers.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

const HMAC = 'a'.repeat(64);

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

describe('long-call timeouts e2e (fix-long-call-timeouts)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let stub: import('./stub-upstream').StubUpstream;
  let userId: string;
  let principal: Principal;
  let key: string;
  let patientProviderId: string;

  const chat = (body: object) =>
    request(server).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send(body);
  const api = () => ({
    get: (p: string) => request(server).get(p).set('x-test-user', userId),
    patch: (p: string, b: object) => request(server).patch(p).set('x-test-user', userId).send(b),
  });

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    // Instance bound 200ms — the stub's 1s pre-headers delay MUST trip it.
    process.env['PROXY_FIRST_EVENT_TIMEOUT_MS'] = '200';
    stub = await startStubUpstream();

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [SemanticModule, DatabaseModule, RecordingModule, ObservabilityModule, ProvidersModule],
      controllers: [ChatCompletionsController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        {
          provide: SubscriptionOauthService,
          useValue: {
            resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')),
          },
        },
        StreamDrainRegistry,
        {
          provide: StructuralRouter,
          useValue: { enabled: false, evaluate: () => Promise.resolve({ kind: 'skip' }) },
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
        { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
        { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
        { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
        { provide: CALIBRATION_RAILS, useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()) },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
        { provide: APP_GUARD, useClass: TestPrincipalGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);

    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'lt', $1, true) RETURNING id`,
        [`lt-${Date.now()}@t.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);
    // Two providers on the same stub: one inherits the 200ms instance bound,
    // one carries a 2s override — both serve a 1s-delayed-headers model.
    const impatient = await port.providers.insert(principal, {
      name: 'impatient',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    const patient = await port.providers.insert(principal, {
      name: 'patient',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
      firstByteTimeoutMs: 2_000,
    });
    patientProviderId = patient.id;
    await port.models.createForProvider(principal, impatient.id, {
      externalModelId: 'oai-slowhead-a',
    });
    await port.models.createForProvider(principal, patient.id, {
      externalModelId: 'oai-slowhead-b',
    });
    await port.ensureDefaultTier(principal);
    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl')`,
      [userId, minted.hash, minted.prefix],
    );
    key = minted.key;
  }, 60_000);

  afterAll(async () => {
    delete process.env['PROXY_FIRST_EVENT_TIMEOUT_MS']; // never leak into later suites
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  it('the instance bound trips a slow-headers call with a TYPED failure (buffered)', async () => {
    const res = await chat({ model: 'oai-slowhead-a', messages: [] });
    expect(res.status).toBeGreaterThanOrEqual(500); // typed unavailable, protocol-shaped
    expect(res.body.error).toBeDefined(); // never an untyped socket teardown
  });

  it('the provider override outlasts the same delay — buffered AND streaming', async () => {
    const buffered = await chat({ model: 'oai-slowhead-b', messages: [] });
    expect(buffered.status).toBe(200);
    expect(buffered.body.choices[0].message.content).toContain('Hello from stub');
    // Streaming pins clink r1-High-1: the per-attempt core bound (override +
    // margin) must reach the stream watchdog — the chain-wide 700ms would trip.
    const streamed = await chat({ model: 'oai-slowhead-b', stream: true, messages: [] });
    expect(streamed.status).toBe(200);
    expect(streamed.text).toContain('data: [DONE]');
    expect(streamed.text).not.toContain('"upstream_error"');
  });

  it('timeout-defaults returns the RAISED effective instance values, non-secret', async () => {
    const res = await api().get('/api/providers/timeout-defaults');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ firstByteTimeoutMs: 200, idleTimeoutMs: 30_000 });
  });

  it('override CRUD: set → preserved-on-omit → null-clears → out-of-range 4xx', async () => {
    const set = await api().patch(`/api/providers/${patientProviderId}`, {
      idleTimeoutMs: 45_000,
    });
    expect(set.status).toBe(200);
    expect(set.body.idleTimeoutMs).toBe(45_000);
    expect(set.body.firstByteTimeoutMs).toBe(2_000); // omitted → preserved
    const cleared = await api().patch(`/api/providers/${patientProviderId}`, {
      idleTimeoutMs: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.idleTimeoutMs).toBeNull(); // explicit null → inherit
    expect(cleared.body.firstByteTimeoutMs).toBe(2_000);
    const tooBig = await api().patch(`/api/providers/${patientProviderId}`, {
      firstByteTimeoutMs: 3_600_001,
    });
    expect(tooBig.status).toBe(400);
    const tooSmall = await api().patch(`/api/providers/${patientProviderId}`, {
      firstByteTimeoutMs: 999,
    });
    expect(tooSmall.status).toBe(400);
    // The stored override survived the rejected writes.
    const after = await api().get(`/api/providers/${patientProviderId}`);
    expect(after.body.firstByteTimeoutMs).toBe(2_000);
  });
});
