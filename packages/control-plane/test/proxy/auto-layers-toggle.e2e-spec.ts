// Per-tenant auto-layer toggle e2e (#20) — real Postgres + Redis + a local stub
// upstream. Proves the SAME running instance honors a per-tenant `PUT
// /api/routing/auto-layers` on the very next `model=auto` request, WITHOUT a
// restart (spec §15 DoD), and that one tenant's preference never affects
// another's. The toggle plane (session/principal) and the proxy plane
// (agent-key) share one app; each assertion phase uses a DISTINCT system prompt
// so the structural per-agent EWMA baseline can't confound the off/on verdict.
import {
  Injectable,
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
  userPrincipal,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  createProviderAdapter,
} from '@polyrouter/data-plane';
import { startStubUpstream } from './stub-upstream';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Redis } from 'ioredis';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
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
import { AutoLayersController } from '../../src/routing-config/auto-layers.controller';
import { AutoLayersService } from '../../src/routing-config/auto-layers.service';
import { SemanticModule } from '../../src/semantic/semantic.module';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { BudgetService } from '../../src/budgets/budget-service';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralBaselineStore } from '../../src/proxy/structural/structural-baseline.store';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { RecordingModule } from '../../src/recording/recording.module';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { LogWriter } from '../../src/recording/log-writer';
import { PricingModule } from '../../src/pricing/pricing.module';
import { DatabaseModule } from '../../src/database/database.module';
import { RedisModule } from '../../src/redis/redis.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

const HMAC = 'a'.repeat(64);

/** A structurally HIGH `auto` turn → the auto_high band (a confident Layer-1
 * route, not cascade). Distinct `system` keeps the baseline bucket fresh. */
function highBody(system: string): Record<string, unknown> {
  return {
    model: 'auto',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'Z'.repeat(9_000) + '\n```\n' + 'x'.repeat(5_000) + '\n```' },
    ],
    tools: Array.from({ length: 8 }, (_, i) => ({
      type: 'function',
      function: {
        name: `f${i}`,
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    })),
  };
}

/** An AMBIGUOUS `auto` turn (size + one tool schema lands between the low/high
 * thresholds) → the cascade path when cascade is on, else the Layer-0 default. */
function ambiguousBody(system: string): Record<string, unknown> {
  return {
    model: 'auto',
    messages: [
      { role: 'system', content: system },
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
  };
}

/** Global guard: resolves the session principal from `x-test-user` (the toggle
 * plane) but always allows — the proxy controller is guarded controller-scoped
 * by `AgentApiKeyGuard`, which sets its own principal from the Bearer key. */
@Injectable()
class PermissivePrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) req.principal = userPrincipal(u);
    return true;
  }
}

