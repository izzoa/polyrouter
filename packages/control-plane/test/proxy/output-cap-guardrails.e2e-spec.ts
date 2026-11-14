/* eslint-disable @typescript-eslint/require-await, require-yield -- fake async generators in tests */
// Output-cap guardrails e2e (add-output-cap-guardrails): real Postgres + real
// routing/recording, with a FAKE adapter factory so providers can carry REAL
// family-host base_urls (https://api.openai.com — required for `deriveModelKey`
// to resolve catalog caps) without dialing anything. The SSRF guard still
// DNS-resolves those hosts at adapter build, so this suite needs outbound DNS —
// the same network posture the rest of the e2e environment already assumes.
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig, type AttemptFailureEntry, type RouteLeg } from '@polyrouter/shared';
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
  ProviderError,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderConfig,
} from '@polyrouter/data-plane';
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
import type { Redis } from 'ioredis';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

const HMAC = 'a'.repeat(64);

type Behavior = 'ok' | 'lenstop' | 'badreq' | 'ratelimit' | 'legal';
/** externalModelId → scripted upstream behavior. */
const behaviorByModel: Record<string, Behavior> = {
  'ocap-16k': 'ok',
  'ocap-200k': 'ok',
  'ocap-4k': 'lenstop',
  'ocap-reject': 'badreq',
  'nocap-a': 'ok',
  'ocap-claude': 'ok',
  'nocap-claude': 'ok',
  'ocap-sub8k': 'ok',
  'ocap-cheap1': 'lenstop',
  'ocap-cheapfail1': 'ratelimit',
  'ocap-strong1': 'ok',
  'ocap-default': 'ok',
  // record-route-legs: a capable head that fails retryably (so the deferred member
  // rescues it, clamped), and an insufficient head that is legally denied (a clamped
  // member that stops the walk).
  'ocap-200kfail': 'ratelimit',
  'ocap-4kstop': 'legal',
};

/** Every dispatched upstream call: the model, the maxOutputTokens the wire
 * would carry, and the adapter config's (possibly capped) synthesized default. */
const dispatched: { model: string; ask: number | undefined; defaultMax: number | undefined }[] = [];

function fakeAdapterFactory(config: ProviderConfig): ProviderAdapter {
  const chat = (req: NormalizedRequest): Promise<NormalizedResponse> => {
    dispatched.push({
      model: req.model,
      ask: req.params.maxOutputTokens,
      defaultMax: config.defaultMaxOutputTokens,
    });
    const b = behaviorByModel[req.model] ?? 'ok';
    if (b === 'badreq')
      return Promise.reject(new ProviderError('bad_request', 'max_tokens too large'));
    if (b === 'ratelimit') return Promise.reject(new ProviderError('rate_limit', 'slow down'));
    if (b === 'legal')
      return Promise.reject(new ProviderError('policy_block', 'legal denial', { status: 451 }));
    return Promise.resolve({
      id: 'stub-1',
      model: req.model,
      content: [{ type: 'text', text: 'stubbed answer' }],
      stopReason: b === 'lenstop' ? 'length' : 'stop',
    } as NormalizedResponse);
  };
  return {
    protocol: config.protocol,
    chat,
    chatStream: async function* () {
      throw new Error('streaming not scripted in this suite');
    },
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
  } as unknown as ProviderAdapter;
}

