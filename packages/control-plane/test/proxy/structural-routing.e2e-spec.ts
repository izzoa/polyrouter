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
import { StructuralBaselineStore } from '../../src/proxy/structural/structural-baseline.store';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { WorkloadRouter } from '../../src/proxy/workload/workload-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { RecordingModule } from '../../src/recording/recording.module';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { LogWriter } from '../../src/recording/log-writer';
import { PricingModule } from '../../src/pricing/pricing.module';
import { DatabaseModule } from '../../src/database/database.module';
import { SemanticModule } from '../../src/semantic/semantic.module';
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
    imports: [
      SemanticModule,
      DatabaseModule,
      PricingModule,
      RecordingModule,
      RedisModule,
      ObservabilityModule,
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
          resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')),
        },
      },
      StreamDrainRegistry,
      StructuralRouter,
      WorkloadRouter,
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
    structuralBand: string | null;
    structuralScore: number | null;
    structuralBandSource: string | null;
    structuralEpoch: number | null;
    workloadClass: string | null;
    workloadScore: number | null;
    workloadSource: string | null;
    workloadRevision: string | null;
  }> {
    const logs = await port.requestLogs.list(principal);
    return logs[logs.length - 1]!;
  }
  const REV = /^structural\/v1\/c1\/[0-9a-f]{12}$/;

  it('steers a complex auto request to the auto_high tier (decision_layer=structural)', async () => {
    await send(body({ system: 'sysA', userChars: 9_000, code: true, tools: 8 }));
    const row = await lastLog();
    expect(row.modelId).toBe(idPremium);
    expect(row.decisionLayer).toBe('structural');
    expect(row.routingReason).toContain('structural:high');
    // Decision telemetry (add-auto-decision-telemetry): the verdict as columns.
    expect(row.structuralBand).toBe('high');
    expect(row.structuralBandSource).toBe('threshold');
    expect(row.structuralScore).toBeGreaterThanOrEqual(0.6);
    expect(JSON.stringify(row)).not.toContain('Z'.repeat(50)); // metadata only — no prompt body
    // Workload telemetry (add-workload-telemetry): 5k fenced chars over ~14k
    // window chars → share ≈ 0.36 ≥ 0.30 → `code`, source structural, pinned revision.
    expect(row.workloadClass).toBe('code');
    expect(row.workloadSource).toBe('structural');
    expect(row.workloadRevision).toMatch(REV);
    expect(row.workloadScore).toBeGreaterThanOrEqual(0.3);
    expect(row.workloadScore).toBeLessThanOrEqual(1);
  });

  it('an ambiguous fall-through records the verdict it used to discard (add-auto-decision-telemetry)', async () => {
    // Middling: size-only signal → ambiguous; cascade is not enabled in this
    // suite, so the Layer-0 default stands — with the verdict now recorded.
    await send(body({ system: 'sysAmb', userChars: 9_000 }));
    const row = await lastLog();
    expect(row.decisionLayer).toBe('default');
    expect(row.modelId).toBe(idDefault);
    expect(row.structuralBand).toBe('ambiguous');
    expect(row.structuralBandSource).toBe('threshold');
    expect(row.structuralScore).not.toBeNull();
    expect(row.routingReason).toContain('; structural:ambiguous'); // the suffix
    // add-workload-telemetry: the ambiguous fall-through carries the quad (none).
    expect(row.workloadClass).toBe('none');
    expect(row.workloadScore).toBe(0);
    expect(row.workloadSource).toBe('structural');
    expect(row.workloadRevision).toMatch(REV);
    expect(row.routingReason).not.toContain('workload'); // D5: the reason string is untouched
  });

  it('an unroutable confident band records its verdict (add-auto-decision-telemetry)', async () => {
    // Remove the auto_low rule: a trivial request classifies LOW confidently but
    // has no target — previously a silent skip, now corpus data.
    const rules = await port.routingRules.list(principal);
    const low = rules.find((r) => r.matchType === 'auto_low')!;
    await port.routingRules.remove(principal, low.id);
    try {
      await send(body({ system: 'sysUnr', userChars: 3 }));
      const row = await lastLog();
      expect(row.decisionLayer).toBe('default');
      expect(row.structuralBand).toBe('low');
      expect(row.structuralBandSource).toBe('threshold');
      expect(row.routingReason).toContain('; structural:low');
      expect(row.workloadClass).toBe('none'); // add-workload-telemetry: unroutable rows carry the quad
      expect(row.workloadRevision).toMatch(REV);
    } finally {
      await port.routingRules.insert(principal, {
        matchType: 'auto_low',
        headerName: 'x-polyrouter-tier',
        headerValue: null,
        target: 'tier:cheap',
        priority: 0,
      });
    }
  });

  it('a declared-max row records the declared band source (add-auto-decision-telemetry)', async () => {
    await send({
      model: 'auto',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'yo' }],
    });
    const row = await lastLog();
    expect(row.structuralBand).toBe('high');
    expect(row.structuralBandSource).toBe('declared');
    expect(row.workloadClass).toBe('none'); // declared-max rows carry the quad too
  });

  it('steers a trivial auto request to the auto_low tier', async () => {
    await send(body({ system: 'sysB', userChars: 3 }));
    const row = await lastLog();
    expect(row.modelId).toBe(idCheap);
    expect(row.decisionLayer).toBe('structural');
  });

  it('a declared reasoning_effort high steers a tiny request to auto_high (add-auto-hint-features)', async () => {
    await send({
      model: 'auto',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const row = await lastLog();
    expect(row.modelId).toBe(idPremium);
    expect(row.decisionLayer).toBe('structural');
    expect(row.routingReason).toContain('declared=max');
  });

  it('language neutrality holds with a hint: EQUAL structural vectors in two languages score identically (add-auto-hint-features)', async () => {
    const enText = 'summarize it briefly'; // 20 chars
    const jaText = '簡潔に要約してください、どうか宜しく願う'; // 20 UTF-16 code units — equal size signal
    expect(jaText.length).toBe(enText.length);
    await send({
      model: 'auto',
      reasoning_effort: 'minimal',
      messages: [{ role: 'user', content: enText }],
    });
    const en = await lastLog();
    await send({
      model: 'auto',
      reasoning_effort: 'minimal',
      messages: [{ role: 'user', content: jaText }],
    });
    const ja = await lastLog();
    expect(ja.modelId).toBe(en.modelId);
    const scoreOf = (reason: string): string => /score=([0-9.]+)/.exec(reason)![1]!;
    expect(scoreOf(ja.routingReason)).toBe(scoreOf(en.routingReason)); // identical vectors → identical score
    expect(ja.routingReason).toContain('think=0.25');
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

  it('a non-auto request and a header-forced auto request record null telemetry', async () => {
    await send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    const explicit = await lastLog();
    expect(explicit.structuralBand).toBeNull();
    expect(explicit.structuralScore).toBeNull();
    expect(explicit.structuralBandSource).toBeNull();
    expect(explicit.workloadClass).toBeNull(); // add-workload-telemetry: never classified
    expect(explicit.workloadScore).toBeNull();
    expect(explicit.workloadSource).toBeNull();
    expect(explicit.workloadRevision).toBeNull();
    await send(body({ system: 'sysHdr', userChars: 3 }), 'premium');
    const header = await lastLog();
    expect(header.structuralBand).toBeNull(); // Layer 0 won — evaluate never ran
    expect(header.structuralScore).toBeNull();
    expect(header.structuralBandSource).toBeNull();
    expect(header.workloadClass).toBeNull();
    expect(header.workloadRevision).toBeNull();
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
    const disabledRow = await lastLog();
    expect(disabledRow.structuralBand).toBeNull(); // layer off — no fabricated telemetry
    expect(disabledRow.structuralScore).toBeNull();
    expect(disabledRow.structuralBandSource).toBeNull();
    expect(disabledRow.workloadClass).toBeNull(); // add-workload-telemetry: rides L1; off → null
    expect(disabledRow.workloadSource).toBeNull();
  });

  // ── add-workload-telemetry (W-1) ─────────────────────────────────────────

  it('workload: an image request records vision; a declared JSON output format records structured; the reason stays untouched', async () => {
    await send({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
    });
    const vision = await lastLog();
    expect(vision.workloadClass).toBe('vision');
    expect(vision.workloadScore).toBe(1);
    expect(vision.workloadSource).toBe('structural');
    expect(vision.workloadRevision).toMatch(REV);
    expect(vision.routingReason).not.toContain('workload');

    await pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userId]); // lastLog() reads one row
    await send({
      model: 'auto',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'give me json' }],
    });
    const structured = await lastLog();
    expect(structured.workloadClass).toBe('structured');
    expect(structured.workloadScore).toBe(1);
    expect(structured.workloadSource).toBe('structural');
  });

  it('workload: an auto request selected via a configured default RULE is evaluated and records the quad', async () => {
    const rule = await port.routingRules.insert(principal, {
      matchType: 'default',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:premium',
      priority: 0,
    });
    try {
      await send(body({ system: 'sysDefaultRule', userChars: 9_000 })); // ambiguous → the rule's target stands
      const row = await lastLog();
      expect(row.decisionLayer).toBe('default');
      expect(row.modelId).toBe(idPremium);
      expect(row.structuralBand).toBe('ambiguous');
      expect(row.workloadClass).toBe('none');
      expect(row.workloadRevision).toMatch(REV);
    } finally {
      await port.routingRules.remove(principal, rule.id);
    }
  });

  it('workload: invariant 8 — sentinels in messages, system, and a tool schema reach no column, revision, reason, or log line', async () => {
    const SENTINELS = [
      'SENTINEL_SYS_9f3a',
      'SENTINEL_USER_7c1d',
      'SENTINEL_TOOL_4b2e',
      'SENTINEL_DESC_0e8d',
      'SENTINEL_PROP_5a6b',
    ];
    const lines: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const cap = ((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const spies = (['log', 'warn', 'error', 'debug', 'info'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
      }),
    );
    process.stdout.write = cap;
    process.stderr.write = cap;
    try {
      await send({
        model: 'auto',
        messages: [
          { role: 'system', content: 'SENTINEL_SYS_9f3a ' + 'S'.repeat(200) },
          { role: 'user', content: 'SENTINEL_USER_7c1d ' + 'U'.repeat(400) },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'SENTINEL_TOOL_4b2e',
              description: 'SENTINEL_DESC_0e8d',
              parameters: {
                type: 'object',
                properties: { SENTINEL_PROP_5a6b: { type: 'string' } },
              },
            },
          },
        ],
      });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      spies.forEach((sp) => sp.mockRestore());
    }
    const row = await lastLog();
    expect(row.workloadClass).not.toBeNull(); // evaluated
    const blob = JSON.stringify(row) + '\n' + lines.join('\n');
    for (const sentinel of SENTINELS) expect(blob).not.toContain(sentinel);
    expect(row.workloadRevision).toMatch(REV); // configuration-only stamp
  });

  it('workload: a pre-admission refusal (evaluated, then an empty final bundle) writes no row and fabricates no telemetry', async () => {
    const before = (await port.requestLogs.list(principal)).length;
    // The default decision resolves and Layer 1 evaluates; bundle
    // materialization then yields NO usable member (the only provider vanished
    // between evaluation and the bundle build — simulated one-shot at the seam,
    // since the snapshot and the bundle build share one prepare() call) → the
    // existing 503 refusal before admission. No Prepared, no recorder, no row.
    const svc = app.get(ProxyService);
    const spy = jest
      .spyOn(svc as unknown as { buildBundle: () => Promise<unknown> }, 'buildBundle')
      .mockResolvedValueOnce({ attempts: [], meta: [] });
    try {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send(body({ system: 'sysRefuse', userChars: 9_000 }));
      expect(res.status).toBe(503);
      expect(spy).toHaveBeenCalledTimes(1);
      await writer.flush();
      expect((await port.requestLogs.list(principal)).length).toBe(before); // no row — nothing fabricated
    } finally {
      spy.mockRestore();
    }
    // The same request with the seam restored serves and records the quad.
    await send(body({ system: 'sysRefuse', userChars: 9_000 }));
    expect((await lastLog()).workloadClass).toBe('none');
  });

  // ── Workload routing (add-workload-routing) ───────────────────────────────

  /** Bind ONE workload class to `tier:<key>` for the duration of `fn` — the
   * rule is removed afterwards so every other scenario sees today's config. */
  // lastLog() reads ONE row — clear between sends inside a scenario.
  const clearLogs = (): Promise<unknown> =>
    pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userId]);
  async function withWorkloadRule(
    cls: string,
    target: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    await clearLogs();
    const rule = await port.routingRules.insert(principal, {
      matchType: 'auto_workload',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      workloadClass: cls,
      target,
      priority: 0,
    });
    try {
      await fn();
    } finally {
      await port.routingRules.remove(principal, rule.id);
    }
  }

  it('workload routing: a code request is CLAIMED by the auto_workload code rule before the band target (decision_layer=workload)', async () => {
    // The coding tier points at the CHEAP model while the structural band is
    // HIGH (→ premium): a claim is visible as cheap-with-a-high-band.
    const coding = await port.tiers.insert(principal, { key: 'coding' });
    await port.routingEntries.replaceForTier(principal, coding.id, [idCheap]);
    try {
      await withWorkloadRule('code', 'tier:coding', async () => {
        await send(body({ system: 'sysClaim', userChars: 9_000, code: true, tools: 8 }));
        const row = await lastLog();
        expect(row.decisionLayer).toBe('workload');
        expect(row.modelId).toBe(idCheap); // the claim's target, NOT the auto_high premium
        // The reason is the verdict fragment — never a prompt byte.
        expect(row.routingReason).toMatch(/^workload:code/);
        expect(row.routingReason).not.toContain('structural:');
        // Telemetry: BOTH verdicts from the one classification — the band is
        // classified (columns intact) even though its target was never consulted.
        expect(row.structuralBand).toBe('high');
        expect(row.structuralScore).toBeGreaterThanOrEqual(0.6);
        expect(row.structuralEpoch).not.toBeNull(); // the calibration epoch commits with the quad
        expect(row.workloadClass).toBe('code');
        expect(row.workloadSource).toBe('structural');
        expect(row.workloadRevision).toMatch(REV);
      });
      // The rule gone → the same SHAPE of request (a fresh system prompt, so
      // the per-agent baseline learned above does not de-escalate it) rides
      // the band to premium again (unchanged W-1 behavior).
      await clearLogs();
      await send(body({ system: 'sysClaimAfter', userChars: 9_000, code: true, tools: 8 }));
      const after = await lastLog();
      expect(after.decisionLayer).toBe('structural');
      expect(after.modelId).toBe(idPremium);
      expect(after.workloadClass).toBe('code');
    } finally {
      await port.tiers.remove(principal, coding.id);
    }
  });

  it('workload routing: Layer 0 (explicit model, x-polyrouter-tier header) still outranks a configured workload rule', async () => {
    await withWorkloadRule('code', 'tier:cheap', async () => {
      // Header-forced auto → the header tier wins; the smart layers never run.
      await send(body({ system: 'sysPrec', userChars: 9_000, code: true, tools: 8 }), 'premium');
      const forced = await lastLog();
      expect(forced.decisionLayer).toBe('header');
      expect(forced.modelId).toBe(idPremium);
      expect(forced.workloadClass).toBeNull();
      // Explicit model → explicit.
      await clearLogs();
      await send({
        ...body({ system: 'sysPrec', userChars: 9_000, code: true }),
        model: 'gpt-4o-hi',
      });
      const explicit = await lastLog();
      expect(explicit.decisionLayer).toBe('explicit');
      expect(explicit.modelId).toBe(idPremium);
      expect(explicit.workloadClass).toBeNull();
    });
  });

  it('workload routing: `none` never claims; an unresolvable workload target falls through to the band', async () => {
    await withWorkloadRule('code', 'tier:cheap', async () => {
      // No fenced code → `none` → the rule is inert; the band decides as before.
      await send(body({ system: 'sysNone', userChars: 9_000, tools: 8 }));
      const none = await lastLog();
      expect(none.decisionLayer).toBe('structural');
      expect(none.modelId).toBe(idPremium);
      expect(none.workloadClass).toBe('none');
    });
    // The rule targets a tier that does not exist (write-time validation
    // bypassed at the port) → no claim, band target stands, verdict recorded.
    await withWorkloadRule('code', 'tier:ghost', async () => {
      await send(body({ system: 'sysGhost', userChars: 9_000, code: true, tools: 8 }));
      const row = await lastLog();
      expect(row.decisionLayer).toBe('structural');
      expect(row.modelId).toBe(idPremium);
      expect(row.routingReason).toContain('structural:high');
      expect(row.workloadClass).toBe('code');
      expect(row.workloadRevision).toMatch(REV);
    });
  });

  it('workload routing: a claim fault degrades to the unclaimed flow; a band-resolution fault commits NO telemetry (atomic)', async () => {
    await withWorkloadRule('code', 'tier:cheap', async () => {
      const claim = jest.spyOn(app.get(WorkloadRouter), 'claim').mockImplementationOnce(() => {
        throw new Error('claim boom');
      });
      try {
        await send(body({ system: 'sysFault', userChars: 9_000, code: true, tools: 8 }));
        expect(claim).toHaveBeenCalledTimes(1);
        const row = await lastLog();
        expect(row.decisionLayer).toBe('structural'); // unclaimed → band → premium
        expect(row.modelId).toBe(idPremium);
        expect(row.workloadClass).toBe('code'); // the verdicts still commit via the band path
        expect(row.structuralBand).toBe('high');
      } finally {
        claim.mockRestore();
      }
    });
    // Band resolution faults (no claim: no workload rule, a high non-code
    // request) → `skip` → decision default, ALL verdict columns null — the
    // pre-split whole-evaluate semantics, nothing fabricated.
    const structural = app.get(StructuralRouter) as unknown as { bandTargetOf: () => unknown };
    const band = jest.spyOn(structural, 'bandTargetOf').mockImplementationOnce(() => {
      throw new Error('band boom');
    });
    try {
      await clearLogs();
      await send(body({ system: 'sysBandFault', userChars: 9_000, tools: 8 }));
      expect(band).toHaveBeenCalledTimes(1);
      const row = await lastLog();
      expect(row.decisionLayer).toBe('default');
      expect(row.modelId).toBe(idDefault);
      expect(row.structuralBand).toBeNull();
      expect(row.structuralScore).toBeNull();
      expect(row.structuralEpoch).toBeNull(); // atomic: the epoch clears with the verdicts
      expect(row.workloadClass).toBeNull();
      expect(row.workloadRevision).toBeNull();
    } finally {
      band.mockRestore();
    }
  });

  it('workload routing: vision and structured claims (the precedence order of the classifier decides the ONE class)', async () => {
    await withWorkloadRule('vision', 'tier:cheap', async () => {
      await send({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      });
      const row = await lastLog();
      expect(row.decisionLayer).toBe('workload');
      expect(row.modelId).toBe(idCheap);
      expect(row.routingReason).toMatch(/^workload:vision/);
      expect(row.workloadClass).toBe('vision');
    });
    // A structured request with ONLY a vision rule configured → `structured`
    // has no rule → unclaimed → default (a tiny request: ambiguous/low band).
    await withWorkloadRule('vision', 'tier:cheap', async () => {
      await send({
        model: 'auto',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'give me json' }],
      });
      const row = await lastLog();
      expect(row.decisionLayer).not.toBe('workload');
      expect(row.workloadClass).toBe('structured');
    });
  });

  it('workload routing: a claim outranks a DECLARED-max high band too (not counted unroutable); band resolution is never called for a claimed request', async () => {
    const structural = app.get(StructuralRouter);
    const resolveBand = jest.spyOn(structural, 'resolveBand');
    try {
      await withWorkloadRule('code', 'tier:cheap', async () => {
        await send({
          ...body({ system: 'sysDeclared', userChars: 400, code: true }),
          reasoning_effort: 'high',
        });
        const row = await lastLog();
        expect(row.structuralBand).toBe('high');
        expect(row.structuralBandSource).toBe('declared');
        expect(row.decisionLayer).toBe('workload'); // a 'workload' row is never an unroutable 'default' row
        expect(row.modelId).toBe(idCheap);
        expect(row.workloadClass).toBe('code');
        // Band resolution NEVER happens for a claimed request (not merely ignored).
        expect(resolveBand).toHaveBeenCalledTimes(0);
      });
      // Unclaimed (no rule) → exactly one band resolution.
      await clearLogs();
      await send(body({ system: 'sysDeclaredAfter', userChars: 400, code: true }));
      expect(resolveBand).toHaveBeenCalledTimes(1);
    } finally {
      resolveBand.mockRestore();
    }
  });

  it('workload routing: an EMPTY-tier target and a RESERVED-class rule leave the flow byte-identical', async () => {
    const empty = await port.tiers.insert(principal, { key: 'emptyw' }); // no models
    try {
      await withWorkloadRule('code', 'tier:emptyw', async () => {
        await send(body({ system: 'sysEmpty', userChars: 9_000, code: true, tools: 8 }));
        const row = await lastLog();
        expect(row.decisionLayer).toBe('structural');
        expect(row.modelId).toBe(idPremium);
        expect(row.routingReason).toContain('structural:high');
        expect(row.workloadClass).toBe('code');
      });
    } finally {
      await port.tiers.remove(principal, empty.id);
    }
    // `research` is reserved for the semantic source — the structural source
    // never emits it, so the rule is inert (no claim, no error).
    await withWorkloadRule('research', 'tier:cheap', async () => {
      await send(body({ system: 'sysReserved', userChars: 9_000, code: true, tools: 8 }));
      const row = await lastLog();
      expect(row.decisionLayer).toBe('structural');
      expect(row.modelId).toBe(idPremium);
      expect(row.workloadClass).toBe('code');
    });
  });

  it('workload routing: with the structural layer disabled a configured workload rule does nothing (no verdict → no claim)', async () => {
    process.env['ROUTING_AUTO_LAYERS'] = '';
    const disabled = await buildApp();
    try {
      await withWorkloadRule('code', 'tier:cheap', async () => {
        const res = await request(disabled.server)
          .post('/v1/chat/completions')
          .set('Authorization', `Bearer ${key}`)
          .send(body({ system: 'sysOffW', userChars: 9_000, code: true, tools: 8 }));
        expect(res.status).toBe(200);
        await disabled.app.get(LogWriter).flush();
        const row = await lastLog();
        expect(row.decisionLayer).toBe('default');
        expect(row.modelId).toBe(idDefault);
        expect(row.workloadClass).toBeNull();
        expect(row.structuralBand).toBeNull();
      });
    } finally {
      await disabled.app.close();
      process.env['ROUTING_AUTO_LAYERS'] = 'structural';
    }
  });

  // ── add-workload-scoped-bands: class-scoped band targets ────────────────────

  describe('class-scoped bands (add-workload-scoped-bands)', () => {
    /** A scoped band rule for `cls`, removed afterwards. */
    async function withScopedBand(
      matchType: 'auto_high' | 'auto_low',
      cls: string,
      target: string,
      fn: () => Promise<void>,
      priority = 0,
    ): Promise<void> {
      const rule = await port.routingRules.insert(principal, {
        matchType,
        headerName: 'x-polyrouter-tier',
        headerValue: null,
        workloadClass: cls,
        target,
        priority,
      });
      try {
        await fn();
      } finally {
        await port.routingRules.remove(principal, rule.id);
      }
    }

    it('a code request banding high routes to the code-scoped strong target (reason suffixed); a non-code request keeps the generic one', async () => {
      // The generic auto_high → premium stands; the code scope points at cheap so the two are distinguishable.
      await withScopedBand('auto_high', 'code', 'tier:cheap', async () => {
        await clearLogs();
        await send(body({ system: 'sysScopedHigh', userChars: 9_000, code: true, tools: 8 }));
        const row = await lastLog();
        expect(row.decisionLayer).toBe('structural');
        expect(row.modelId).toBe(idCheap); // the scoped strong target, not premium
        expect(row.routingReason).toMatch(/^structural:high .* scope=code$/); // TERMINAL fragment
        expect(row.workloadClass).toBe('code');
        await clearLogs();
        await send(body({ system: 'sysScopedHighProse', userChars: 9_000, tools: 8 })); // high, workload none
        const prose = await lastLog();
        expect(prose.decisionLayer).toBe('structural');
        expect(prose.modelId).toBe(idPremium); // generic
        expect(prose.routingReason).not.toContain('scope=');
      });
    });

    it('a Workload target still claims first; without it the scoped band decides; an unusable claim does not claim', async () => {
      await withScopedBand('auto_high', 'code', 'tier:cheap', async () => {
        await withWorkloadRule('code', 'tier:premium', async () => {
          await send(body({ system: 'sysClaimOverScope', userChars: 9_000, code: true, tools: 8 }));
          const row = await lastLog();
          expect(row.decisionLayer).toBe('workload'); // the claim wins
          expect(row.modelId).toBe(idPremium);
        });
        // an UNUSABLE claim (empty tier) does not claim → the scoped band serves
        const empty = await port.tiers.insert(principal, { key: 'emptyclaim' });
        try {
          await withWorkloadRule('code', 'tier:emptyclaim', async () => {
            await clearLogs();
            await send(
              body({ system: 'sysUnusableClaim', userChars: 9_000, code: true, tools: 8 }),
            );
            const row = await lastLog();
            expect(row.decisionLayer).toBe('structural');
            expect(row.modelId).toBe(idCheap);
            expect(row.routingReason).toMatch(/ scope=code$/);
          });
        } finally {
          await port.tiers.remove(principal, empty.id);
        }
      });
    });

    it('a scoped rule with an EMPTY tier makes the band unroutable for the class (default serves, band recorded) — never the generic target', async () => {
      const empty = await port.tiers.insert(principal, { key: 'emptyscope' });
      try {
        await withScopedBand('auto_high', 'code', 'tier:emptyscope', async () => {
          await clearLogs();
          await send(body({ system: 'sysScopedEmpty', userChars: 9_000, code: true, tools: 8 }));
          const row = await lastLog();
          expect(row.decisionLayer).toBe('default');
          expect(row.modelId).toBe(idDefault);
          expect(row.structuralBand).toBe('high'); // the verdict is recorded — an unroutable high
          expect(row.workloadClass).toBe('code');
        });
      } finally {
        await port.tiers.remove(principal, empty.id);
      }
    });

    it('a `none` request never carries a scope: scoped rules are invisible to it', async () => {
      await withScopedBand('auto_high', 'code', 'tier:cheap', async () => {
        await clearLogs();
        await send(body({ system: 'sysNoneScope', userChars: 9_000, tools: 8 }));
        const row = await lastLog();
        expect(row.workloadClass).toBe('none');
        expect(row.modelId).toBe(idPremium);
        expect(row.routingReason).not.toContain('scope=');
      });
    });
  });
});
