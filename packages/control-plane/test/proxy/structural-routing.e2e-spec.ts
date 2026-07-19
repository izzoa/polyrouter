// Structural (Layer 1) routing e2e — real Postgres + Redis + a local stub
// upstream. Drives `model=auto` through the full proxy so a real request is
// steered to a configured band tier, records `decision_layer='structural'`,
// de-contaminates the system prompt, learns a per-agent baseline, and degrades
// to Layer 0 when disabled — all with metadata-only recording.
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
import { startStubUpstream } from './stub-upstream';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Redis } from 'ioredis';
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

/** A large user turn (+ optional code + tools) that scores structurally high. */
function body(opts: {
  system?: string;
  userChars?: number;
  code?: boolean;
  tools?: number;
  header?: string;
}): Record<string, unknown> {
  const user =
    'Z'.repeat(opts.userChars ?? 4) + (opts.code ? '\n```\n' + 'x'.repeat(5_000) + '\n```' : '');
  const b: Record<string, unknown> = {
    model: 'auto',
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: user },
    ],
  };
  if (opts.tools) {
    b['tools'] = Array.from({ length: opts.tools }, (_, i) => ({
      type: 'function',
      function: {
        name: `f${i}`,
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    }));
  }
  return b;
}

async function buildApp(): Promise<{ app: INestApplication; server: App }> {
  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule, PricingModule, RecordingModule, RedisModule, ObservabilityModule],
    controllers: [ChatCompletionsController],
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
      }, // #16 budgets: allow-all (enforcement asserted in the budgets e2e)
      { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
      { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
      { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
      { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
      {
        provide: StructuralBaselineStore,
        inject: [REDIS_CLIENT],
        useFactory: (redis: Redis): StructuralBaselineStore =>
          new StructuralBaselineStore(redis, HMAC),
      },
      { provide: APP_FILTER, useClass: ProxyExceptionFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.init();
  return { app, server: app.getHttpServer() };
}

describe('structural routing e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let writer: LogWriter;
  let stub: import('./stub-upstream').StubUpstream;
  let userId: string;
  let principal: Principal;
  let key: string;
  let idDefault: string;
  let idPremium: string;
  let idCheap: string;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    process.env['ROUTING_AUTO_LAYERS'] = 'structural';
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
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 's', $1, true) RETURNING id`,
        [`struct-${Date.now()}@sr.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);

    const provider = await port.providers.insert(principal, {
      name: 'stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    idDefault = (await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'gpt-4o',
    }))!.id;
    idPremium = (await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'gpt-4o-hi',
    }))!.id;
    idCheap = (await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'gpt-4o-mini',
    }))!.id;

    await port.ensureDefaultTier(principal);
    const def = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, def.id, [idDefault]);
    const prem = await port.tiers.insert(principal, { key: 'premium' });
    await port.routingEntries.replaceForTier(principal, prem.id, [idPremium]);
    const cheap = await port.tiers.insert(principal, { key: 'cheap' });
    await port.routingEntries.replaceForTier(principal, cheap.id, [idCheap]);
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
    key = minted.key;
  }, 60_000);

  afterAll(async () => {
    if (userId) await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userId]);
  });

  async function send(b: Record<string, unknown>, header?: string): Promise<void> {
    const r = request(server).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`);
    if (header) r.set('x-polyrouter-tier', header);
    const res = await r.send(b);
    expect(res.status).toBe(200);
    await writer.flush();
  }
  async function lastLog(): Promise<{
    modelId: string | null;
    decisionLayer: string;
    routingReason: string;
  }> {
    const logs = await port.requestLogs.list(principal);
    return logs[logs.length - 1]!;
  }

  it('steers a complex auto request to the auto_high tier (decision_layer=structural)', async () => {
    await send(body({ system: 'sysA', userChars: 9_000, code: true, tools: 8 }));
    const row = await lastLog();
    expect(row.modelId).toBe(idPremium);
    expect(row.decisionLayer).toBe('structural');
    expect(row.routingReason).toContain('structural:high');
    expect(JSON.stringify(row)).not.toContain('Z'.repeat(50)); // metadata only — no prompt body
  });

  it('steers a trivial auto request to the auto_low tier', async () => {
    await send(body({ system: 'sysB', userChars: 3 }));
    const row = await lastLog();
    expect(row.modelId).toBe(idCheap);
    expect(row.decisionLayer).toBe('structural');
  });

  it('does not force a huge identical system prompt into the top tier (de-contamination)', async () => {
    await send(body({ system: 'X'.repeat(50_000), userChars: 3 }));
    const row = await lastLog();
    expect(row.modelId).not.toBe(idPremium); // the huge system is excluded from scoring
  });

  it('learns a per-agent baseline: a steady request de-escalates, an above-baseline one escalates', async () => {
    const clear = (): Promise<unknown> =>
      pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userId]);
    // Warm the baseline for this agent+system with a moderate boilerplate turn.
    await send(body({ system: 'sysC', userChars: 8_000 }));
    await clear();
    // The same-shaped request now measures ~zero size delta → not high.
    await send(body({ system: 'sysC', userChars: 8_000 }));
    expect((await lastLog()).modelId).not.toBe(idPremium);
    await clear();
    // A much larger turn with code + tools is well above baseline → escalates.
    await send(body({ system: 'sysC', userChars: 16_000, code: true, tools: 8 }));
    expect((await lastLog()).modelId).toBe(idPremium);
  });

  it('an x-polyrouter-tier header on an auto request still forces that tier (Layer 0 wins)', async () => {
    await send(body({ system: 'sysD', userChars: 9_000, code: true, tools: 8 }), 'cheap');
    const row = await lastLog();
    expect(row.modelId).toBe(idCheap); // header tier beat the structural high band
    expect(row.decisionLayer).toBe('header');
  });

  it('degrades to Layer 0 default when the structural layer is disabled', async () => {
    process.env['ROUTING_AUTO_LAYERS'] = '';
    const disabled = await buildApp();
    try {
      const res = await request(disabled.server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send(body({ system: 'sysE', userChars: 9_000, code: true, tools: 8 }));
      expect(res.status).toBe(200);
      await disabled.app.get(LogWriter).flush();
      const row = await lastLog();
      expect(row.modelId).toBe(idDefault); // structural off → default tier
      expect(row.decisionLayer).toBe('default');
    } finally {
      await disabled.app.close();
      process.env['ROUTING_AUTO_LAYERS'] = 'structural';
    }
  });
});