describe('output-cap guardrails e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let writer: LogWriter;
  let userId: string;
  let principal: Principal;
  let key: string;
  let openaiProviderId: string;
  const modelId: Record<string, string> = {};
  /** The `skip-t` members' own providers (record-route-legs). */
  const skipProviderIds: string[] = [];

  async function setBand(matchType: 'auto_high' | 'auto_low', tierKey: string): Promise<void> {
    for (const r of (await port.routingRules.list(principal)).filter(
      (r) => r.matchType === matchType,
    )) {
      await port.routingRules.remove(principal, r.id);
    }
    await port.routingRules.insert(principal, {
      matchType,
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: `tier:${tierKey}`,
      priority: 0,
    });
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    process.env['ROUTING_AUTO_LAYERS'] = 'structural,cascade';

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [SemanticModule, DatabaseModule, RecordingModule, RedisModule, ObservabilityModule],
      controllers: [ChatCompletionsController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        {
          // The subscription member resolves through this seam (kind='subscription'
          // + non-null creds); a benign token keeps the FAKE adapter buildable.
          provide: SubscriptionOauthService,
          useValue: {
            resolveCredential: () =>
              Promise.resolve({ credential: 'sub-token', authScheme: 'api_key' }),
            availableClientIdentity: () => null,
            identityBindingFor: () => undefined,
          },
        },
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
        { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
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
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    writer = app.get(LogWriter);

    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'oc', $1, true) RETURNING id`,
        [`ocap-${Date.now()}@oc.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);

    // Family-host providers (never dialed — the factory is fake). kind 'local'
    // keeps the credential path trivial for the two BYOK-shaped providers.
    const openai = await port.providers.insert(principal, {
      name: 'ocap-openai',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com',
    });
    openaiProviderId = openai.id;
    const anthropic = await port.providers.insert(principal, {
      name: 'ocap-anthropic',
      kind: 'local',
      protocol: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com',
    });
    const sub = await port.providers.insert(principal, {
      name: 'ocap-sub',
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com',
    });
    // Non-null creds route the subscription member through the oauth seam stub.
    await pool.query(`UPDATE provider SET encrypted_credentials = 'stub' WHERE id = $1`, [sub.id]);

    const add = async (providerId: string, ext: string): Promise<void> => {
      modelId[ext] = (await port.models.createForProvider(principal, providerId, {
        externalModelId: ext,
      }))!.id;
    };
    for (const ext of [
      'ocap-16k',
      'ocap-200k',
      'ocap-4k',
      'ocap-reject',
      'nocap-a',
      'ocap-cheap1',
      'ocap-cheapfail1',
      'ocap-strong1',
      'ocap-default',
    ]) {
      await add(openai.id, ext);
    }
    await add(anthropic.id, 'ocap-claude');
    await add(anthropic.id, 'nocap-claude');
    await add(sub.id, 'ocap-sub8k');
    // record-route-legs fixtures, on a provider of their own: they fail on purpose, and
    // a breaker is per provider, so they can never turn another test's call into a skip.
    const failing = await port.providers.insert(principal, {
      name: 'ocap-openai-failing',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com',
    });
    await add(failing.id, 'ocap-200kfail');
    await add(failing.id, 'ocap-4kstop');
    // …and two members each on its own provider, whose breakers one test opens.
    for (const ext of ['ocap-skip16k', 'ocap-skip200k']) {
      const own = await port.providers.insert(principal, {
        name: `${ext}-provider`,
        kind: 'local',
        protocol: 'openai_compatible',
        baseUrl: 'https://api.openai.com',
      });
      skipProviderIds.push(own.id);
      await add(own.id, ext);
    }
    // honest-model-capabilities fixtures.
    for (const ext of ['ocap-blind', 'ocap-sees', 'ocap-blind2', 'ocap-notools', 'ocap-silent']) {
      await add(openai.id, ext);
    }

    // Catalog caps (exact keys; 'nocap-*' models deliberately have NO rows).
    const seedCap = async (modelKey: string, maxOutputTokens: number): Promise<void> => {
      await port.pricing.insertVersion({
        modelKey,
        inputPricePer1m: 1,
        outputPricePer1m: 2,
        maxOutputTokens,
        source: 'manual',
        validFrom: new Date('2026-01-01T00:00:00Z'),
      });
    };
    await seedCap('openai:ocap-16k', 16_384);
    await seedCap('openai:ocap-200k', 200_000);
    await seedCap('openai:ocap-4k', 4_096);
    await seedCap('openai:ocap-reject', 16_384);
    await seedCap('openai:ocap-sub8k', 8_192);
    await seedCap('anthropic:ocap-claude', 2_048);
    await seedCap('openai:ocap-cheap1', 1);
    await seedCap('openai:ocap-cheapfail1', 1);
    await seedCap('openai:ocap-strong1', 1);
    await seedCap('openai:ocap-default', 200_000);
    await seedCap('openai:ocap-200kfail', 200_000);
    await seedCap('openai:ocap-4kstop', 4_096);
    await seedCap('openai:ocap-skip16k', 16_384);
    await seedCap('openai:ocap-skip200k', 200_000);

    // Capability rows (honest-model-capabilities). `cap-silent` deliberately gets
    // NO row, so the ladder answers unknown for it and it can never defer.
    const seedCaps = async (
      modelKey: string,
      flags: { supportsVision?: boolean; supportsTools?: boolean },
    ): Promise<void> => {
      await port.pricing.insertVersion({
        modelKey,
        inputPricePer1m: 1,
        outputPricePer1m: 2,
        ...flags,
        source: 'manual',
        validFrom: new Date('2026-01-01T00:00:00Z'),
      });
    };
    await seedCaps('openai:ocap-blind', { supportsVision: false });
    await seedCaps('openai:ocap-blind2', { supportsVision: false });
    await seedCaps('openai:ocap-sees', { supportsVision: true });
    await seedCaps('openai:ocap-notools', { supportsTools: false, supportsVision: true });

    await port.ensureDefaultTier(principal);
    const tiers = new Map((await port.tiers.list(principal)).map((t) => [t.key, t.id]));
    const tier = async (keyName: string): Promise<string> => {
      const existing = tiers.get(keyName);
      if (existing !== undefined) return existing;
      const t = await port.tiers.insert(principal, { key: keyName });
      tiers.set(keyName, t.id);
      return t.id;
    };
    const setTier = async (keyName: string, exts: string[]): Promise<void> => {
      await port.routingEntries.replaceForTier(
        principal,
        await tier(keyName),
        exts.map((e) => modelId[e]!),
      );
    };
    await setTier('default', ['ocap-default']);
    await setTier('defer-t', ['ocap-16k', 'ocap-200k']);
    await setTier('allins-t', ['ocap-4k', 'ocap-16k']);
    await setTier('unknown-t', ['nocap-a']);
    await setTier('anthro-t', ['ocap-claude']);
    await setTier('anthro-nocap-t', ['nocap-claude']);
    await setTier('sub-allins', ['ocap-sub8k', 'ocap-16k']);
    await setTier('sub-defer', ['ocap-sub8k', 'ocap-200k']);
    await setTier('casc-cheap', ['ocap-cheap1']);
    await setTier('casc-cheapfail', ['ocap-cheapfail1']);
    await setTier('casc-strong', ['ocap-strong1']);
    // record-route-legs: [A (cap 16384), B (cap 200000, fails 429)] → effective [B, A];
    // and [A (cap 4096, legally denied), B (cap 16384)] → all-insufficient, configured order.
    await setTier('rescue-t', ['ocap-16k', 'ocap-200kfail']);
    await setTier('stop-t', ['ocap-4kstop', 'ocap-16k']);
    await setTier('skip-t', ['ocap-skip16k', 'ocap-skip200k']);
    // honest-model-capabilities tiers: blind-first in every case, so a reorder is
    // the only way the capable member can serve.
    await setTier('cap-t', ['ocap-blind', 'ocap-sees']);
    await setTier('cap-allshort', ['ocap-blind', 'ocap-blind2']);
    await setTier('cap-unknown', ['ocap-silent', 'ocap-sees']);
    await setTier('cap-tools', ['ocap-notools', 'ocap-sees']);
    await setBand('auto_high', 'casc-strong');
    await setBand('auto_low', 'casc-cheap');

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
    // The catalog is GLOBAL — remove this suite's rows so reruns/siblings stay clean.
    await pool.query(`DELETE FROM model_price WHERE model_key LIKE '%:ocap-%'`);
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userId]);
    dispatched.length = 0;
  });

  const chat = async (body: Record<string, unknown>): Promise<request.Response> => {
    const res = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send(body);
    await writer.flush();
    return res;
  };
  const lastLog = async (): Promise<{
    modelId: string | null;
    status: string;
    decisionLayer: string;
    routingReason: string;
    escalated: boolean | null;
    durationMs: number;
    attemptFailures: AttemptFailureEntry[] | null;
    routeLegs: RouteLeg[] | null;
  }> => {
    const logs = await port.requestLogs.list(principal);
    return logs[logs.length - 1]! as never;
  };
  /** One expected route-record leg (record-route-legs); any `endedMs` matches. */
  const leg = (l: Omit<RouteLeg, 'endedMs'>): RouteLeg => ({
    ...l,
    endedMs: expect.any(Number) as number,
  });
  const msg = { messages: [{ role: 'user', content: 'hello' }] };

  // --- 5.1: deferral, clamp order, fence, unknown, no-ask, Anthropic default ---

  // --- honest-model-capabilities: capability deliverability ---

  /** A request carrying an image content block — the structural vision demand. */
  const visionMsg = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
        ],
      },
    ],
  };

  it('defers a model the catalog says cannot see, and the capable one serves', async () => {
    const res = await chat({ model: 'cap-t', ...visionMsg });
    expect(res.status).toBe(200);
    // cap-blind is configured FIRST; only the capability plan moves it.
    expect(dispatched.map((d) => d.model)).toEqual(['ocap-sees']);
    const row = await lastLog();
    expect(row.status).toBe('success'); // a deferral is not a failure
    expect(row.routingReason).toContain('capability_deferred ocap-blind(vision)');
    expect(row.routingReason).not.toContain('fell back'); // the trail stays empty
    // record-route-legs: the same deferral, as structure — the member's effective index,
    // its model and the capability it lacks; a capability-only deferral records no ask.
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'served',
        servedIndex: 0,
        deferred: [
          { index: 1, model: 'ocap-blind', reason: 'capability', capabilities: ['vision'] },
        ],
      }),
    ]);
    expect(row.attemptFailures).toBeNull(); // a deferral never enters the trail
    // The reason is byte-identical to before: the record rides beside it, never in it.
    expect(row.routingReason).toBe('explicit tier cap-t; capability_deferred ocap-blind(vision)');
  });

  // record-route-legs (request-logging "Deferrals, clamps and the ask are recorded per
  // leg"): the ask rides a leg exactly when an output-cap fact does. Here the request
  // asks for output, but neither member's cap is known, so the only fact is the
  // capability deferral — and the record carries no ask.
  it('a capability-only deferral records no ask, even when the request asks for output', async () => {
    const res = await chat({ model: 'cap-t', max_completion_tokens: 1_000, ...visionMsg });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([{ model: 'ocap-sees', ask: 1_000, defaultMax: 4096 }]);
    const row = await lastLog();
    expect(row.routingReason).toBe('explicit tier cap-t; capability_deferred ocap-blind(vision)');
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'served',
        servedIndex: 0,
        deferred: [
          { index: 1, model: 'ocap-blind', reason: 'capability', capabilities: ['vision'] },
        ],
      }),
    ]);
  });

  it('routes a text-only request byte-identically — no demand, no reorder', async () => {
    const res = await chat({ model: 'cap-t', ...msg });
    expect(res.status).toBe(200);
    expect(dispatched.map((d) => d.model)).toEqual(['ocap-blind']); // configured order
    const row = await lastLog();
    expect(row.routingReason).not.toContain('capability_deferred');
    // record-route-legs: no demand, no deferral — the record carries none either.
    expect(row.routeLegs).toEqual([leg({ leg: 'primary', end: 'served', servedIndex: 0 })]);
  });

  it('leaves an UNKNOWN model in place — silence is not a denial', async () => {
    const res = await chat({ model: 'cap-unknown', ...visionMsg });
    expect(res.status).toBe(200);
    // cap-silent has no catalog row at all, so it keeps its configured position.
    expect(dispatched.map((d) => d.model)).toEqual(['ocap-silent']);
    expect((await lastLog()).routingReason).not.toContain('capability_deferred');
  });

  it('still dispatches an all-short chain, in configured order', async () => {
    const res = await chat({ model: 'cap-allshort', ...visionMsg });
    expect(res.status).toBe(200);
    // Capability never refuses a request before dispatch and never shortens a
    // chain: the leading group is simply empty (invariant 1).
    expect(dispatched.map((d) => d.model)).toEqual(['ocap-blind']);
    expect((await lastLog()).routingReason).not.toContain('capability_deferred');
  });

  it('demands tools independently of vision', async () => {
    const res = await chat({
      model: 'cap-tools',
      ...msg,
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    });
    expect(res.status).toBe(200);
    expect(dispatched.map((d) => d.model)).toEqual(['ocap-sees']);
    const row = await lastLog();
    expect(row.routingReason).toContain('capability_deferred ocap-notools(tools)');
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'served',
        servedIndex: 0,
        deferred: [
          { index: 1, model: 'ocap-notools', reason: 'capability', capabilities: ['tools'] },
        ],
      }),
    ]);
    expect(row.routingReason).toBe(
      'explicit tier cap-tools; capability_deferred ocap-notools(tools)',
    );
  });

  it('client-named fence: a named model is dispatched unchanged, capability notwithstanding', async () => {
    const res = await chat({ model: `${openaiProviderId}:ocap-blind`, ...visionMsg });
    expect(res.status).toBe(200);
    // The client named the model; provider parity governs, so no reorder and no
    // reason — there is no router choice to explain.
    expect(dispatched.map((d) => d.model)).toEqual(['ocap-blind']);
    expect((await lastLog()).routingReason).not.toContain('capability_deferred');
  });

  it('defers the insufficient member: the capable one serves verbatim, success, reason-only', async () => {
    const res = await chat({ model: 'defer-t', max_completion_tokens: 100_000, ...msg });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([{ model: 'ocap-200k', ask: 100_000, defaultMax: 4096 }]);
    const row = await lastLog();
    expect(row.modelId).toBe(modelId['ocap-200k']);
    expect(row.status).toBe('success'); // a deferral is not a failure
    expect(row.routingReason).toContain('output_cap_deferred ocap-16k(16384<100000)');
    expect(row.routingReason).not.toContain('fell back'); // empty trail
    // record-route-legs: the deferral as structure, with the ask; no clamp, because the
    // deferred member was never dispatched.
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'served',
        servedIndex: 0,
        ask: 100_000,
        deferred: [{ index: 1, model: 'ocap-16k', reason: 'output_cap', cap: 16_384 }],
      }),
    ]);
    // The reason is byte-identical to before: the record rides beside it, never in it.
    expect(row.routingReason).toBe(
      'explicit tier defer-t; output_cap_deferred ocap-16k(16384<100000)',
    );
  });

  it('an all-insufficient tier serves clamped in CONFIGURED order with an honest length finish', async () => {
    const res = await chat({ model: 'allins-t', max_completion_tokens: 100_000, ...msg });
    expect(res.status).toBe(200);
    // ocap-4k is configured FIRST and stays first (no cap-descending reorder).
    expect(dispatched).toEqual([{ model: 'ocap-4k', ask: 4_096, defaultMax: 4096 }]);
    expect(res.body.choices[0].finish_reason).toBe('length'); // truncation is honest, never an error
    const row = await lastLog();
    expect(row.status).toBe('success');
    expect(row.routingReason).toContain('output_cap_clamped 100000→4096 (ocap-4k)');
    expect(row.routingReason).not.toContain('output_cap_deferred'); // empty head = clamps only
    // record-route-legs: the clamp as structure, with the ask; no deferral.
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'served',
        servedIndex: 0,
        ask: 100_000,
        clamps: [{ index: 0, model: 'ocap-4k', to: 4_096 }],
      }),
    ]);
    expect(row.routingReason).toBe(
      'explicit tier allins-t; output_cap_clamped 100000→4096 (ocap-4k)',
    );
  });

  // record-route-legs (fallback-routing "A deferral and a clamp are recorded as structure
  // beside the reason"): [A (cap 16384), B (cap 200000)], ask 100000 → effective
  // [B, A-clamped]; B fails retryably and A serves clamped. One row carries both facts.
  it('a deferred member that rescues the head records its deferral, its clamp and the ask', async () => {
    const res = await chat({ model: 'rescue-t', max_completion_tokens: 100_000, ...msg });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([
      { model: 'ocap-200kfail', ask: 100_000, defaultMax: 4096 },
      { model: 'ocap-16k', ask: 16_384, defaultMax: 4096 },
    ]);
    const row = await lastLog();
    expect(row.status).toBe('fallback');
    expect(row.modelId).toBe(modelId['ocap-16k']);
    expect(row.routingReason).toContain('output_cap_deferred ocap-16k(16384<100000)');
    expect(row.routingReason).toContain('output_cap_clamped 100000→16384 (ocap-16k)');
    expect(row.routingReason).toBe(
      'explicit tier rescue-t; fell back after: rate_limit@ocap-200kfail; ' +
        'output_cap_deferred ocap-16k(16384<100000); output_cap_clamped 100000→16384 (ocap-16k)',
    );
    // The same index space as the trail: B's failure at 0, A's deferral and clamp at 1.
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'served',
        servedIndex: 1,
        ask: 100_000,
        deferred: [{ index: 1, model: 'ocap-16k', reason: 'output_cap', cap: 16_384 }],
        clamps: [{ index: 1, model: 'ocap-16k', to: 16_384 }],
      }),
    ]);
    // Neither enters the failure trail: B's retryable failure is its only entry.
    expect(row.attemptFailures).toHaveLength(1);
    expect(row.attemptFailures![0]).toMatchObject({
      index: 0,
      model: 'ocap-200kfail',
      kind: 'rate_limit',
      dispatched: true,
    });
  });

  // record-route-legs (fallback-routing "A clamped member that stopped the walk records
  // its clamp"): the one deliberate reason-string change on these rows — before this
  // change a sent stopper's clamp was missing from the capacity note (an accepted
  // under-record); the note and the record now read one dispatched set.
  it('a clamped member that stops the walk records its clamp in the reason and the record', async () => {
    const res = await chat({ model: 'stop-t', max_completion_tokens: 100_000, ...msg });
    expect(res.status).toBe(451);
    expect(dispatched).toEqual([{ model: 'ocap-4kstop', ask: 4_096, defaultMax: 4096 }]); // B never reached
    const row = await lastLog();
    expect(row.status).toBe('error');
    expect(row.modelId).toBe(modelId['ocap-4kstop']);
    expect(row.routingReason).toContain('output_cap_clamped 100000→4096 (ocap-4kstop)');
    expect(row.routingReason).not.toContain('ocap-16k'); // never reached: no clamp in either
    expect(row.routingReason).toBe(
      'explicit tier stop-t; output_cap_clamped 100000→4096 (ocap-4kstop)',
    );
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'stopped',
        stopped: { index: 0, model: 'ocap-4kstop', sent: true, kind: 'policy_block', status: 451 },
        ask: 100_000,
        clamps: [{ index: 0, model: 'ocap-4kstop', to: 4_096 }],
      }),
    ]);
    expect(row.attemptFailures).toBeNull(); // a non-retryable stop never enters the trail
  });

  // record-route-legs (fallback-routing "A leg whose every member was skipped records no
  // deferral"): [A (cap 16384), B (cap 200000)], ask 100000, both providers' breakers
  // open. The chain dispatched nothing, so it contributes no deferral — a reason-string
  // change: before this change the note named A's deferral on a walk that sent nothing.
  it('a leg whose every member was skipped records no deferral, in the reason or the record', async () => {
    const breaker = app.get<CircuitBreaker>(PROXY_BREAKER);
    for (const providerId of skipProviderIds) {
      for (let i = 0; i < 5; i += 1) {
        const { token } = await breaker.before(providerId);
        await breaker.complete(token, 'trip');
      }
    }
    const res = await chat({ model: 'skip-t', max_completion_tokens: 100_000, ...msg });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(dispatched).toEqual([]); // nothing reached an adapter
    const row = await lastLog();
    expect(row.status).toBe('error');
    expect(row.routingReason).toBe(
      'explicit tier skip-t; fell back after: skip@ocap-skip200k, skip@ocap-skip16k',
    );
    expect(row.routeLegs).toEqual([leg({ leg: 'primary', end: 'exhausted' })]); // no ask either
    // The trail still holds both skipped members, never dispatched, in effective order.
    expect(row.attemptFailures).toHaveLength(2);
    expect(row.attemptFailures!.map((e) => [e.index, e.model, e.dispatched])).toEqual([
      [0, 'ocap-skip200k', false],
      [1, 'ocap-skip16k', false],
    ]);
  });

  it('client-named fence: the value reaches the provider verbatim and a rejection surfaces sanitized', async () => {
    const ok = await chat({
      model: `${openaiProviderId}:ocap-16k`,
      max_completion_tokens: 100_000,
      ...msg,
    });
    expect(ok.status).toBe(200);
    expect(dispatched).toEqual([{ model: 'ocap-16k', ask: 100_000, defaultMax: 4096 }]); // VERBATIM
    expect((await lastLog()).routingReason).not.toContain('output_cap');

    dispatched.length = 0;
    const rejected = await chat({
      model: `${openaiProviderId}:ocap-reject`,
      max_completion_tokens: 100_000,
      ...msg,
    });
    expect(rejected.status).toBe(400); // the provider's own rejection, through the error envelope
    expect(dispatched).toEqual([{ model: 'ocap-reject', ask: 100_000, defaultMax: 4096 }]);
    expect((await lastLog()).routingReason).not.toContain('output_cap');
  });

  it('an all-unknown chain and a no-ask request route byte-identically to today', async () => {
    await chat({ model: 'unknown-t', max_completion_tokens: 100_000, ...msg });
    expect(dispatched).toEqual([{ model: 'nocap-a', ask: 100_000, defaultMax: 4096 }]); // verbatim
    const unknown = await lastLog();
    expect(unknown.routingReason).not.toContain('output_cap');
    // record-route-legs: no output-cap fact, so no ask, deferral or clamp is recorded.
    expect(unknown.routeLegs).toEqual([leg({ leg: 'primary', end: 'served', servedIndex: 0 })]);

    dispatched.length = 0;
    await chat({ model: 'defer-t', ...msg }); // no ask → configured order, no planning
    expect(dispatched).toEqual([{ model: 'ocap-16k', ask: undefined, defaultMax: 4096 }]);
    expect((await lastLog()).routingReason).not.toContain('output_cap');
  });

  it('the synthesized Anthropic default is capped to a smaller known cap; unknown keeps the default', async () => {
    await chat({ model: 'anthro-t', ...msg }); // no ask → the adapter default matters
    expect(dispatched).toEqual([{ model: 'ocap-claude', ask: undefined, defaultMax: 2_048 }]); // min(4096, 2048)

    dispatched.length = 0;
    await chat({ model: 'anthro-nocap-t', ...msg });
    expect(dispatched).toEqual([{ model: 'nocap-claude', ask: undefined, defaultMax: 4_096 }]); // unknown → unchanged
  });

  // --- 5.3: subscription ordering ---

  it('sub-first all-insufficient: quota is still spent before paid (configured-order tail)', async () => {
    const res = await chat({ model: 'sub-allins', max_completion_tokens: 100_000, ...msg });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([{ model: 'ocap-sub8k', ask: 8_192, defaultMax: 4096 }]);
    const row = await lastLog();
    expect(row.routingReason).toContain('output_cap_clamped 100000→8192 (ocap-sub8k)');
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'served',
        servedIndex: 0,
        ask: 100_000,
        clamps: [{ index: 0, model: 'ocap-sub8k', to: 8_192 }],
      }),
    ]);
    expect(row.routingReason).toBe(
      'explicit tier sub-allins; output_cap_clamped 100000→8192 (ocap-sub8k)',
    );
  });

  it('a capable paid member serves the full ask; the small-cap subscription member defers (disclosed inversion)', async () => {
    const res = await chat({ model: 'sub-defer', max_completion_tokens: 100_000, ...msg });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([{ model: 'ocap-200k', ask: 100_000, defaultMax: 4096 }]);
    const row = await lastLog();
    expect(row.routingReason).toContain('output_cap_deferred ocap-sub8k(8192<100000)');
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'primary',
        end: 'served',
        servedIndex: 0,
        ask: 100_000,
        deferred: [{ index: 1, model: 'ocap-sub8k', reason: 'output_cap', cap: 8_192 }],
      }),
    ]);
    expect(row.routingReason).toBe(
      'explicit tier sub-defer; output_cap_deferred ocap-sub8k(8192<100000)',
    );
  });

  // --- 5.2: cascade composition (ambiguous auto; tiny ask so L1 stays ambiguous) ---

  /** An AMBIGUOUS `auto` request (the cascade e2e's calibrated shape) with a
   * TINY ask (2) so the maxOutputTokens demand feature cannot move the band —
   * caps of 1 still make members known-insufficient. */
  const autoBody = (system: string): Record<string, unknown> => ({
    model: 'auto',
    max_completion_tokens: 2,
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
  });

  it('a clamp-served cheap answer flows through the unchanged quality contract (length → 0.5 → served)', async () => {
    await setBand('auto_low', 'casc-cheap');
    const res = await chat(autoBody(`uniq-${Date.now()}-a`));
    expect(res.status).toBe(200);
    // clamped cheap dispatch; the config default is also min(4096, cap)=1 (inert on this protocol)
    expect(dispatched).toEqual([{ model: 'ocap-cheap1', ask: 1, defaultMax: 1 }]);
    const row = await lastLog();
    expect(row.escalated).toBe(false); // length-only truncation scores 0.5 — served at the default threshold
    expect(row.routingReason).toContain('cheap[output_cap_clamped 2→1 (ocap-cheap1)]');
    expect(row.routingReason).not.toContain('esc['); // the never-walked escalation contributes nothing
    // record-route-legs: the kept cheap leg carries its clamp and the ask; no escalation leg.
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'cheap',
        end: 'served',
        servedIndex: 0,
        ask: 2,
        clamps: [{ index: 0, model: 'ocap-cheap1', to: 1 }],
      }),
    ]);
    // Byte-identical up to the quality marker (the structural features follow it).
    expect(row.routingReason.split(' (q=')[0]).toBe(
      'cascade: cheap served; cheap[output_cap_clamped 2→1 (ocap-cheap1)]',
    );
  });

  it('escalation plans the CONCATENATED chain: the capable default precedes the insufficient strong, and the superseded cheap clamp stays on the record', async () => {
    await setBand('auto_low', 'casc-cheapfail');
    const res = await chat(autoBody(`uniq-${Date.now()}-b`));
    expect(res.status).toBe(200);
    // cheap dispatched clamped (failed retryably) → escalation walks [default(200k), strong(1)-clamped]:
    // the capable default serves FIRST with NO strong failure required.
    expect(dispatched).toEqual([
      { model: 'ocap-cheapfail1', ask: 1, defaultMax: 1 },
      { model: 'ocap-default', ask: 2, defaultMax: 4096 },
    ]);
    const row = await lastLog();
    expect(row.escalated).toBe(true);
    expect(row.modelId).toBe(modelId['ocap-default']);
    expect(row.routingReason).toContain('cheap[output_cap_clamped 2→1 (ocap-cheapfail1)]'); // superseded, kept
    expect(row.routingReason).toContain('esc[output_cap_deferred ocap-strong1(1<2)]');
    // Byte-identical up to the quality marker (the structural features follow it).
    expect(row.routingReason.split(' (q=')[0]).toBe(
      'cascade: escalated cheap→default; cheap[output_cap_clamped 2→1 (ocap-cheapfail1)]; ' +
        'esc[output_cap_deferred ocap-strong1(1<2)]',
    );
    // record-route-legs: each leg's facts on its own leg, in the leg's effective order —
    // the exhausted cheap leg's clamp, then the escalation leg's deferral of the strong
    // member behind the capable default (never dispatched, so no clamp for it).
    expect(row.routeLegs).toEqual([
      leg({
        leg: 'cheap',
        end: 'exhausted',
        ask: 2,
        clamps: [{ index: 0, model: 'ocap-cheapfail1', to: 1 }],
      }),
      leg({
        leg: 'escalation',
        end: 'served',
        servedIndex: 0,
        ask: 2,
        deferred: [{ index: 1, model: 'ocap-strong1', reason: 'output_cap', cap: 1 }],
      }),
    ]);
  });

  // --- add-workload-routing: a workload claim is planned like any other head ---

  describe('workload targets under output-cap planning', () => {
    /** ≥200 fenced chars at ~100% share → the structural `code` class. */
    const codeMsg = {
      messages: [{ role: 'user', content: '```ts\n' + 'const x = 1;\n'.repeat(40) + '```' }],
    };
    async function withWorkloadRule(target: string, fn: () => Promise<void>): Promise<void> {
      const rule = await port.routingRules.insert(principal, {
        matchType: 'auto_workload',
        headerName: 'x-polyrouter-tier',
        headerValue: null,
        workloadClass: 'code',
        target,
        priority: 0,
      });
      try {
        await fn();
      } finally {
        await port.routingRules.remove(principal, rule.id);
      }
    }

    it('a tier: workload target defers its insufficient member behind the workload: head', async () => {
      await withWorkloadRule('tier:defer-t', async () => {
        const res = await chat({ model: 'auto', max_completion_tokens: 100_000, ...codeMsg });
        expect(res.status).toBe(200);
        expect(dispatched).toEqual([{ model: 'ocap-200k', ask: 100_000, defaultMax: 4096 }]);
        const row = await lastLog();
        expect(row.decisionLayer).toBe('workload');
        expect(row.modelId).toBe(modelId['ocap-200k']);
        expect(row.status).toBe('success');
        expect(row.routingReason).toMatch(/^workload:code/);
        expect(row.routingReason).toContain('output_cap_deferred ocap-16k(16384<100000)');
        // record-route-legs: a workload-routed row records its walk like any other.
        expect(row.routeLegs).toEqual([
          leg({
            leg: 'primary',
            end: 'served',
            servedIndex: 0,
            ask: 100_000,
            deferred: [{ index: 1, model: 'ocap-16k', reason: 'output_cap', cap: 16_384 }],
          }),
        ]);
      });
    });

    it('a model: workload target clamps the ask behind the workload: head', async () => {
      await withWorkloadRule(`model:${modelId['ocap-4k']}`, async () => {
        const res = await chat({ model: 'auto', max_completion_tokens: 100_000, ...codeMsg });
        expect(res.status).toBe(200);
        expect(dispatched).toEqual([{ model: 'ocap-4k', ask: 4_096, defaultMax: 4096 }]);
        const row = await lastLog();
        expect(row.decisionLayer).toBe('workload');
        expect(row.modelId).toBe(modelId['ocap-4k']);
        expect(row.routingReason).toMatch(/^workload:code/);
        expect(row.routingReason).toContain('output_cap_clamped 100000→4096 (ocap-4k)');
      });
    });

    it('a failing primary in a workload tier falls back, the trail recorded behind the workload: head', async () => {
      const wlFail = await port.tiers.insert(principal, { key: 'wl-fail' });
      await port.routingEntries.replaceForTier(principal, wlFail.id, [
        modelId['ocap-cheapfail1']!,
        modelId['ocap-200k']!,
      ]);
      await withWorkloadRule('tier:wl-fail', async () => {
        const res = await chat({ model: 'auto', ...codeMsg }); // no ask → no deferral/clamp
        expect(res.status).toBe(200);
        expect(dispatched.map((d) => d.model)).toEqual(['ocap-cheapfail1', 'ocap-200k']);
        const row = await lastLog();
        expect(row.decisionLayer).toBe('workload');
        expect(row.modelId).toBe(modelId['ocap-200k']);
        expect(row.status).toBe('fallback');
        expect(row.routingReason).toMatch(/^workload:code/);
        expect(row.routingReason).toContain('fell back');
      });
    });
  });
});
