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
import { RequestRecorder, type RecordingContext } from '../../src/recording/request-recorder';
import { LogWriter } from '../../src/recording/log-writer';
import { PricingModule } from '../../src/pricing/pricing.module';
import { PricingService } from '../../src/pricing/pricing.service';
import { DatabaseModule } from '../../src/database/database.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

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
    stub = await startStubUpstream();

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, PricingModule, RecordingModule, ObservabilityModule],
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
        {
          provide: StructuralRouter,
          useValue: { enabled: false, evaluate: () => Promise.resolve({ kind: 'skip' }) },
        }, // #13 off here
        { provide: CascadeRouter, useValue: { enabled: false, plan: () => null } }, // #14 off here
        {
          provide: NotificationProducers,
          useValue: { providerDown: () => undefined, onRequestFailed: () => Promise.resolve() },
        },
        {
          provide: BudgetService,
          useValue: { checkBlocked: () => Promise.resolve(null), notifyBlocked: () => undefined },
        }, // #16 budgets: allow-all (enforcement asserted in the budgets e2e) // #15b notifications not asserted here
        { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
        { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
        { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
        { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
      { provide: CALIBRATION_RAILS, useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()) },
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
    const srvfail = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-srvfail',
    });
    // add-request-error-detail: a 400-mode and a mid-stream-error-mode model.
    await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-badreq',
    });
    await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-miderror',
    });
    await port.ensureDefaultTier(principal);
    const tier = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, tier.id, [gpt4oModelId]);
    const fb = await port.tiers.insert(principal, { key: 'fallback' });
    await port.routingEntries.replaceForTier(principal, fb.id, [srvfail!.id, gpt4oModelId]);
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

  it('records status=fallback against the SERVED model with a failure trail (#12)', async () => {
    const res = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send({ model: 'fallback', messages: [] }); // primary 500s → gpt-4o serves
    expect(res.status).toBe(200);
    await writer.flush();
    const row = (await port.requestLogs.list(principal)).find((r) => r.status === 'fallback');
    expect(row).toBeDefined();
    expect(row!.modelId).toBe(gpt4oModelId); // the served member, not the failed primary
    expect(row!.routingReason).toContain('fell back'); // sanitized trail
    // add-request-error-detail decision 2: a SERVED request carries no error detail —
    // its bumps stay summarized by the trail alone.
    expect(row!.errorKind).toBeNull();
    expect(row!.errorStatus).toBeNull();
    expect(row!.errorMessage).toBeNull();
    expect(row!.errorRequestId).toBeNull();
  });

  describe('matched routing header (add-routing-header-visibility)', () => {
    it('a built-in-header request records the header name + the matched tier key', async () => {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .set('x-polyrouter-tier', 'default')
        .send({ model: 'auto', messages: [] });
      expect(res.status).toBe(200);
      await writer.flush();
      const row = (await port.requestLogs.list(principal))[0]!;
      expect(row).toMatchObject({
        decisionLayer: 'header',
        routingHeaderName: 'x-polyrouter-tier',
        routingHeaderValue: 'default',
        tierAssigned: 'default',
      });
    });

    it('a custom-rule request records the header NAME only — the configured value lands in no column', async () => {
      // A credential-bearing header (cookie won't collide with the agent-key
      // auth headers) with a secret-shaped configured value.
      const secret = 'session=sk-live-EXTREMELY-SECRET-token';
      await port.routingRules.insert(principal, {
        matchType: 'header',
        headerName: 'cookie',
        headerValue: secret,
        target: 'tier:default',
        priority: 0,
      });
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .set('cookie', secret)
        .send({ model: 'auto', messages: [] });
      expect(res.status).toBe(200);
      await writer.flush();
      const row = (await port.requestLogs.list(principal))[0]!;
      expect(row).toMatchObject({
        decisionLayer: 'header',
        routingHeaderName: 'cookie',
        routingHeaderValue: null,
      });
      // Fail-closed (invariant 8 / never log secrets): the configured value is
      // in NO column of the recorded row.
      expect(JSON.stringify(row)).not.toContain('EXTREMELY-SECRET');
    });

    it('an explicit x-polyrouter-tier beats a higher-priority rule on another header (add-tier-header-precedence)', async () => {
      // High-priority rule on a different header targeting the fallback tier
      // (whose primary 500s) — if it won, the row would show tier 'fallback'.
      await port.routingRules.insert(principal, {
        matchType: 'header',
        headerName: 'x-env',
        headerValue: 'prod',
        target: 'tier:fallback',
        priority: 100,
      });
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .set('x-env', 'prod')
        .set('x-polyrouter-tier', 'default')
        .send({ model: 'auto', messages: [] });
      expect(res.status).toBe(200);
      await writer.flush();
      const row = (await port.requestLogs.list(principal))[0]!;
      expect(row).toMatchObject({
        status: 'success',
        decisionLayer: 'header',
        tierAssigned: 'default', // the tier header won, not the x-env rule
        routingHeaderName: 'x-polyrouter-tier',
        routingHeaderValue: 'default',
      });
    });

    it('non-header decisions (explicit AND auto/default) record null for both columns', async () => {
      const explicit = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'gpt-4o', messages: [] });
      expect(explicit.status).toBe(200);
      // auto with NO matching header falls through to the default tier.
      const auto = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'auto', messages: [] });
      expect(auto.status).toBe(200);
      await writer.flush();
      // Same-batch rows share one now() timestamp — select by layer, not index.
      const rows = await port.requestLogs.list(principal);
      expect(rows.find((r) => r.decisionLayer === 'explicit')).toMatchObject({
        routingHeaderName: null,
        routingHeaderValue: null,
      });
      expect(rows.find((r) => r.decisionLayer === 'default')).toMatchObject({
        routingHeaderName: null,
        routingHeaderValue: null,
      });
    });
  });

  describe('terminal error detail (add-request-error-detail)', () => {
    it('a whole-chain failure records kind/status and the provider-verbatim operational message', async () => {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'oai-srvfail', messages: [] }); // single-member chain → 500
      expect(res.status).toBeGreaterThanOrEqual(500);
      await writer.flush();
      const row = (await port.requestLogs.list(principal)).find(
        (r) => r.status === 'error' && r.errorStatus === 500,
      );
      expect(row).toBeDefined();
      expect(row!.errorKind).toBe('unavailable');
      expect(row!.errorMessage).toBe('stub failure'); // the provider's own words
    });

    it('a validation (bad_request) failure withholds the message by fixed marker', async () => {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'oai-badreq', messages: [] });
      expect(res.status).toBe(400);
      await writer.flush();
      const row = (await port.requestLogs.list(principal)).find(
        (r) => r.status === 'error' && r.errorKind === 'bad_request',
      );
      expect(row).toBeDefined();
      expect(row!.errorStatus).toBe(400);
      expect(row!.errorMessage).toBe('[validation message withheld]'); // never the echo-prone text
    });

    it('a post-commit stream failure records the wire error event’s own message', async () => {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'oai-miderror', stream: true, messages: [] });
      expect(res.status).toBe(200);
      expect(res.text).toContain('"upstream_error"'); // committed, then the terminal frame
      await writer.flush();
      const row = (await port.requestLogs.list(principal)).find(
        (r) => r.status === 'error' && r.errorMessage === 'SECRET mid',
      );
      expect(row).toBeDefined();
      expect(row!.errorKind).toBe('unavailable');
      // The client saw the FIXED terminal message, never the provider text.
      expect(res.text).not.toContain('SECRET mid');
    });

    it('a success row carries all-null error detail', async () => {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'ok' }] });
      expect(res.status).toBe(200);
      await writer.flush();
      const row = (await port.requestLogs.list(principal))
        .filter((r) => r.status === 'success')
        .at(0);
      expect(row).toBeDefined();
      expect(row!.errorKind).toBeNull();
      expect(row!.errorMessage).toBeNull();
    });
  });

  it('cost is immutable: a later catalog price change does not move a recorded cost', async () => {
    // Record via the pipeline with a KNOWN-host provider so the bundled catalog
    // price (openai:gpt-4o) resolves — deriveModelKey is pure (no network).
    const ctx: RecordingContext = {
      principal,
      agentId: null,
      protocol: 'openai',
      providerId: 'p-known',
      providerName: 'openai-known',
      modelId: gpt4oModelId,
      tierAssigned: null,
      decisionLayer: 'explicit',
      routingReason: 'explicit model',
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

  it('native-family fallback prices an aggregator request — flagged, immutable, race-correct (add-native-price-fallback)', async () => {
    // The catalog is GLOBAL (not owner-scoped): the exact-key override this test
    // appends later would survive into a rerun and hijack `first`'s resolution
    // (priceSource 'manual'). Reset both keys so the test is idempotent.
    await pool.query(`DELETE FROM model_price WHERE model_key IN ($1, $2)`, [
      'minimax:minimax-m3',
      'openrouter:minimax/minimax-m3',
    ]);
    // Seed ONLY the native-family key: the openrouter channel key is absent.
    await pricing.override(
      'minimax:minimax-m3',
      { inputPricePer1m: 0.3, outputPricePer1m: 1.2 },
      new Date(),
    );
    const mkCtx = (externalModelId: string): RecordingContext => ({
      principal,
      agentId: null,
      protocol: 'openai',
      providerId: 'p-openrouter',
      providerName: 'openrouter',
      modelId: gpt4oModelId,
      tierAssigned: null,
      decisionLayer: 'native-family-e2e',
      routingReason: 'native-family e2e',
      provider: { baseUrl: 'https://openrouter.ai/api/v1', kind: 'api_key' },
      model: { externalModelId, inputPricePer1m: null, outputPricePer1m: null, isFree: false },
      startedAt: Date.now(),
      requestChars: 0,
    });
    recorder.record(mkCtx('minimax/minimax-m3'), {
      status: 'success',
      providerUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      outputChars: 0,
    });
    await writer.flush();
    const rows = () => port.requestLogs.list(principal);
    const first = (await rows()).find(
      (r) => r.decisionLayer === 'native-family-e2e' && r.cost !== null,
    );
    expect(first).toBeDefined();
    expect(first!.priceSource).toBe('native_family'); // flagged, never impersonating
    expect(first!.inputPriceSnapshot).toBe(0.3);
    expect(first!.outputPriceSnapshot).toBe(1.2);
    expect(first!.cost).toBeCloseTo(1.5, 6); // 1M in + 1M out at the native rates

    // A LATER exact-key append: the recorded row is immutable...
    await pricing.override(
      'openrouter:minimax/minimax-m3',
      { inputPricePer1m: 9, outputPricePer1m: 9 },
      new Date(),
    );
    const again = await port.requestLogs.findById(principal, first!.id);
    expect(again!.cost).toBe(first!.cost);
    expect(again!.priceSource).toBe('native_family');
    // ...while a NEW request completing after the append records the EXACT row.
    recorder.record(mkCtx('minimax/minimax-m3'), {
      status: 'success',
      providerUsage: { inputTokens: 1_000_000, outputTokens: 0 },
      outputChars: 0,
    });
    await writer.flush();
    const second = (await rows()).find(
      (r) => r.decisionLayer === 'native-family-e2e' && r.id !== first!.id && r.cost !== null,
    );
    expect(second).toBeDefined();
    expect(second!.priceSource).toBe('manual'); // the exact override row's own source
    expect(second!.inputPriceSnapshot).toBe(9);

    // An unmapped vendor stays honestly unpriced (null cost, null provenance).
    recorder.record(mkCtx('somevendor/model-1'), {
      status: 'success',
      providerUsage: { inputTokens: 10, outputTokens: 10 },
      outputChars: 0,
    });
    await writer.flush();
    const unmapped = (await rows()).find(
      (r) => r.decisionLayer === 'native-family-e2e' && r.cost === null,
    );
    expect(unmapped).toBeDefined();
    expect(unmapped!.priceSource).toBeNull();
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
