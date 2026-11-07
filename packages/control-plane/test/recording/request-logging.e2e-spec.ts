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
  encryptSecret,
  serializePlainCredential,
  userPrincipal,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  createProviderAdapter,
  type ProviderConfig,
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
import { WorkloadRouter } from '../../src/proxy/workload/workload-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { RecordingModule } from '../../src/recording/recording.module';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { randomUUID } from 'node:crypto';
import { RequestRecorder, type RecordingContext } from '../../src/recording/request-recorder';
import { InflightModule } from '../../src/inflight/inflight.module';
import { InflightRegistry } from '../../src/inflight/inflight-registry';
import { LogWriter } from '../../src/recording/log-writer';
import { PricingModule } from '../../src/pricing/pricing.module';
import { PricingService } from '../../src/pricing/pricing.service';
import { DatabaseModule } from '../../src/database/database.module';
import { SemanticModule } from '../../src/semantic/semantic.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';
import { BUDGET_READER, type BudgetReader } from '../../src/database/budget.reader';
import {
  KIMI_CODE_PRESET,
  OPENCODE_GO_PRESET,
  ZAI_CODING_PLAN_PRESET,
  keyPresetForRow,
} from '../../src/subscription-presets/key-presets';

const HMAC = 'a'.repeat(64);

