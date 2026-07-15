// Request-logging e2e (real Postgres + a local stub upstream). Boots the proxy
// with the recording + pricing modules so a real request produces an immutable
// RequestLog, and drives the recorder directly for the catalog-price immutability
// DoD (a loopback stub is a `local`/free provider, so a catalog-priced case uses
// a known host in the recording context — no network, deriveModelKey is pure).
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
import { createProviderAdapter } from '@polyrouter/data-plane';
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
  PROXY_RUNTIME,
  loadProxyRuntime,
} from '../../src/proxy/proxy.config';
import { ProxyService } from '../../src/proxy/proxy.service';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { RecordingModule } from '../../src/recording/recording.module';
import { RequestRecorder, type RecordingContext } from '../../src/recording/request-recorder';
import { LogWriter } from '../../src/recording/log-writer';
import { PricingModule } from '../../src/pricing/pricing.module';
import { PricingService } from '../../src/pricing/pricing.service';
import { DatabaseModule } from '../../src/database/database.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';

const HMAC = 'a'.repeat(64);

describe('request-logging e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let recorder: RequestRecorder;
  let writer: LogWriter;
  let pricing: PricingService;
  let stub: import('../proxy/stub-upstream').StubUpstream;
  let userId: string;
  let principal: Principal;
  let key: string;
  let gpt4oModelId: string;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
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
      imports: [DatabaseModule, PricingModule, RecordingModule],
      controllers: [ChatCompletionsController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        StreamDrainRegistry,
        { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
        { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init(); // migrations + pricing seed-on-boot
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    recorder = app.get(RequestRecorder);
    writer = app.get(LogWriter);
    pricing = app.get(PricingService);

    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'log', $1, true) RETURNING id`,
        [`log-${Date.now()}@rl.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);
    const provider = await port.providers.insert(principal, {
      name: 'stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    const model = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'gpt-4o',
    });
    gpt4oModelId = model!.id;
    await port.ensureDefaultTier(principal);
    const tier = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, tier.id, [gpt4oModelId]);
    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl')`,
      [userId, minted.hash, minted.prefix],
    );
    key = minted.key;
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  it('a routed request writes exactly one metadata RequestLog (no body)', async () => {
    const before = (await port.requestLogs.list(principal)).length;
    const res = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    await writer.flush();

    const logs = await port.requestLogs.list(principal);
    expect(logs.length).toBe(before + 1);
    const row = logs[0]!;
    expect(row).toMatchObject({
      status: 'success',
      decisionLayer: 'explicit',
      modelId: gpt4oModelId,
    });
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(row)).not.toContain('hi'); // no prompt/response body
  });

  it('cost is immutable: a later catalog price change does not move a recorded cost', async () => {
    // Record via the pipeline with a KNOWN-host provider so the bundled catalog
    // price (openai:gpt-4o) resolves — deriveModelKey is pure (no network).
    const ctx: RecordingContext = {
      principal,
      agentId: null,
      decision: {
        providerId: 'p-known',
        modelId: gpt4oModelId,
        externalModelId: 'gpt-4o',
        tierKey: null,
        decisionLayer: 'explicit',
        routingReason: 'explicit model',
      },
      provider: { baseUrl: 'https://api.openai.com/v1', kind: 'api_key' },
      model: {
        externalModelId: 'gpt-4o',
        inputPricePer1m: null,
        outputPricePer1m: null,
        isFree: false,
      },
      startedAt: Date.now(),
      requestChars: 0,
    };
    recorder.record(ctx, {
      status: 'success',
      providerUsage: { inputTokens: 1_000_000, outputTokens: 0 },
      outputChars: 0,
    });
    await writer.flush();

    const priced = (await port.requestLogs.list(principal)).find(
      (r) => r.decisionLayer === 'explicit' && r.tierAssigned === null && r.cost !== null,
    );
    expect(priced).toBeDefined();
    const recordedCost = priced!.cost;
    const recordedSnapshot = priced!.inputPriceSnapshot;
    expect(recordedCost).toBeGreaterThan(0); // 1M input tokens × the bundled gpt-4o rate

    // Change the catalog price for the model, then re-read the SAME row.
    await pricing.override(
      'openai:gpt-4o',
      { inputPricePer1m: 999, outputPricePer1m: 999 },
      new Date(),
    );
    const again = await port.requestLogs.findById(principal, priced!.id);
    expect(again!.cost).toBe(recordedCost); // unchanged
    expect(again!.inputPriceSnapshot).toBe(recordedSnapshot);
  });

  it('a log-write failure never fails the request or throws', async () => {
    const spy = jest
      .spyOn(port.requestLogs, 'insertMany')
      .mockRejectedValue(new Error('db unavailable'));
    try {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'gpt-4o', messages: [] });
      expect(res.status).toBe(200); // request unaffected
      await expect(writer.flush()).resolves.toBeUndefined(); // writer isolates the failure
    } finally {
      spy.mockRestore();
    }
  });

  it('tenant isolation: another tenant cannot read these logs', async () => {
    const otherId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'o', $1, true) RETURNING id`,
        [`other-${Date.now()}@rl.test`],
      )
    ).rows[0]!.id;
    try {
      expect(await port.requestLogs.list(userPrincipal(otherId))).toHaveLength(0);
    } finally {
      await pool.query('DELETE FROM "user" WHERE id = $1', [otherId]);
    }
  });
});