async function buildApp(): Promise<{ app: INestApplication; server: App }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule,
      PricingModule,
      RecordingModule,
      RedisModule,
      ObservabilityModule,
      // add-semantic-embedder: AutoLayersService reads the semantic capability.
      SemanticModule,
    ],
    controllers: [ChatCompletionsController, AutoLayersController],
    providers: [
      AgentApiKeyGuard,
      ProxyService,
      {
        // add-subscription-oauth: ProxyService's credential seam — these suites mint
        // no OAuth envelopes, so a call here is a wiring bug worth failing loudly.
        provide: SubscriptionOauthService,
        useValue: {
          resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')),
        },
      },
      AutoLayersService,
      StreamDrainRegistry,
      StructuralRouter,
      CascadeRouter,
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
      {
        provide: StructuralBaselineStore,
        inject: [REDIS_CLIENT],
        useFactory: (redis: Redis): StructuralBaselineStore =>
          new StructuralBaselineStore(redis, HMAC),
      },
      { provide: APP_FILTER, useClass: ProxyExceptionFilter },
      { provide: APP_GUARD, useClass: PermissivePrincipalGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.init();
  return { app, server: app.getHttpServer() };
}

interface Tenant {
  userId: string;
  principal: Principal;
  key: string;
  model: { default: string; strong: string; cheap: string };
}

describe('per-tenant auto-layer toggle e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let writer: LogWriter;
  let stub: import('./stub-upstream').StubUpstream;
  let A: Tenant;
  let B: Tenant;

  async function seedTenant(label: string): Promise<Tenant> {
    const userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
        [label, `${label}-${Date.now()}@toggle.test`],
      )
    ).rows[0]!.id;
    const principal = userPrincipal(userId);
    const provider = await port.providers.insert(principal, {
      name: 'stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    const mk = async (ext: string): Promise<string> =>
      (await port.models.createForProvider(principal, provider.id, { externalModelId: ext }))!.id;
    const model = {
      default: await mk('gpt-4o'),
      strong: await mk('gpt-4o-hi'),
      cheap: await mk('gpt-4o-mini'),
    };
    await port.ensureDefaultTier(principal);
    const def = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, def.id, [model.default]);
    const premium = await port.tiers.insert(principal, { key: 'premium' });
    await port.routingEntries.replaceForTier(principal, premium.id, [model.strong]);
    const cheap = await port.tiers.insert(principal, { key: 'cheap' });
    await port.routingEntries.replaceForTier(principal, cheap.id, [model.cheap]);
    await port.routingRules.insert(principal, {
      matchType: 'auto_high',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:premium',
      priority: 0,
    });
    await port.routingRules.insert(principal, {
      matchType: 'auto_low',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:cheap',
      priority: 0,
    });
    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl')`,
      [userId, minted.hash, minted.prefix],
    );
    return { userId, principal, key: minted.key, model };
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    // Both layers available instance-wide (cascade implies structural), so the
    // per-tenant preference is the only thing gating them.
    process.env['ROUTING_AUTO_LAYERS'] = 'cascade';
    stub = await startStubUpstream();

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    ({ app, server } = await buildApp());
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    writer = app.get(LogWriter);
    A = await seedTenant('togA');
    B = await seedTenant('togB');
  }, 60_000);

  afterAll(async () => {
    if (A?.userId || B?.userId) {
      await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[A?.userId, B?.userId]]);
    }
    await app.close();
    await pool.end();
    await stub.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM request_log WHERE owner_user_id = ANY($1)', [
      [A.userId, B.userId],
    ]);
  });

  async function proxy(t: Tenant, b: Record<string, unknown>): Promise<void> {
    const res = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${t.key}`)
      .send(b);
    expect(res.status).toBe(200);
    await writer.flush();
  }

  function putLayers(t: Tenant, dto: { structural: boolean; cascade: boolean }): request.Test {
    return request(server).put('/api/routing/auto-layers').set('x-test-user', t.userId).send(dto);
  }

  async function lastLog(t: Tenant): Promise<{ modelId: string | null; decisionLayer: string }> {
    const logs = await port.requestLogs.list(t.principal);
    return logs[logs.length - 1]!;
  }

  it('with the default (inherit-on) preference, a structural request routes to the band', async () => {
    await proxy(A, highBody('toggle-p1'));
    const row = await lastLog(A);
    expect(row.decisionLayer).toBe('structural');
    expect(row.modelId).toBe(A.model.strong);
  });

  it('a PUT that disables structural takes effect on the SAME running app (no restart)', async () => {
    const put = await putLayers(A, { structural: false, cascade: false });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ structural: false, cascade: false });

    await proxy(A, highBody('toggle-p2'));
    const row = await lastLog(A);
    expect(row.decisionLayer).toBe('default'); // structural off → Layer-0 default
    expect(row.modelId).toBe(A.model.default);
  });

  it('re-enabling structural restores band routing on the next request', async () => {
    expect((await putLayers(A, { structural: true, cascade: false })).status).toBe(200);
    await proxy(A, highBody('toggle-p3'));
    const row = await lastLog(A);
    expect(row.decisionLayer).toBe('structural');
    expect(row.modelId).toBe(A.model.strong);
  });

  it('cascade on routes an ambiguous request through the cascade', async () => {
    // structural + cascade on → the ambiguous band enters the cascade.
    expect((await putLayers(A, { structural: true, cascade: true })).status).toBe(200);
    await proxy(A, ambiguousBody('toggle-p4'));
    expect((await lastLog(A)).decisionLayer).toBe('cascade');
  });

  it('cascade off leaves the same ambiguous request on the default tier', async () => {
    // structural on, cascade off → the ambiguity falls through to Layer 0.
    expect((await putLayers(A, { structural: true, cascade: false })).status).toBe(200);
    await proxy(A, ambiguousBody('toggle-p5'));
    const row = await lastLog(A);
    expect(row.decisionLayer).toBe('default');
    expect(row.modelId).toBe(A.model.default);
  });

  it("one tenant's preference does not affect another's (isolation)", async () => {
    // A off; B never set a preference (inherit-on).
    expect((await putLayers(A, { structural: false, cascade: false })).status).toBe(200);
    await proxy(A, highBody('toggle-iso-A'));
    await proxy(B, highBody('toggle-iso-B'));
    expect((await lastLog(A)).decisionLayer).toBe('default'); // A's opt-out
    const bRow = await lastLog(B);
    expect(bRow.decisionLayer).toBe('structural'); // B unaffected
    expect(bRow.modelId).toBe(B.model.strong);
  });

  it('degrades to the capability default when the settings read rejects (invariant 1)', async () => {
    // Even though A is opted OUT, a faulting read must not fail the request — it
    // falls back to the raw instance capability (structural on).
    expect((await putLayers(A, { structural: false, cascade: false })).status).toBe(200);
    const original = port.routingSettings.get.bind(port.routingSettings);
    port.routingSettings.get = () => Promise.reject(new Error('settings read down'));
    try {
      await proxy(A, highBody('toggle-degrade-reject'));
      const row = await lastLog(A);
      expect(row.decisionLayer).toBe('structural'); // capability default, not the opt-out
      expect(row.modelId).toBe(A.model.strong);
    } finally {
      port.routingSettings.get = original;
    }
  });

  it('degrades WITHOUT stalling when the settings read never settles (invariant 1)', async () => {
    expect((await putLayers(A, { structural: false, cascade: false })).status).toBe(200);
    const original = port.routingSettings.get.bind(port.routingSettings);
    // A read that never resolves — the deadline-bounded proxy must still serve.
    port.routingSettings.get = () => new Promise<never>(() => {});
    try {
      const started = Date.now();
      await proxy(A, highBody('toggle-degrade-hang'));
      expect(Date.now() - started).toBeLessThan(5_000); // not stalled on the hung read
      expect((await lastLog(A)).decisionLayer).toBe('structural'); // capability default
    } finally {
      port.routingSettings.get = original;
    }
  });
});