// add-key-subscription-presets (task 8.2): the adapter factory every `subscription` provider is
// built through. A key-preset row is pinned to a real provider host, so the factory records the
// config the proxy built (proving the pinned endpoint was dispatched) and then serves it from
// the loopback stub: no request ever leaves the machine. Every other provider is built for real.
const subscriptionConfigs: ProviderConfig[] = [];
let stubUrl = '';
const stubAdapterFactory: typeof createProviderAdapter = (config, deps) => {
  if (config.kind !== 'subscription') return createProviderAdapter(config, deps);
  subscriptionConfigs.push(config);
  return createProviderAdapter(
    { ...config, baseUrl: stubUrl, kind: 'local', mode: 'selfhosted', credential: '' },
    deps,
  );
};
const PLAIN_KEY = 'sk-keypreset-e2e';

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
  let skipProviderId: string;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    // zero-cost-unbilled-errors: the stub's 5s pre-headers delay (`slowheadlong`) must trip
    // the instance first-byte bound so a REAL timeout (an attempt the provider may
    // still be working on) is reachable. Every other model answers in milliseconds; the
    // bound is 1.5s, not tighter, so a loaded machine cannot time out an ordinary call.
    process.env['PROXY_FIRST_EVENT_TIMEOUT_MS'] = '1500';
    stub = await startStubUpstream();
    stubUrl = stub.url;

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SemanticModule,
        DatabaseModule,
        PricingModule,
        RecordingModule,
        ObservabilityModule,
        // add-inflight-requests: the REAL registry, so the admit→settle wiring is
        // asserted end-to-end against the real recorder (not a stub).
        InflightModule,
      ],
      controllers: [ChatCompletionsController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        {
          // add-subscription-oauth: ProxyService's credential seam — these suites mint
          // no OAuth envelopes, so a call here is a wiring bug worth failing loudly.
          provide: SubscriptionOauthService,
          useValue: {
            // Only a key-preset row (a plain pasted key) resolves here; anything else is a
            // wiring bug worth failing loudly.
            resolveCredential: (_principal: Principal, row: ProviderRow) =>
              row.keyPreset !== null
                ? Promise.resolve({
                    credential: PLAIN_KEY,
                    authScheme: 'api_key' as const,
                    envelope: row.encryptedCredentials,
                  })
                : Promise.reject(new Error('oauth seam not stubbed')),
            availableClientIdentity: () => null,
          },
        },
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
        { provide: PROXY_ADAPTER_FACTORY, useValue: stubAdapterFactory },
        { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
        { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
        {
          provide: CALIBRATION_RAILS,
          useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()),
        },
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
    // fix-4xx-error-taxonomy fixtures: 402 (rescued and exhausted) and a 403.
    const nofunds = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-nofunds',
    });
    const noperm = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-noperm',
    });
    await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-miderror',
    });
    // add-inflight-requests: commits then finishes after ~400ms — a deterministic
    // window in which the live entry must be observable.
    await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-slowtail',
    });
    await port.ensureDefaultTier(principal);
    const tier = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, tier.id, [gpt4oModelId]);
    const fb = await port.tiers.insert(principal, { key: 'fallback' });
    await port.routingEntries.replaceForTier(principal, fb.id, [srvfail!.id, gpt4oModelId]);
    // an all-dry chain: nothing rescues it, so the terminal 402 detail is recorded
    const drytier = await port.tiers.insert(principal, { key: 'alldry' });
    await port.routingEntries.replaceForTier(principal, drytier.id, [nofunds!.id]);
    // a rescued 402: member 1 is dry, member 2 serves → status=fallback
    const rescued = await port.tiers.insert(principal, { key: 'rescued' });
    await port.routingEntries.replaceForTier(principal, rescued.id, [nofunds!.id, gpt4oModelId]);
    // fix-bad-request-dead-end: THE reported incident — the primary 400s with a
    // classification code and a prompt-echoing message, and a later member serves.
    const badreqModel = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-badreq-rescued',
    });
    const badreqModel2 = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-badreq-allfail',
    });
    const allBad = await port.tiers.insert(principal, { key: 'rescued-badreq-allfail' });
    await port.routingEntries.replaceForTier(principal, allBad.id, [
      badreqModel!.id,
      badreqModel2!.id,
    ]);
    const rescuedBad = await port.tiers.insert(principal, { key: 'rescued-badreq' });
    await port.routingEntries.replaceForTier(principal, rescuedBad.id, [
      badreqModel!.id,
      gpt4oModelId,
    ]);
    const permtier = await port.tiers.insert(principal, { key: 'nopermtier' });
    await port.routingEntries.replaceForTier(principal, permtier.id, [noperm!.id]);
    // add-fallback-attempt-detail: a SECOND provider whose breaker the mixed-chain
    // test opens — its member must be SKIPPED (never dispatched), not failed.
    const skipProv = await port.providers.insert(principal, {
      name: 'skip-stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    skipProviderId = skipProv.id;
    const skipModel = await port.models.createForProvider(principal, skipProv.id, {
      externalModelId: 'oai-skip',
    });
    const mixed = await port.tiers.insert(principal, { key: 'mixed-fail' });
    await port.routingEntries.replaceForTier(principal, mixed.id, [srvfail!.id, skipModel!.id]);
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
    expect(row.attemptFailures).toBeNull(); // add-fallback-attempt-detail: success rows carry none
    expect(row.billed).toBe(true); // zero-cost-unbilled-errors: a served row is always billed
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
    expect(row!.billed).toBe(true); // zero-cost-unbilled-errors: a fallback row is always billed
    // add-request-error-detail decision 2: a SERVED request carries no error detail —
    // it has no TERMINAL error.
    expect(row!.errorKind).toBeNull();
    expect(row!.errorStatus).toBeNull();
    expect(row!.errorMessage).toBeNull();
    expect(row!.errorRequestId).toBeNull();
    expect(row!.errorMarkers).toBeNull();
    // fix-bad-request-dead-end: the per-attempt column follows the WALK, not the
    // terminal status — a served-with-bumps row DOES carry its trail, because its
    // earlier members genuinely failed and this is the only record of why it moved.
    expect(row!.attemptFailures).not.toBeNull();
    expect(row!.attemptFailures!.length).toBeGreaterThan(0);
  });

  describe('per-attempt failure metadata (add-fallback-attempt-detail)', () => {
    it('an exhausted mixed chain records skip@ in the trail and ordered structural entries', async () => {
      // Open the SECOND provider's breaker (threshold 5) so its member is
      // skipped without ever being dispatched.
      const breaker = app.get<CircuitBreaker>(PROXY_BREAKER);
      for (let i = 0; i < 5; i += 1) {
        const { token } = await breaker.before(skipProviderId);
        await breaker.complete(token, 'trip');
      }
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'mixed-fail', messages: [] });
      expect(res.status).toBeGreaterThanOrEqual(500);
      await writer.flush();
      const row = (await port.requestLogs.list(principal)).find(
        (r) => r.status === 'error' && r.routingReason.includes('skip@'),
      );
      expect(row).toBeDefined();
      // The trail distinguishes contact from silence (delta: skip@ grammar).
      expect(row!.routingReason).toContain('unavailable@oai-srvfail, skip@oai-skip');
      // Terminal = the skip (last member): kind only, no upstream HTTP status.
      expect(row!.errorKind).toBe('unavailable');
      expect(row!.errorStatus).toBeNull();
      const entries = row!.attemptFailures!;
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        index: 0,
        model: 'oai-srvfail',
        kind: 'unavailable',
        dispatched: true,
        status: 500,
      });
      expect(entries[1]).toMatchObject({
        index: 1,
        model: 'oai-skip',
        kind: 'unavailable',
        dispatched: false,
        terminal: true,
      });
      expect(entries[1]!.status).toBeUndefined();
      // Structure only — no free-text field anywhere (invariant 8).
      const allowed = new Set([
        'index',
        'providerId',
        'model',
        'kind',
        'status',
        'dispatched',
        'leg',
        'terminal',
      ]);
      for (const e of entries) {
        for (const k of Object.keys(e)) expect(allowed.has(k)).toBe(true);
        for (const v of Object.values(e)) expect(typeof v).not.toBe('object');
      }
    });
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

    it('a tier-header REMAP rule records the sent tier-ask value (record-tier-header-value)', async () => {
      // A dashboard Header rule on x-polyrouter-tier remapping a category ('shopping',
      // not a tier key) to a tier. The recorded value is the tier-ask, distinct from
      // the assigned tier — the useful bit the inspector now shows.
      await port.routingRules.insert(principal, {
        matchType: 'header',
        headerName: 'x-polyrouter-tier',
        headerValue: 'shopping',
        target: 'tier:default',
        priority: 0,
      });
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .set('x-polyrouter-tier', 'shopping')
        .send({ model: 'auto', messages: [] });
      expect(res.status).toBe(200);
      await writer.flush();
      const row = (await port.requestLogs.list(principal))[0]!;
      expect(row).toMatchObject({
        decisionLayer: 'header',
        routingReason: 'header rule x-polyrouter-tier',
        tierAssigned: 'default',
        routingHeaderName: 'x-polyrouter-tier',
        routingHeaderValue: 'shopping', // the remap's owned value is now recorded
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

    // fix-4xx-error-taxonomy. The reported incident's row: explicable from KIND +
    // STATUS alone, with no provider text — invariant 8 is the acceptance criterion
    // here, not diagnosability. (The kind is what the operator reads; the body would
    // add only provider phrasing, at a privacy cost 402 cannot justify.)
    it('an out-of-credit 402 records diagnosable metadata and withholds the body', async () => {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'alldry', messages: [] });
      expect(res.status).toBe(502); // never a bare 400 for a well-formed request
      await writer.flush();
      const row = (await port.requestLogs.list(principal)).find(
        (r) => r.status === 'error' && r.errorKind === 'insufficient_funds',
      );
      expect(row).toBeDefined();
      expect(row!.errorStatus).toBe(402);
      expect(row!.errorMessage).toBe('[insufficient-funds message withheld]');
      expect(row!.errorMessage).not.toMatch(/Insufficient credits/i); // the provider's own words
    });

    it('a permission 403 withholds under its own marker, not the validation one', async () => {
      await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'nopermtier', messages: [] });
      await writer.flush();
      const row = (await port.requestLogs.list(principal)).find(
        (r) => r.status === 'error' && r.errorKind === 'permission',
      );
      expect(row).toBeDefined();
      expect(row!.errorStatus).toBe(403);
      expect(row!.errorMessage).toBe('[permission message withheld]');
    });

    // fix-bad-request-dead-end: a successful fallback now carries the structural trail
    // AS WELL AS the routing_reason summary — the five terminal columns stay null.
    it('a rescued 402 records status=fallback with its trail in routing_reason', async () => {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'rescued', messages: [] });
      expect(res.status).toBe(200);
      await writer.flush();
      const row = (await port.requestLogs.list(principal)).find(
        (r) => r.status === 'fallback' && r.routingReason?.includes('insufficient_funds@'),
      );
      expect(row).toBeDefined();
      expect(row!.errorKind).toBeNull(); // no TERMINAL error on a recovered request
      expect(row!.errorMarkers).toBeNull();
      // …but the trail survives, naming the member that refused and its kind
      expect(row!.attemptFailures).not.toBeNull();
      expect(row!.attemptFailures!.map((e) => e.kind)).toContain('insufficient_funds');
    });

    // The other half of the disclosed cost: row COUNT is unchanged. A failed
    // pre-commit member writes no billable ledger row of its own, so widening the walk
    // does not multiply a refused request's recorded cost — an earlier draft of this
    // change claimed it did, and that claim was false. Pinned here so it stays false.
    it('an all-400 chain still records exactly ONE request-log row', async () => {
      const before = (await port.requestLogs.list(principal)).length;
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'rescued-badreq-allfail', messages: [] });
      expect(res.status).toBe(400);
      await writer.flush();
      const rows = await port.requestLogs.list(principal);
      expect(rows.length).toBe(before + 1); // ONE row, however many members were walked
      const row = rows[0]!;
      expect(row.status).toBe('error');
      // …and its trail names every member that was dispatched
      expect(row.attemptFailures!.length).toBeGreaterThanOrEqual(2);
    });

    // fix-bad-request-dead-end, END TO END: the incident this change exists for. The
    // chain is walked instead of abandoned, the request succeeds, and the row explains
    // WHY it moved — with the provider's classification retained and its prompt-echoing
    // message still withheld. Both halves of the defect, on one row.
    it('a rescued bad_request records the trail, the marker, and NO terminal detail', async () => {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'rescued-badreq', messages: [] });
      expect(res.status).toBe(200); // the chain was WALKED, not abandoned
      await writer.flush();
      const row = (await port.requestLogs.list(principal)).find(
        (r) => r.status === 'fallback' && r.routingReason?.includes('bad_request@'),
      );
      expect(row).toBeDefined();
      // the five terminal columns stay null — a recovered request has no terminal error
      expect(row!.errorKind).toBeNull();
      expect(row!.errorMarkers).toBeNull();
      // …and the trail carries the refusing member, its kind, its status and its marker
      const entry = row!.attemptFailures!.find((e) => e.kind === 'bad_request');
      expect(entry).toBeDefined();
      expect(entry!.status).toBe(400);
      expect(entry!.markers).toEqual(['context_length_exceeded']);
      // invariant 8: the prompt fragment the provider echoed reaches NOTHING
      expect(JSON.stringify(row)).not.toContain('my secret plan');
    });

    // invariant 8 under the marker path specifically: a provider that puts prose in a
    // classification field gets it dropped, and the message policy is unchanged.
    it('prose in a classification field is never persisted as a marker', async () => {
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
      expect(row!.errorMessage).toBe('[validation message withheld]');
      expect(row!.errorMarkers).toEqual(['context_length_exceeded']);
      expect(JSON.stringify(row!.errorMarkers)).not.toContain(' '); // identifiers only
      expect(JSON.stringify(row)).not.toContain('my secret plan');
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

  /** add-inflight-requests §3.1/3.2: the admit→settle WIRING through the real
   * proxy and the real recorder — presence appears once the route resolves and is
   * gone once the parent row records, sharing the row's id. */
  it('publishes live presence at admission and clears it at settle, sharing the row id', async () => {
    const reg = app.get(InflightRegistry);
    const waitFor = async (cond: () => Promise<boolean>, ms = 4_000): Promise<boolean> => {
      const deadline = Date.now() + ms;
      for (;;) {
        if (await cond()) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    expect((await reg.list(principal)).items).toEqual([]); // clean slate
    // Fire WITHOUT awaiting: `oai-slowtail` commits then finishes ~400ms later.
    // `.then()` is what DISPATCHES a supertest request (they are lazy) — the
    // promise must be created here, not just the builder.
    const pending = request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send({ model: 'oai-slowtail', stream: true, messages: [] })
      .then((r) => r);

    const appeared = await waitFor(async () => (await reg.list(principal)).items.length === 1);
    expect(appeared).toBe(true); // mark fired at admission
    const live = (await reg.list(principal)).items[0]!;
    expect(live).toMatchObject({
      status: 'running',
      modelLabel: 'oai-slowtail',
      protocol: 'openai',
      decisionLayer: 'explicit',
    });

    await pending; // stream completes → record() → onSettle
    expect(await waitFor(async () => (await reg.list(principal)).items.length === 0)).toBe(true);

    // The live entry's id IS the durable row's id (the shared-id handoff).
    await writer.flush();
    const row = await port.requestLogs.findById(principal, live.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('success');
  });

  it('cost is immutable: a later catalog price change does not move a recorded cost', async () => {
    // Record via the pipeline with a KNOWN-host provider so the bundled catalog
    // price (openai:gpt-4o) resolves — deriveModelKey is pure (no network).
    const ctx: RecordingContext = {
      principal,
      requestId: randomUUID(),
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
        listedInputPricePer1m: null,
        listedOutputPricePer1m: null,
        listedIsFree: null,
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
      requestId: randomUUID(),
      agentId: null,
      protocol: 'openai',
      providerId: 'p-openrouter',
      providerName: 'openrouter',
      modelId: gpt4oModelId,
      tierAssigned: null,
      decisionLayer: 'native-family-e2e',
      routingReason: 'native-family e2e',
      provider: { baseUrl: 'https://openrouter.ai/api/v1', kind: 'api_key' },
      model: {
        externalModelId,
        inputPricePer1m: null,
        outputPricePer1m: null,
        isFree: false,
        listedInputPricePer1m: null,
        listedOutputPricePer1m: null,
        listedIsFree: null,
      },
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

  it('listed fallback prices an aggregator model the catalog does not cover — flagged, immutable (record-listed-price-fallback)', async () => {
    // The catalog is GLOBAL — clear the key so a rerun can't hijack the resolution.
    await pool.query(`DELETE FROM model_price WHERE model_key = $1`, [
      'openrouter:sakana/fugu-ultra',
    ]);
    // An unmapped vendor (`sakana` is not in the native allowlist) → exact AND
    // native-family both miss; but the model carries a captured listed price.
    const listedCtx: RecordingContext = {
      principal,
      requestId: randomUUID(),
      agentId: null,
      protocol: 'openai',
      providerId: 'p-openrouter',
      providerName: 'openrouter',
      modelId: gpt4oModelId,
      tierAssigned: null,
      decisionLayer: 'listed-fallback-e2e',
      routingReason: 'listed fallback e2e',
      provider: { baseUrl: 'https://openrouter.ai/api/v1', kind: 'api_key' },
      model: {
        externalModelId: 'sakana/fugu-ultra',
        inputPricePer1m: null,
        outputPricePer1m: null,
        isFree: false,
        listedInputPricePer1m: 4,
        listedOutputPricePer1m: 16,
        listedIsFree: false,
      },
      startedAt: Date.now(),
      requestChars: 0,
    };
    recorder.record(listedCtx, {
      status: 'success',
      providerUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      outputChars: 0,
    });
    await writer.flush();
    const row = (await port.requestLogs.list(principal)).find(
      (r) => r.decisionLayer === 'listed-fallback-e2e' && r.cost !== null,
    );
    expect(row).toBeDefined();
    expect(row!.priceSource).toBe('listed'); // the provider's own estimate, marked
    expect(row!.inputPriceSnapshot).toBe(4);
    expect(row!.outputPriceSnapshot).toBe(16);
    expect(row!.cost).toBeCloseTo(20, 6); // 1M in ×4 + 1M out ×16
    expect(row!.priceVersionId).toBeNull(); // a captured estimate, not a catalog version

    // A LATER catalog append never rewrites the recorded listed cost (immutable);
    // AND it means the catalog now WINS for a fresh request (listed is last-resort).
    await pricing.override(
      'openrouter:sakana/fugu-ultra',
      { inputPricePer1m: 99, outputPricePer1m: 99 },
      new Date(),
    );
    const again = await port.requestLogs.findById(principal, row!.id);
    expect(again!.cost).toBe(row!.cost);
    expect(again!.priceSource).toBe('listed');
    recorder.record(
      { ...listedCtx, requestId: randomUUID() },
      {
        status: 'success',
        providerUsage: { inputTokens: 1_000_000, outputTokens: 0 },
        outputChars: 0,
      },
    );
    await writer.flush();
    const afterCatalog = (await port.requestLogs.list(principal)).find(
      (r) => r.decisionLayer === 'listed-fallback-e2e' && r.id !== row!.id && r.cost !== null,
    );
    expect(afterCatalog!.priceSource).toBe('manual'); // catalog beats listed once present
  });

  // zero-cost-unbilled-errors: a request no provider ran is recorded at cost 0 and
  // `billed = false`; any attempt the provider MAY have run keeps today's estimate.
  // Real requests through the real proxy, recorder and writer against the stub.
  describe('not-billed rows (zero-cost-unbilled-errors)', () => {
    type LogRow = Awaited<ReturnType<PersistencePort['requestLogs']['list']>>[number];
    // Every member is PRICED (a model-own 2 / 10 per 1M on a local provider), so a row
    // that was wrongly billed carries a visibly non-zero estimate rather than a free 0.
    const PRICE = { inputPricePer1m: 2, outputPricePer1m: 10 };
    const PROMPT = 'y'.repeat(400); // ~100 estimated input tokens (chars/4)
    const estimate = (tokens: number): number => (tokens * PRICE.inputPricePer1m) / 1_000_000;
    let seq = 0;

    /** One chain member on its OWN fresh provider: a breaker is per provider, so one
     * test's failures can never turn a later test's attempt into a circuit-open skip. */
    async function member(
      externalModelId: string,
    ): Promise<{ providerId: string; modelId: string }> {
      seq += 1;
      const provider = await port.providers.insert(principal, {
        name: `zc-${String(seq)}`,
        kind: 'local',
        protocol: 'openai_compatible',
        baseUrl: stub.url,
      });
      const model = await port.models.createForProvider(principal, provider.id, {
        externalModelId,
        ...PRICE,
      });
      return { providerId: provider.id, modelId: model!.id };
    }
    /** A tier whose key is unique per call, so a row is found by `tier_assigned`. */
    async function tierOf(members: readonly { modelId: string }[]): Promise<string> {
      seq += 1;
      const key = `zc-tier-${String(seq)}`;
      const tier = await port.tiers.insert(principal, { key });
      await port.routingEntries.replaceForTier(
        principal,
        tier.id,
        members.map((m) => m.modelId),
      );
      return key;
    }
    async function openCircuit(providerId: string): Promise<void> {
      const breaker = app.get<CircuitBreaker>(PROXY_BREAKER);
      for (let i = 0; i < 5; i += 1) {
        const { token } = await breaker.before(providerId);
        await breaker.complete(token, 'trip');
      }
    }
    const chat = (model: string, stream = false) =>
      request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model, stream, messages: [{ role: 'user', content: PROMPT }] });
    /** The tier's row. A streamed outcome records in a microtask after the stream ends,
     * so poll rather than assume the first flush sees it. */
    async function rowOf(tierKey: string): Promise<LogRow> {
      const deadline = Date.now() + 5_000;
      for (;;) {
        await writer.flush();
        const row = (await port.requestLogs.list(principal)).find(
          (r) => r.tierAssigned === tierKey,
        );
        if (row !== undefined) return row;
        if (Date.now() > deadline) throw new Error(`no request_log row for tier ${tierKey}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    /** What every NOT-billed row must keep besides its zero cost: the routing-grade
     * estimate and the price snapshot (the rate that would have applied). */
    function expectNotBilled(row: LogRow): void {
      expect(row).toMatchObject({
        billed: false,
        cost: 0,
        usageEstimated: true,
        inputPriceSnapshot: PRICE.inputPricePer1m,
        outputPriceSnapshot: PRICE.outputPricePer1m,
        priceSource: 'model',
      });
      expect(row.inputTokens).toBeGreaterThanOrEqual(100);
      // The cost this row WOULD have booked before the change — non-zero, so `cost: 0`
      // above is a real decision and not a free model's coincidence.
      expect(estimate(row.inputTokens!)).toBeGreaterThan(0);
    }
    /** A BILLED error row: today's behavior, the estimate priced at the snapshot. */
    function expectBilledEstimate(row: LogRow): void {
      expect(row).toMatchObject({ billed: true, usageEstimated: true });
      expect(row.inputPriceSnapshot).toBe(PRICE.inputPricePer1m);
      expect(row.cost).toBeGreaterThan(0);
      // A post-commit row also carries the estimate of the tokens already streamed.
      const outputCost = ((row.outputTokens ?? 0) * PRICE.outputPricePer1m) / 1_000_000;
      expect(row.cost).toBeCloseTo(estimate(row.inputTokens!) + outputCost, 10);
    }

    it('every member skipped by an open circuit records $0, keeping the estimate, the snapshot and the trail', async () => {
      const a = await member('oai-zc-open-a');
      const b = await member('oai-zc-open-b');
      await openCircuit(a.providerId);
      await openCircuit(b.providerId);
      const tierKey = await tierOf([a, b]);
      const contacted = stub.requests.length;

      const res = await chat(tierKey);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(stub.requests.length).toBe(contacted); // the provider was never contacted

      const row = await rowOf(tierKey);
      expect(row.status).toBe('error');
      expectNotBilled(row);
      expect(row.errorKind).toBe('unavailable'); // the terminal error detail is untouched
      expect(row.attemptFailures).toHaveLength(2);
      for (const e of row.attemptFailures!) expect(e).toMatchObject({ dispatched: false });
    });

    it('a chain mixing a skip and a rejection records not billed (not_sent + rejected)', async () => {
      const open = await member('oai-zc-mix-open');
      const limited = await member('oai-zc-ratelimit-mix');
      await openCircuit(open.providerId);
      // The rejection FIRST and the skip last, and the reverse order in the next test.
      const tierKey = await tierOf([limited, open]);
      const res = await chat(tierKey);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const row = await rowOf(tierKey);
      expectNotBilled(row);
      expect(row.attemptFailures).toHaveLength(2);
    });

    it('the skip FIRST and the rejection last records not billed too', async () => {
      const open = await member('oai-zc-mix-open2');
      const limited = await member('oai-zc-ratelimit-mix2');
      await openCircuit(open.providerId);
      const tierKey = await tierOf([open, limited]);
      await chat(tierKey);
      expectNotBilled(await rowOf(tierKey));
    });

    it.each([[false], [true]])(
      'an all-429 chain (stream=%s) records not billed — every attempt got an error response',
      async (stream) => {
        const a = await member('oai-zc-ratelimit-a');
        const b = await member('oai-zc-ratelimit-b');
        const tierKey = await tierOf([a, b]);
        const contacted = stub.requests.length;

        const res = await chat(tierKey, stream);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(stub.requests.length).toBe(contacted + 2); // both members really answered

        const row = await rowOf(tierKey);
        expect(row.status).toBe('error');
        expectNotBilled(row);
        expect(row.errorStatus).toBe(429);
        expect(row.attemptFailures).toHaveLength(2);
        for (const e of row.attemptFailures!) {
          expect(e).toMatchObject({ dispatched: true, status: 429 });
        }
      },
    );

    it.each([[false], [true]])(
      'a non-retryable 451 stop after a 429 records not billed (stream=%s)',
      async (stream) => {
        const limited = await member('oai-zc-ratelimit-451');
        const legal = await member('oai-zc-legal');
        const never = await member('oai-zc-after-legal');
        const tierKey = await tierOf([limited, legal, never]);
        const contacted = stub.requests.length;

        const res = await chat(tierKey, stream);
        expect(res.status).toBe(451);
        expect(stub.requests.length).toBe(contacted + 2); // the third member was never tried

        const row = await rowOf(tierKey);
        expect(row.status).toBe('error');
        expectNotBilled(row);
        expect(row.errorKind).toBe('policy_block');
      },
    );

    it('a 400 rejection records not billed', async () => {
      const bad = await member('oai-zc-badreq');
      const tierKey = await tierOf([bad]);
      const res = await chat(tierKey);
      expect(res.status).toBe(400);
      const row = await rowOf(tierKey);
      expectNotBilled(row);
      expect(row.errorKind).toBe('bad_request');
    });

    it('a first-byte timeout keeps today’s estimate (the provider may still be working)', async () => {
      const slow = await member('oai-zc-slowheadlong');
      const tierKey = await tierOf([slow]);
      const res = await chat(tierKey);
      expect(res.status).toBeGreaterThanOrEqual(500);
      const row = await rowOf(tierKey);
      expect(row.status).toBe('error');
      expectBilledEstimate(row);
      expect(row.errorStatus).toBeNull(); // locally synthesized: no upstream status
    });

    it('a STREAMED first-event timeout keeps today’s estimate', async () => {
      // `hang`: 200 headers, then no bytes — the stream's first event never arrives.
      const hung = await member('oai-zc-hang');
      const tierKey = await tierOf([hung]);
      const res = await chat(tierKey, true);
      expect(res.status).toBeGreaterThanOrEqual(500);
      const row = await rowOf(tierKey);
      expect(row.status).toBe('error');
      expectBilledEstimate(row);
    });

    it('a non-retryable over-cap body after a 429 stays billed — the terminal attempt joins the fold', async () => {
      // `oversized` ends the walk WITHOUT entering `failures` (a non-retryable stop), so
      // a fold over the failures alone would see only the 429 and wrongly zero the row.
      const limited = await member('oai-zc-ratelimit-cap');
      const big = await member('oai-zc-oversized');
      const tierKey = await tierOf([limited, big]);
      const res = await chat(tierKey);
      expect(res.status).toBe(502);
      const row = await rowOf(tierKey);
      expect(row.errorKind).toBe('oversized_response');
      expectBilledEstimate(row);
    }, 20_000);

    // ONE uncertain attempt anywhere in the walk keeps the whole row billed, however
    // many other members were rejected. The timeout sits at EVERY position so a fold
    // that only reads the first (or last) member fails.
    it.each([
      { layout: 'TRR', stream: false },
      { layout: 'RTR', stream: false },
      { layout: 'RRT', stream: false },
      { layout: 'RTR', stream: true },
    ])('a mixed chain $layout (stream=$stream) stays billed', async ({ layout, stream }) => {
      const members = [];
      for (const c of layout) {
        members.push(await member(c === 'T' ? 'oai-zc-slowheadlong' : 'oai-zc-ratelimit-mixed'));
      }
      const tierKey = await tierOf(members);
      const contacted = stub.requests.length;
      const res = await chat(tierKey, stream);
      expect(res.status).toBeGreaterThanOrEqual(400);
      // Every member was walked: the timeout did not stop the chain.
      expect(stub.requests.length).toBe(contacted + layout.length);
      const row = await rowOf(tierKey);
      expect(row.status).toBe('error');
      expectBilledEstimate(row);
    });

    it.each(['completion', 'stream'] as const)(
      'a client abort before the first member is dispatched records not billed (%s)',
      async (mode) => {
        const m = await member('oai-zc-gone');
        const tierKey = await tierOf([m]);
        const contacted = stub.requests.length;
        const gone = new AbortController();
        gone.abort(); // the client left before the walk reached member 0
        const svc = app.get(ProxyService);
        const wire = { model: tierKey, messages: [{ role: 'user', content: PROMPT }] };
        const call =
          mode === 'completion'
            ? svc.completion(principal, 'openai', wire, {}, null, gone.signal)
            : svc.stream(principal, 'openai', wire, {}, gone.signal, null);
        await expect(call).rejects.toBeDefined();
        expect(stub.requests.length).toBe(contacted); // nothing was in flight

        const row = await rowOf(tierKey);
        expect(row.status).toBe('cancelled');
        expectNotBilled(row);
      },
    );

    it('a post-commit stream error stays billed', async () => {
      const mid = await member('oai-zc-miderror');
      const tierKey = await tierOf([mid]);
      const res = await chat(tierKey, true);
      expect(res.status).toBe(200); // committed, then the terminal frame
      const row = await rowOf(tierKey);
      expect(row.status).toBe('error');
      expectBilledEstimate(row);
    });

    it('a client cancel AFTER the first token stays billed', async () => {
      // `neverend`: role + one token, then the upstream holds the stream open.
      const open = await member('oai-zc-neverend');
      const tierKey = await tierOf([open]);
      const gone = new AbortController();
      const frames = await app
        .get(ProxyService)
        .stream(
          principal,
          'openai',
          { model: tierKey, messages: [{ role: 'user', content: PROMPT }] },
          {},
          gone.signal,
          null,
        );
      const it = frames[Symbol.asyncIterator]();
      expect((await it.next()).done).toBe(false); // the first token reached the client
      gone.abort(); // …then the client hangs up
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !(await it.next()).done) {
        /* drain to the terminal frame */
      }
      const row = await rowOf(tierKey);
      expect(row.status).toBe('cancelled');
      expectBilledEstimate(row);
    });

    it('a not-billed row is immutable: a later catalog price change leaves $0 and its snapshot', async () => {
      // A KNOWN-host provider so the catalog price resolves (deriveModelKey is pure — no
      // network). A fresh key keeps the test idempotent: the catalog is global.
      const modelKey = 'openai:zc-unbilled-e2e';
      await pool.query(`DELETE FROM model_price WHERE model_key = $1`, [modelKey]);
      await pricing.override(
        modelKey,
        { inputPricePer1m: 3, outputPricePer1m: 6 },
        new Date(Date.now() - 60_000),
      );
      const ctx: RecordingContext = {
        principal,
        requestId: randomUUID(),
        agentId: null,
        protocol: 'openai',
        providerId: 'p-known',
        providerName: 'openai-known',
        modelId: gpt4oModelId,
        tierAssigned: null,
        decisionLayer: 'unbilled-immutable-e2e',
        routingReason: 'unbilled immutable e2e',
        provider: { baseUrl: 'https://api.openai.com/v1', kind: 'api_key' },
        model: {
          externalModelId: 'zc-unbilled-e2e',
          inputPricePer1m: null,
          outputPricePer1m: null,
          isFree: false,
          listedInputPricePer1m: null,
          listedOutputPricePer1m: null,
          listedIsFree: null,
        },
        startedAt: Date.now(),
        requestChars: 4_000, // ~1000 estimated input tokens
      };
      recorder.record(ctx, {
        status: 'error',
        outputChars: 0,
        unbilledWalk: true,
        error: { kind: 'unavailable', status: 429, providerMessage: 'rate limited' },
      });
      await writer.flush();
      const find = async (): Promise<LogRow> =>
        (await port.requestLogs.list(principal)).find(
          (r) => r.decisionLayer === 'unbilled-immutable-e2e',
        )!;
      const recorded = await find();
      expect(recorded).toMatchObject({
        billed: false,
        cost: 0,
        usageEstimated: true,
        inputPriceSnapshot: 3,
        outputPriceSnapshot: 6,
      });
      expect(recorded.inputTokens).toBeGreaterThan(0);

      await pricing.override(modelKey, { inputPricePer1m: 999, outputPricePer1m: 999 }, new Date());
      const again = await port.requestLogs.findById(principal, recorded.id);
      expect(again).toMatchObject({
        billed: false,
        cost: 0,
        inputPriceSnapshot: 3,
        outputPriceSnapshot: 6,
        priceVersionId: recorded.priceVersionId,
      });
    });
  });

  // add-key-subscription-presets (task 8.2): a key preset adds no host mapping, so its cost is
  // whatever the EXISTING host-to-family map and catalog say, snapshotted immutably under
  // provider_kind='subscription'. Real requests through the real proxy, builder, recorder and
  // writer; the adapter factory above serves them from the stub, so nothing reaches a provider.
  // (The builder gates each pinned host with a DNS-only SSRF resolve, as the connect suite does.)
  describe('key-preset cost (add-key-subscription-presets)', () => {
    const PRICED = 'zai:glm-kp-priced';
    const range = (): { from: Date; to: Date } => ({
      from: new Date(0),
      to: new Date(Date.now() + 3_600_000),
    });
    type KeyRow = Awaited<ReturnType<PersistencePort['requestLogs']['list']>>[number];

    async function seedKeyPresetRoute(
      tierKey: string,
      preset: typeof ZAI_CODING_PLAN_PRESET,
      externalModelId: string,
    ): Promise<ProviderRow> {
      const region = preset.regions[0]!;
      const row = await port.providers.insert(principal, {
        name: `${preset.id}-${tierKey}`,
        kind: 'subscription',
        protocol: region.protocol,
        baseUrl: region.baseUrl,
        keyPreset: preset.id,
        encryptedCredentials: encryptSecret(serializePlainCredential(PLAIN_KEY), 'c'.repeat(64)),
      });
      // The fixture is a genuine key-preset row: the coherence gate matches it.
      expect(keyPresetForRow(row)?.preset.id).toBe(preset.id);
      const model = await port.models.createForProvider(principal, row.id, { externalModelId });
      const tier = await port.tiers.insert(principal, { key: tierKey });
      await port.routingEntries.replaceForTier(principal, tier.id, [model!.id]);
      return row;
    }
    const send = (tierKey: string) =>
      request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: tierKey, messages: [{ role: 'user', content: 'hi' }] });
    const logFor = async (tierKey: string): Promise<KeyRow> => {
      await writer.flush();
      const rows = (await port.requestLogs.list(principal)).filter(
        (r) => r.tierAssigned === tierKey,
      );
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    const spend = async (): Promise<{
      cash: number;
      notionalMicros: number;
      cashMicros: number;
      subscription: number;
    }> => {
      const summary = await port.analytics.summary(principal, range());
      const reader = app.get<BudgetReader>(BUDGET_READER);
      const r = range();
      return {
        cash: summary.spend,
        subscription: summary.subscriptionSpend,
        cashMicros: (await reader.spendMicrosFor(userId, null, r.from, r.to, 'cash')).micros,
        notionalMicros: (await reader.spendMicrosFor(userId, null, r.from, r.to, 'notional'))
          .micros,
      };
    };

    beforeAll(async () => {
      // The catalog is GLOBAL: clear first so an aborted earlier run cannot hijack the key.
      await pool.query(`DELETE FROM model_price WHERE model_key = $1`, [PRICED]);
      await pricing.override(PRICED, { inputPricePer1m: 100, outputPricePer1m: 300 }, new Date());
    });
    afterAll(async () => {
      await pool.query(`DELETE FROM model_price WHERE model_key = $1`, [PRICED]);
    });
    beforeEach(() => {
      subscriptionConfigs.length = 0;
    });

    it('a Z.ai key-preset request records snapshotted catalog prices as notional subscription cost, immutably', async () => {
      await seedKeyPresetRoute('kp-zai-priced', ZAI_CODING_PLAN_PRESET, 'glm-kp-priced');
      const before = await spend();
      const res = await send('kp-zai-priced');
      expect(res.status).toBe(200);
      // The proxy dispatched the PINNED coding endpoint (the factory then served it locally),
      // with no preset-declared identity (the switch is off) and no listing override.
      expect(subscriptionConfigs.map((c) => c.baseUrl)).toEqual([
        ZAI_CODING_PLAN_PRESET.regions[0]!.baseUrl,
      ]);
      expect('extraHeaders' in subscriptionConfigs[0]!).toBe(false);

      const row = await logFor('kp-zai-priced');
      expect(row).toMatchObject({
        status: 'success',
        providerKind: 'subscription',
        priceSource: 'manual',
        inputPriceSnapshot: 100,
        outputPriceSnapshot: 300,
      });
      // The stub reports 3 prompt and 2 completion tokens: (3 x 100 + 2 x 300) / 1e6.
      expect(row.cost).toBeCloseTo(0.0009, 9);

      // Notional, never cash: out of the analytics spend and a cash budget, in the subscription
      // component and a notional budget.
      const after = await spend();
      expect(after.cash - before.cash).toBeCloseTo(0, 9);
      expect(after.cashMicros - before.cashMicros).toBe(0);
      expect(after.subscription - before.subscription).toBeCloseTo(0.0009, 9);
      expect(after.notionalMicros - before.notionalMicros).toBe(900);

      // A later catalog change leaves the recorded row untouched.
      await pricing.override(PRICED, { inputPricePer1m: 999, outputPricePer1m: 999 }, new Date());
      const again = await port.requestLogs.findById(principal, row.id);
      expect(again!.cost).toBe(row.cost);
      expect(again!.inputPriceSnapshot).toBe(100);
      expect(again!.outputPriceSnapshot).toBe(300);
      expect(again!.priceSource).toBe('manual');
      expect(again!.providerKind).toBe('subscription');
      await pricing.override(PRICED, { inputPricePer1m: 100, outputPricePer1m: 300 }, new Date());
    });

    it('a Z.ai key-preset model with no zai: catalog row records unknown cost and borrows nothing', async () => {
      await seedKeyPresetRoute('kp-zai-unpriced', ZAI_CODING_PLAN_PRESET, 'glm-kp-unpriced');
      const before = await spend();
      expect((await send('kp-zai-unpriced')).status).toBe(200);
      const row = await logFor('kp-zai-unpriced');
      // The existing unknown signal: no cost, no provenance, no snapshot (resolveModelPrice null).
      expect(row).toMatchObject({
        status: 'success',
        providerKind: 'subscription',
        cost: null,
        priceSource: null,
        inputPriceSnapshot: null,
        outputPriceSnapshot: null,
      });
      expect(row.inputTokens).toBeGreaterThan(0);
      const after = await spend();
      expect(after.subscription - before.subscription).toBeCloseTo(0, 9);
      expect(after.notionalMicros - before.notionalMicros).toBe(0);
    });

    it('an OpenCode Go request records unknown cost, and no other host family lends a price', async () => {
      // The decoy is the point: a `zai:` row for the SAME model id exists, and the opencode.ai
      // host maps to no family, so nothing may be borrowed from it.
      const row = await seedKeyPresetRoute('kp-ocg', OPENCODE_GO_PRESET, 'glm-kp-priced');
      expect(row.baseUrl).toBe('https://opencode.ai/inference/go/openai/v1');
      expect((await send('kp-ocg')).status).toBe(200);
      expect(subscriptionConfigs.map((c) => c.baseUrl)).toEqual([row.baseUrl]);
      // The preset's listing override rode the same build, and no identity (it declares none).
      expect(subscriptionConfigs[0]!.modelsUrl).toBe('https://opencode.ai/inference/go/v1/models');
      expect('extraHeaders' in subscriptionConfigs[0]!).toBe(false);
      const log = await logFor('kp-ocg');
      expect(log).toMatchObject({
        status: 'success',
        providerKind: 'subscription',
        cost: null,
        priceSource: null,
        inputPriceSnapshot: null,
        outputPriceSnapshot: null,
      });
    });

    it('a Kimi key-preset request (an unmapped host) records unknown cost too', async () => {
      await seedKeyPresetRoute('kp-kimi', KIMI_CODE_PRESET, 'glm-kp-priced');
      expect((await send('kp-kimi')).status).toBe(200);
      const log = await logFor('kp-kimi');
      expect(log).toMatchObject({ providerKind: 'subscription', cost: null, priceSource: null });
    });
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
