// /metrics e2e (#21, real Postgres + a local stub upstream). Drives a success,
// a cross-provider fallback, a streamed request, and a breaker trip through the
// slim proxy, flushes the writer, and asserts the Prometheus scrape: request/
// token/cost counters with bounded provider/model/layer labels, per-provider
// error attribution, duration histograms, breaker state + opens, and the
// METRICS_ENABLED=false kill-switch (404).
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
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
import { startStubUpstream } from '../proxy/stub-upstream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
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
import { ProxyService } from '../../src/proxy/proxy.service';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { BudgetService } from '../../src/budgets/budget-service';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { RecordingModule } from '../../src/recording/recording.module';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { LogWriter } from '../../src/recording/log-writer';
import { PricingModule } from '../../src/pricing/pricing.module';
import { DatabaseModule } from '../../src/database/database.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';

const HMAC = 'a'.repeat(64);

async function buildApp(): Promise<{ app: INestApplication; server: App }> {
  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule, PricingModule, RecordingModule, ObservabilityModule],
    controllers: [ChatCompletionsController],
    providers: [
      AgentApiKeyGuard,
      ProxyService,
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
      { provide: APP_FILTER, useClass: ProxyExceptionFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.init();
  return { app, server: app.getHttpServer() };
}

describe('/metrics e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let writer: LogWriter;
  let stub: import('../proxy/stub-upstream').StubUpstream;
  let userId: string;
  let principal: Principal;
  let key: string;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    delete process.env['METRICS_ENABLED']; // default on
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

    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'mx', $1, true) RETURNING id`,
        [`metrics-${Date.now()}@obs.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);

    // Distinct provider names so per-provider attribution is assertable:
    // `solid` serves; `flaky` always 500s; `tripper` exists only to trip its breaker.
    const solid = await port.providers.insert(principal, {
      name: 'solid',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    const flaky = await port.providers.insert(principal, {
      name: 'flaky',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    const tripper = await port.providers.insert(principal, {
      name: 'tripper',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    // Model-own prices beat the local-free rule → a real snapshot cost.
    const gpt = (await port.models.createForProvider(principal, solid.id, {
      externalModelId: 'gpt-4o',
      inputPricePer1m: 2.5,
      outputPricePer1m: 10,
    }))!;
    const srvfail = (await port.models.createForProvider(principal, flaky.id, {
      externalModelId: 'oai-srvfail',
    }))!;
    const tripfail = (await port.models.createForProvider(principal, tripper.id, {
      externalModelId: 'oai-srvfail',
    }))!;

    await port.ensureDefaultTier(principal);
    const def = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, def.id, [gpt.id]);
    const fb = await port.tiers.insert(principal, { key: 'fallback' });
    await port.routingEntries.replaceForTier(principal, fb.id, [srvfail.id, gpt.id]);
    const down = await port.tiers.insert(principal, { key: 'down' });
    await port.routingEntries.replaceForTier(principal, down.id, [tripfail.id]);

    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl')`,
      [userId, minted.hash, minted.prefix],
    );
    key = minted.key;
  }, 60_000);

  afterAll(async () => {
    if (userId) await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  function send(body: Record<string, unknown>, tier?: string): request.Test {
    const r = request(server).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`);
    if (tier) r.set('x-polyrouter-tier', tier);
    return r.send(body);
  }
  const chat = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello metrics' }],
    ...over,
  });

  it('scrapes request/token/cost counters and histograms after traffic', async () => {
    expect((await send(chat())).status).toBe(200); // explicit → solid/gpt-4o
    const res = await send(chat({ model: 'auto' }), 'fallback'); // flaky fails → solid serves
    expect(res.status).toBe(200);
    const streamed = await send(chat({ stream: true }));
    expect(streamed.status).toBe(200);
    expect(streamed.text).toContain('[DONE]');
    await new Promise((r) => setTimeout(r, 40)); // stream settle microtask
    await writer.flush(); // cost is emitted post-insert

    const scrape = await request(server).get('/metrics');
    expect(scrape.status).toBe(200);
    expect(scrape.headers['content-type']).toContain('text/plain');
    const text = scrape.text;

    // requests_total with protocol/layer/status; histograms present.
    expect(text).toMatch(
      /polyrouter_requests_total\{protocol="openai",decision_layer="explicit",status="success"\} \d+/,
    );
    expect(text).toMatch(
      /polyrouter_requests_total\{protocol="openai",decision_layer="header",status="fallback"\} 1/,
    );
    expect(text).toContain('polyrouter_request_duration_seconds_bucket');
    expect(text).toContain('polyrouter_upstream_duration_seconds_bucket');

    // Per-provider attribution: the failed member and the serving member.
    expect(text).toMatch(
      /polyrouter_upstream_requests_total\{provider="flaky",model="oai-srvfail",outcome="error"\} 1/,
    );
    expect(text).toMatch(
      /polyrouter_upstream_requests_total\{provider="solid",model="gpt-4o",outcome="success"\} \d+/,
    );

    // Tokens + snapshot cost, labeled by the SERVING provider/model.
    expect(text).toMatch(
      /polyrouter_tokens_total\{provider="solid",model="gpt-4o",direction="input"\} \d+/,
    );
    expect(text).toMatch(
      /polyrouter_tokens_total\{provider="solid",model="gpt-4o",direction="output"\} \d+/,
    );
    expect(text).toMatch(/polyrouter_cost_microusd_total\{provider="solid",model="gpt-4o"\} \d+/);

    // No tenant/agent identifiers in any label.
    expect(text).not.toContain(userId);
  });

  it('exposes breaker opens + last-observed state after a trip', async () => {
    // DEFAULT threshold is 5 consecutive failures → open on the 5th; the 6th
    // admission observes the open state (short-circuit).
    for (let i = 0; i < 6; i += 1) {
      const res = await send(chat({ model: 'auto' }), 'down');
      expect(res.status).toBeGreaterThanOrEqual(500);
    }
    const text = (await request(server).get('/metrics')).text;
    expect(text).toMatch(/polyrouter_breaker_opens_total\{provider="tripper"\} 1/);
    expect(text).toMatch(/polyrouter_breaker_state\{provider="tripper"\} 2/);
  });

  it('hides the endpoint entirely when METRICS_ENABLED=false', async () => {
    process.env['METRICS_ENABLED'] = 'false';
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [ObservabilityModule],
      }).compile();
      const off = moduleRef.createNestApplication<NestExpressApplication>();
      configureApp(off as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
      await off.init();
      expect((await request(off.getHttpServer()).get('/metrics')).status).toBe(404);
      await off.close();
    } finally {
      delete process.env['METRICS_ENABLED'];
    }
  });
});
