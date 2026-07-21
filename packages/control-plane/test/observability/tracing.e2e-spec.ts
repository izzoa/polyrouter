// Tracing e2e (#21): registers a REAL NodeTracerProvider with an in-memory
// exporter (the only registrar in the whole suite — the disabled default is
// exercised by every other spec), drives buffered / fallback / streamed
// requests through the slim proxy, and asserts the span chain: one
// `proxy.request` root with `auth` → `routing` → `upstream` → `recording.enqueue`
// children, per-provider error attribution on the failed member, and the
// writer's `recording.write` batch span LINKED to the request. Metadata only —
// no attribute may carry prompt text or key material.
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
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
import { LogWriter } from '../../src/recording/log-writer';
import { PricingModule } from '../../src/pricing/pricing.module';
import { DatabaseModule } from '../../src/database/database.module';
import { SemanticModule } from '../../src/semantic/semantic.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

const HMAC = 'a'.repeat(64);
const PROMPT_MARKER = 'TRACE_PROMPT_MARKER_zzz';

async function buildApp(): Promise<{ app: INestApplication; server: App }> {
  const moduleRef = await Test.createTestingModule({
    imports: [SemanticModule, DatabaseModule, PricingModule, RecordingModule, ObservabilityModule],
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
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.init();
  return { app, server: app.getHttpServer() };
}

describe('tracing e2e', () => {
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;
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

    // The suite's ONLY global tracer registration — spans go to memory.
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();

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
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'tr', $1, true) RETURNING id`,
        [`tracing-${Date.now()}@obs.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);

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
    const gpt = (await port.models.createForProvider(principal, solid.id, {
      externalModelId: 'gpt-4o',
    }))!;
    const srvfail = (await port.models.createForProvider(principal, flaky.id, {
      externalModelId: 'oai-srvfail',
    }))!;
    await port.ensureDefaultTier(principal);
    const def = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, def.id, [gpt.id]);
    const fb = await port.tiers.insert(principal, { key: 'fallback' });
    await port.routingEntries.replaceForTier(principal, fb.id, [srvfail.id, gpt.id]);

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
    await provider.shutdown(); // unhook the global registration for good measure
  });

  beforeEach(() => exporter.reset());

  function send(body: Record<string, unknown>, tier?: string): request.Test {
    const r = request(server).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`);
    if (tier) r.set('x-polyrouter-tier', tier);
    return r.send(body);
  }
  const chat = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: PROMPT_MARKER }],
    ...over,
  });
  const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
  const byName = (name: string): ReadableSpan[] => spans().filter((s) => s.name === name);
  const parentIdOf = (s: ReadableSpan): string | undefined => s.parentSpanContext?.spanId;

  it('a buffered request produces the full chain under one root', async () => {
    expect((await send(chat())).status).toBe(200);

    const root = byName('proxy.request')[0];
    expect(root).toBeDefined();
    expect(root!.attributes['polyrouter.protocol']).toBe('openai');
    expect(root!.attributes['url.path']).toBe('/v1/chat/completions');
    expect(root!.attributes['http.response.status_code']).toBe(200);

    const traceId = root!.spanContext().traceId;
    for (const name of ['auth', 'routing', 'upstream', 'recording.enqueue']) {
      const s = byName(name)[0];
      expect(s).toBeDefined();
      expect(s!.spanContext().traceId).toBe(traceId);
      expect(parentIdOf(s!)).toBe(root!.spanContext().spanId);
    }
    expect(byName('routing')[0]!.attributes['polyrouter.decision_layer']).toBe('explicit');
    const upstream = byName('upstream')[0]!;
    expect(upstream.attributes['polyrouter.provider']).toBe('solid');
    expect(upstream.attributes['polyrouter.model']).toBe('gpt-4o');
    expect(upstream.attributes['polyrouter.outcome']).toBe('success');
  });

  it('a failed member is attributed; the serving member follows in the same trace', async () => {
    expect((await send(chat({ model: 'auto' }), 'fallback')).status).toBe(200);

    const ups = byName('upstream');
    expect(ups).toHaveLength(2);
    const failed = ups.find((s) => s.attributes['polyrouter.provider'] === 'flaky')!;
    const served = ups.find((s) => s.attributes['polyrouter.provider'] === 'solid')!;
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes['polyrouter.outcome']).toBe('error');
    expect(served.attributes['polyrouter.outcome']).toBe('success');
    expect(failed.spanContext().traceId).toBe(served.spanContext().traceId);
  });

  it('a streamed request closes its upstream span with success after the stream ends', async () => {
    const res = await send(chat({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.text).toContain('[DONE]');
    await new Promise((r) => setTimeout(r, 40)); // outcome settle microtask

    const upstream = byName('upstream')[0];
    expect(upstream).toBeDefined();
    expect(upstream!.attributes['polyrouter.streaming']).toBe(true);
    expect(upstream!.attributes['polyrouter.outcome']).toBe('success');
    const root = byName('proxy.request')[0]!;
    expect(root.attributes['http.response.status_code']).toBe(200);
  });

  it('the durable write is traced as a batch span linked to the request', async () => {
    await writer.flush(); // drain earlier tests' drafts so this batch is ours alone
    exporter.reset();
    expect((await send(chat())).status).toBe(200);
    const root = byName('proxy.request')[0]!;
    await writer.flush();

    const write = byName('recording.write').find((s) =>
      s.links.some((l) => l.context.traceId === root.spanContext().traceId),
    );
    expect(write).toBeDefined();
    expect(write!.attributes['polyrouter.rows']).toBe(1);
    // Links-only correlation: the batch span must be a ROOT, never a child of
    // whichever request happened to trigger the flush.
    expect(parentIdOf(write!)).toBeUndefined();
  });

  it('no span attribute carries prompt text or key material (metadata only)', async () => {
    expect((await send(chat())).status).toBe(200);
    await writer.flush();
    for (const s of spans()) {
      const dump = JSON.stringify(s.attributes);
      expect(dump).not.toContain(PROMPT_MARKER);
      expect(dump).not.toContain(key);
      expect(dump).not.toContain('Hello from stub'); // no response bodies either
    }
  });
});
