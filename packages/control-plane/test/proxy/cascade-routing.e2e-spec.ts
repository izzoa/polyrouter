// Cascade (Layer 3) routing e2e — real Postgres + Redis + a local stub upstream.
// Drives AMBIGUOUS `model=auto` requests (each with a unique system prompt so the
// per-agent baseline stays fresh → ambiguous) through the full cascade: cheap
// buffered → quality gate → deliver or escalate `strong ++ default`, with a
// per-billable-call cost ledger and the mid-stream commit boundary preserved.
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
import { RequestRecorder } from '../../src/recording/request-recorder';
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

/** An AMBIGUOUS `auto` request (size ~.3 + one tool schema ~.13 → between the
 * low/high thresholds). A unique `system` keeps the baseline bucket fresh. */
function body(system: string, stream = false): Record<string, unknown> {
  return {
    model: 'auto',
    stream,
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

describe('cascade routing e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let writer: LogWriter;
  let stub: import('./stub-upstream').StubUpstream;
  let userId: string;
  let principal: Principal;
  let key: string;
  const modelId: Record<string, string> = {};

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
    process.env['ROUTING_CASCADE_CHEAP_TIMEOUT_MS'] = '600'; // fast timeout for the hang test
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
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'c', $1, true) RETURNING id`,
        [`casc-${Date.now()}@cr.test`],
      )
    ).rows[0]!.id;
    principal = userPrincipal(userId);
    const provider = await port.providers.insert(principal, {
      name: 'stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    // externalModelId drives the stub's behavior.
    const external: Record<string, string> = {
      default: 'gpt-4o',
      strong: 'gpt-4o-hi',
      cheapGood: 'gpt-4o-mini',
      cheapBad: 'oai-empty',
      cheapHang: 'oai-hang',
      strongDown: 'oai-srvfail',
      strongMid: 'oai-miderror',
      cheapBadReq: 'oai-badreq',
      // fix-4xx-error-taxonomy: a dry cheap leg (retryable → escalates) and a legal
      // denial (non-retryable → surfaced, on principle rather than futility).
      cheapNoFunds: 'oai-nofunds',
      cheapLegal: 'oai-legal',
      cheapLenstop: 'oai-lenstop',
    };
    for (const [k, ext] of Object.entries(external)) {
      modelId[k] = (await port.models.createForProvider(principal, provider.id, {
        externalModelId: ext,
      }))!.id;
    }
    await port.ensureDefaultTier(principal);
    const tiers = new Map((await port.tiers.list(principal)).map((t) => [t.key, t.id]));
    const tier = async (keyName: string): Promise<string> => {
      const existing = tiers.get(keyName);
      if (existing !== undefined) return existing;
      const t = await port.tiers.insert(principal, { key: keyName });
      tiers.set(keyName, t.id);
      return t.id;
    };
    await port.routingEntries.replaceForTier(principal, await tier('default'), [
      modelId['default']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('premium'), [
      modelId['strong']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('cheap-good'), [
      modelId['cheapGood']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('cheap-bad'), [
      modelId['cheapBad']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('cheap-hang'), [
      modelId['cheapHang']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('strong-down'), [
      modelId['strongDown']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('strong-mid'), [
      modelId['strongMid']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('cheap-nofunds'), [
      modelId['cheapNoFunds']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('cheap-legal'), [
      modelId['cheapLegal']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('cheap-badreq'), [
      modelId['cheapBadReq']!,
    ]);
    await port.routingEntries.replaceForTier(principal, await tier('cheap-lenstop'), [
      modelId['cheapLenstop']!,
    ]);
    await setBand('auto_high', 'premium');
    await setBand('auto_low', 'cheap-bad');

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

  async function send(system: string, stream = false): Promise<request.Response> {
    const res = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send(body(system, stream));
    // Streaming records on the settled outcome (a microtask after the stream is
    // consumed); let it run before flushing.
    if (stream) await new Promise((r) => setTimeout(r, 40));
    await writer.flush();
    return res;
  }
  async function log(): Promise<{
    id: string;
    modelId: string | null;
    decisionLayer: string;
    escalated: boolean;
    qualitySignal: number | null;
    escalationSource: string | null;
    tierAssigned: string | null;
    inputTokens: number | null;
    structuralBand: string | null;
    structuralScore: number | null;
    structuralBandSource: string | null;
    routingReason: string;
    workloadClass: string | null;
    workloadScore: number | null;
    workloadSource: string | null;
    workloadRevision: string | null;
  }> {
    const logs = await port.requestLogs.list(principal);
    return logs[logs.length - 1]!;
  }

  async function sendWith(
    system: string,
    over: Record<string, unknown>,
    stream = false,
  ): Promise<request.Response> {
    const res = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send({ ...body(system, stream), ...over });
    if (stream) await new Promise((r) => setTimeout(r, 40));
    await writer.flush();
    return res;
  }

  it('demanded-JSON prose escalates buffered; the same request without the demand serves cheap (harden-cascade-quality-gate)', async () => {
    await setBand('auto_low', 'cheap-good'); // stub prose 'Hello from stub' — valid answer, invalid JSON
    const demanded = await sendWith('sysConf', { response_format: { type: 'json_object' } });
    expect(demanded.status).toBe(200);
    const row1 = await log();
    expect(row1.escalated).toBe(true); // prose where JSON was demanded → strong serves
    expect(row1.qualitySignal).toBe(0);
    expect(row1.escalationSource).toBe('quality_gate'); // scored verdict (add-auto-threshold-calibration)
    expect(row1.modelId).toBe(modelId['strong']);

    await pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userId]);
    const plain = await send('sysConf2');
    expect(plain.status).toBe(200);
    const row2 = await log();
    expect(row2.decisionLayer).toBe('cascade'); // PROVES the gate ran (not an L1-low shortcut)
    expect(row2.escalated).toBe(false); // the identical prose without the demand passes
    expect(row2.qualitySignal).toBe(1);
    expect(row2.escalationSource).toBeNull(); // provenance only ever on escalated rows
    expect(row2.modelId).toBe(modelId['cheapGood']);
    await setBand('auto_low', 'cheap-bad');
  });

  it('demanded-JSON prose escalates on the STREAMED path too (the second proxy site)', async () => {
    await setBand('auto_low', 'cheap-good');
    const res = await sendWith('sysConfS', { response_format: { type: 'json_object' } }, true);
    expect(res.status).toBe(200);
    expect(res.text).toContain('data:'); // a served SSE stream
    const row = await log();
    expect(row.escalated).toBe(true);
    expect(row.escalationSource).toBe('quality_gate'); // the streamed gate scored it too
    expect(row.modelId).toBe(modelId['strong']);
    await setBand('auto_low', 'cheap-bad');
  });

  it('length-only truncation serves cheap at the default threshold with quality_signal 0.5', async () => {
    await setBand('auto_low', 'cheap-lenstop');
    const res = await send('sysLen');
    expect(res.status).toBe(200);
    const row = await log();
    expect(row.escalated).toBe(false); // 0.5 !< 0.5 — the decision is unchanged
    expect(row.qualitySignal).toBe(0.5); // the sharper label, visibly recorded
    expect(row.escalationSource).toBeNull(); // a decided pass carries no provenance
    expect(row.modelId).toBe(modelId['cheapLenstop']);
    await setBand('auto_low', 'cheap-bad');
  });

  it('a resolved plan whose strong target is missing falls through with the verdict recorded (add-auto-decision-telemetry)', async () => {
    // Remove the auto_high rule: cascade.plan() returns null (no strong target)
    // → the ambiguous request falls through to default WITH its verdict.
    const rules = await port.routingRules.list(principal);
    const high = rules.find((r) => r.matchType === 'auto_high')!;
    await port.routingRules.remove(principal, high.id);
    try {
      const res = await send('sysPlanNull');
      expect(res.status).toBe(200);
      const row = await log();
      expect(row.decisionLayer).toBe('default');
      expect(row.structuralBand).toBe('ambiguous');
      expect(row.routingReason).toContain('; structural:ambiguous');
      // add-workload-telemetry: the plan-null fall-through carries the quad too.
      expect(row.workloadClass).toBe('none');
      expect(row.workloadSource).toBe('structural');
      expect(row.workloadRevision).toMatch(/^structural\/v1\/c1\/[0-9a-f]{12}$/);
    } finally {
      await setBand('auto_high', 'premium');
    }
  });

  it('a good cheap answer is served without escalation (one row, no ledger)', async () => {
    await setBand('auto_low', 'cheap-good');
    const res = await send('sysGood');
    expect(res.status).toBe(200);
    const row = await log();
    expect(row.modelId).toBe(modelId['cheapGood']);
    expect(row.decisionLayer).toBe('cascade');
    expect(row.escalated).toBe(false);
    expect(row.qualitySignal).toBe(1);
    // The full two-layer story on one row (add-auto-decision-telemetry).
    expect(row.structuralBand).toBe('ambiguous');
    expect(row.structuralBandSource).toBe('threshold');
    expect(row.structuralScore).not.toBeNull();
    expect(await port.requestAttempts.listForRequest(principal, row.id)).toHaveLength(0);
    await setBand('auto_low', 'cheap-bad');
  });

  it('a bad cheap answer escalates; the served row is strong + a cheap ledger row records the spend', async () => {
    const res = await send('sysBad');
    expect(res.status).toBe(200);
    const row = await log();
    expect(row.modelId).toBe(modelId['strong']); // served by strong
    expect(row.escalated).toBe(true);
    expect(row.qualitySignal).toBe(0);
    expect(row.escalationSource).toBe('quality_gate'); // the answer was judged bad
    const attempts = await port.requestAttempts.listForRequest(principal, row.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.modelId).toBe(modelId['cheapBad']); // the superseded cheap call
    expect(attempts[0]!.inputTokens).toBeGreaterThan(0); // its own billed usage
    // add-workload-telemetry: the PARENT (served) row carries the quad; the
    // attempt ledger row carries none of it (no such columns).
    expect(row.workloadClass).toBe('none');
    expect(row.workloadScore).toBe(0);
    expect(row.workloadSource).toBe('structural');
    expect((attempts[0] as unknown as Record<string, unknown>)['workloadClass']).toBeUndefined();
  });

  it('rescues to the default tier when the strong tier is down', async () => {
    await setBand('auto_high', 'strong-down');
    const res = await send('sysRescue');
    expect(res.status).toBe(200);
    const row = await log();
    expect(row.tierAssigned).toBe('default'); // strong failed → default served
    expect(row.modelId).toBe(modelId['default']);
    expect(row.escalated).toBe(true);
    await setBand('auto_high', 'premium');
  });

  it("an all-legs-exhausted cascade records BOTH legs' attempt entries (add-fallback-attempt-detail)", async () => {
    // Cheap = strong = default = the 500-mode model, so the cheap leg exhausts,
    // escalation walks strong ++ default, and everything fails.
    await setBand('auto_low', 'strong-down');
    await setBand('auto_high', 'strong-down');
    const defaultTierId = (await port.tiers.list(principal)).find((t) => t.key === 'default')!.id;
    await port.routingEntries.replaceForTier(principal, defaultTierId, [modelId['strongDown']!]);
    try {
      const res = await send('sysAllLegsDown');
      expect(res.status).toBeGreaterThanOrEqual(500);
      const logs = await port.requestLogs.list(principal);
      const row = logs[logs.length - 1]!;
      expect(row.status).toBe('error');
      expect(row.escalated).toBe(true);
      const entries = row.attemptFailures ?? [];
      const firstEsc = entries.findIndex((e) => e.leg === 'escalation');
      // Both executed legs appear, cheap first — the superseded cheap leg's
      // failures are not dropped at escalation.
      expect(entries.filter((e) => e.leg === 'cheap').length).toBeGreaterThanOrEqual(1);
      expect(entries.filter((e) => e.leg === 'escalation').length).toBeGreaterThanOrEqual(1);
      expect(entries[0]!.leg).toBe('cheap');
      expect(firstEsc).toBeGreaterThan(0);
      expect(entries.slice(firstEsc).every((e) => e.leg === 'escalation')).toBe(true);
      // The terminal marker sits on the FINAL walked leg's tail only.
      expect(entries[entries.length - 1]).toMatchObject({ leg: 'escalation', terminal: true });
      expect(entries.filter((e) => e.terminal === true)).toHaveLength(1);
      for (const e of entries) expect(e).toMatchObject({ kind: 'unavailable', dispatched: true });
    } finally {
      await port.routingEntries.replaceForTier(principal, defaultTierId, [modelId['default']!]);
      await setBand('auto_low', 'cheap-bad');
      await setBand('auto_high', 'premium');
    }
  });

  it('escalates when the cheap upstream hangs past the deadline', async () => {
    await setBand('auto_low', 'cheap-hang');
    const res = await send('sysHang');
    expect(res.status).toBe(200);
    const row = await log();
    expect(row.modelId).toBe(modelId['strong']); // cheap timed out → strong served
    expect(row.escalated).toBe(true);
    // Provider fault, never quality evidence (add-auto-threshold-calibration):
    // a timeout escalation is cheap_error even though quality_signal reads 0.
    expect(row.escalationSource).toBe('cheap_error');
    expect(row.qualitySignal).toBe(0); // the unchanged legacy semantics
    await setBand('auto_low', 'cheap-bad');
  });

  it('cancelled and post-commit rows carry the verdict too (add-auto-decision-telemetry)', async () => {
    // The streamed escalation to strong-mid commits then fails post-commit: the
    // deferred outcome-callback row must carry the request-level verdict.
    await setBand('auto_low', 'cheap-bad');
    await setBand('auto_high', 'strong-mid');
    try {
      const res = await send('sysMidTel', true);
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 60));
      await writer.flush();
      const row = await log();
      expect(row.structuralBand).toBe('ambiguous');
      expect(row.structuralBandSource).toBe('threshold');
      // add-workload-telemetry: the deferred post-commit outcome row carries the quad.
      expect(row.workloadClass).toBe('none');
      expect(row.workloadRevision).toMatch(/^structural\/v1\/c1\//);
    } finally {
      await setBand('auto_high', 'premium');
    }
  });

  it('records exactly one cancelled row when the client disconnects during the cheap leg (E5.2/A-3)', async () => {
    await setBand('auto_low', 'cheap-hang'); // cheap upstream hangs; ~600ms cheap deadline
    // A UNIQUE system prompt → no per-agent baseline → guaranteed ambiguous → cascade.
    const req = request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send(body('sysClientAbortDuringCheapLeg', false));
    setTimeout(() => {
      req.abort();
    }, 150); // client goes away mid-cheap-leg (well before the deadline)
    await expect(req).rejects.toThrow(); // aborted client
    await new Promise((r) => setTimeout(r, 150)); // let the server observe the abort + record
    await writer.flush();
    const logs = await port.requestLogs.list(principal);
    expect(logs).toHaveLength(1); // NOT invisible — exactly one row (§7.5 completeness)
    const row = logs[0]!;
    // A-3: a CLIENT disconnect is `cancelled`, not a provider `error` — so it never
    // inflates the error rate or a failure-spike alert. Still exactly one recorded row.
    expect(row.status).toBe('cancelled');
    expect(row.escalated).toBe(false);
    expect(row.decisionLayer).toBe('cascade');
    expect(row.modelId).toBe(modelId['cheapHang']); // the cheap model — NO strong-tier escalation
    // The verdict existed before the outcome — a cancelled row carries it too
    // (add-auto-decision-telemetry).
    expect(row.structuralBand).toBe('ambiguous');
    expect(row.structuralScore).not.toBeNull();
    expect(row.structuralBandSource).toBe('threshold');
    // add-workload-telemetry: the cancelled row carries the full workload quad.
    expect(row.workloadClass).toBe('none');
    expect(row.workloadScore).toBe(0);
    expect(row.workloadSource).toBe('structural');
    expect(row.workloadRevision).toMatch(/^structural\/v1\/c1\/[0-9a-f]{12}$/);
    // No billable-attempt ledger rows (the cheap leg itself was aborted); the branch
    // also does not notifyFailed (a client disconnect is breaker-neutral, not a fault).
    expect(await port.requestAttempts.listForRequest(principal, row.id)).toHaveLength(0);
    await setBand('auto_low', 'cheap-bad');
  });

  it('a RESOLVED cascade plan whose cheap bundle fails to materialize falls through to default with the quad recorded (add-workload-telemetry)', async () => {
    // Both band targets are configured, so cascade.plan() resolves; the cheap
    // bundle then materializes EMPTY (simulated one-shot at the bundle seam for
    // the cheap decision only — the snapshot and the bundle build share one
    // prepare() call). `cascade` stays undefined → the Layer-0 default serves,
    // the fall-through suffix + the workload quad ride the row.
    const svc = app.get(ProxyService);
    const seam = svc as unknown as {
      buildBundle: (...args: unknown[]) => Promise<{ attempts: unknown[]; meta: unknown[] }>;
    };
    const original = seam.buildBundle.bind(svc);
    const spy = jest.spyOn(seam, 'buildBundle').mockImplementation((...args: unknown[]) => {
      const decision = args[1] as { tierKey: string | null };
      return decision.tierKey === 'cheap-bad'
        ? Promise.resolve({ attempts: [], meta: [] })
        : original(...args);
    });
    try {
      const res = await send('sysCheapBundleEmpty');
      expect(res.status).toBe(200);
      const row = await log();
      expect(row.decisionLayer).toBe('default');
      expect(row.modelId).toBe(modelId['default']);
      expect(row.escalated).toBe(false);
      expect(row.structuralBand).toBe('ambiguous');
      expect(row.routingReason).toContain('; structural:ambiguous');
      expect(row.workloadClass).toBe('none');
      expect(row.workloadScore).toBe(0);
      expect(row.workloadSource).toBe('structural');
      expect(row.workloadRevision).toMatch(/^structural\/v1\/c1\/[0-9a-f]{12}$/);
      expect(await port.requestAttempts.listForRequest(principal, row.id)).toHaveLength(0);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('streams only the strong tier on escalation (no cheap output, no swap)', async () => {
    const res = await send('sysStream', true);
    expect(res.status).toBe(200);
    expect(res.text).toContain('[DONE]'); // one clean stream
    const row = await log();
    expect(row.modelId).toBe(modelId['strong']);
    expect(row.escalated).toBe(true);
  });

  it('does NOT escalate when the cheap leg fails non-retryably (bad_request) — A-21', async () => {
    await setBand('auto_low', 'cheap-badreq'); // cheap tier returns a 400 (client-fault)
    const res = await send('sysCheapBadReqUnique', false);
    // A bad_request is the client's fault — the expensive tier would 400 too, so we
    // surface it (4xx) instead of wasting an escalation.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const row = await log();
    expect(row.modelId).toBe(modelId['cheapBadReq']); // the cheap model — NO strong-tier escalation
    expect(row.escalated).toBe(false);
    await setBand('auto_low', 'cheap-bad');
  });

  // fix-4xx-error-taxonomy. The intended behavior CHANGE: a dry cheap provider is
  // retryable, and the strong tier is usually a different provider — so escalating is
  // right where surfacing a 400 was wrong. No escalation code changed; `shouldFallback`
  // moved underneath it.
  it('DOES escalate when the cheap leg is out of credit (402)', async () => {
    await setBand('auto_low', 'cheap-nofunds');
    const res = await send('sysCheapNoFundsUnique', false);
    expect(res.status).toBe(200);
    const row = await log();
    expect(row.modelId).toBe(modelId['strong']); // rescued by the strong tier
    expect(row.escalated).toBe(true);
    await setBand('auto_low', 'cheap-bad');
  });

  // The other new non-retryable kind. Unlike a bad_request this is NOT futility — the
  // strong tier might well serve it, and escalating would route around a legal denial.
  it('does NOT escalate a cheap 451, and records the kind in the reason', async () => {
    await setBand('auto_low', 'cheap-legal');
    const res = await send('sysCheapLegalUnique', false);
    expect(res.status).toBe(451);
    const row = await log();
    expect(row.modelId).toBe(modelId['cheapLegal']); // never reached the strong tier
    expect(row.escalated).toBe(false);
    expect(row.routingReason).toContain('cheap failed non-retryably (policy_block)');
    await setBand('auto_low', 'cheap-bad');
  });

  it('does NOT escalate a STREAMED cheap 451 either (the streaming cascade path)', async () => {
    await setBand('auto_low', 'cheap-legal');
    const res = await send('sysStreamCheapLegalUnique', true);
    expect(res.status).toBe(451);
    const row = await log();
    expect(row.modelId).toBe(modelId['cheapLegal']);
    expect(row.escalated).toBe(false);
    await setBand('auto_low', 'cheap-bad');
  });

  it('does NOT escalate a STREAMED cheap bad_request either — A-21 (streaming cascade path)', async () => {
    await setBand('auto_low', 'cheap-badreq'); // cheap tier 400s (pre-commit, no bytes)
    const res = await send('sysStreamCheapBadReqUnique', true);
    expect(res.status).toBeGreaterThanOrEqual(400); // surfaced 4xx, not escalated
    expect(res.status).toBeLessThan(500);
    const row = await log();
    expect(row.modelId).toBe(modelId['cheapBadReq']); // never reached the strong tier
    expect(row.escalated).toBe(false);
    await setBand('auto_low', 'cheap-bad');
  });

  it('a cascade escalation whose strong stream errors post-commit terminates — no swap, no leak (A-22, invariant 3)', async () => {
    // Drive the seeded `strong-mid` (oai-miderror) fixture THROUGH the real cascade:
    // the cheap answer is empty (fails quality) → escalate → the strong tier streams a
    // token then errors mid-stream (post-commit). `setBand` is matchType-scoped, so
    // setting auto_high leaves auto_low intact.
    await setBand('auto_low', 'cheap-bad'); // empty cheap answer → fails the quality gate
    await setBand('auto_high', 'strong-mid'); // escalation target commits then errors mid-stream
    try {
      const res = await send('sysMidErrorEscalateUnique', true);
      expect(res.status).toBe(200); // committed before the upstream error
      expect(res.text).not.toContain('SECRET'); // the upstream error text never leaks (invariant 8)
      const mine = (await port.requestLogs.list(principal)).find(
        (l) => l.modelId === modelId['strongMid'] && l.decisionLayer === 'cascade',
      );
      expect(mine).toBeDefined(); // escalated into the seeded mid-error strong model, via cascade
      expect(mine!.escalated).toBe(true);
      expect(mine!.status).toBe('error'); // post-commit terminal error, not a silent swap
    } finally {
      await setBand('auto_high', 'premium'); // restore the fixture's default strong band
    }
  });

  it('replays a good cheap answer as the client stream', async () => {
    await setBand('auto_low', 'cheap-good');
    const res = await send('sysReplay', true);
    expect(res.status).toBe(200);
    expect(res.text).toContain('[DONE]');
    const row = await log();
    expect(row.modelId).toBe(modelId['cheapGood']);
    expect(row.escalated).toBe(false);
    expect(row.inputTokens).toBeGreaterThan(0); // billed from the buffered cheap response
    await setBand('auto_low', 'cheap-bad');
  });

  it('ledgers the superseded cheap call even when EVERY escalation member fails (§7.7)', async () => {
    // Cheap succeeds (bad quality -> escalate); strong AND default both 500 ->
    // the request errors, but the cheap spend must still get its attempt row.
    const tiers = new Map((await port.tiers.list(principal)).map((t) => [t.key, t.id]));
    await setBand('auto_high', 'strong-down');
    await port.routingEntries.replaceForTier(principal, tiers.get('default')!, [
      modelId['strongDown']!,
    ]);
    try {
      const res = await request(server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send(body('sysLedgerAllFail'));
      expect(res.status).toBeGreaterThanOrEqual(500);
      await writer.flush();
      const row = await log();
      expect(row.decisionLayer).toBe('cascade');
      expect(row.escalated).toBe(true);
      const attempts = await port.requestAttempts.listForRequest(principal, row.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.modelId).toBe(modelId['cheapBad']); // the billed cheap call
    } finally {
      await port.routingEntries.replaceForTier(principal, tiers.get('default')!, [
        modelId['default']!,
      ]);
      await setBand('auto_high', 'premium');
    }
  });

  it('with cascade disabled, an ambiguous auto request serves via the default tier', async () => {
    process.env['ROUTING_AUTO_LAYERS'] = 'structural';
    const off = await buildApp();
    try {
      const res = await request(off.server)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send(body('sysDisabled'));
      expect(res.status).toBe(200);
      await off.app.get(LogWriter).flush();
      const row = await log();
      expect(row.decisionLayer).toBe('default');
      expect(row.tierAssigned).toBe('default');
    } finally {
      await off.app.close();
      process.env['ROUTING_AUTO_LAYERS'] = 'structural,cascade';
    }
  });

  it('a workload-routed request never cascades: no cheap call, no ledger row (add-workload-routing)', async () => {
    // Both bands configured (cascade eligible) AND a code rule → the claim
    // pre-empts the cascade plan entirely: one upstream call to the claimed
    // target, no cheap leg, no billable-attempt ledger row.
    await setBand('auto_low', 'cheap-good');
    const rule = await port.routingRules.insert(principal, {
      matchType: 'auto_workload',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      workloadClass: 'code',
      target: 'tier:premium',
      priority: 0,
    });
    const upstreamBefore = stub.requests.length;
    try {
      const res = await sendWith('sysWlCasc', {
        messages: [
          { role: 'system', content: 'sysWlCasc' },
          // ~8k window chars with ≥30% fenced → the structural `code` class.
          { role: 'user', content: 'Z'.repeat(5_000) + '\n```\n' + 'x'.repeat(3_000) + '\n```' },
        ],
      });
      expect(res.status).toBe(200);
      const row = await log();
      expect(row.decisionLayer).toBe('workload');
      expect(row.modelId).toBe(modelId['strong']);
      expect(row.escalated).toBe(false);
      expect(row.qualitySignal).toBeNull(); // no cheap leg was judged
      expect(row.workloadClass).toBe('code');
      expect(row.structuralBand).not.toBeNull(); // the band is classified, just never resolved
      expect(stub.requests.length - upstreamBefore).toBe(1); // exactly ONE upstream call — no cheap leg
      expect(await port.requestAttempts.listForRequest(principal, row.id)).toHaveLength(0);
    } finally {
      await port.routingRules.remove(principal, rule.id);
      await setBand('auto_low', 'cheap-bad');
    }
  });

  // ── add-workload-scoped-bands: cascade within a class ───────────────────────

  describe('class-scoped cascade (add-workload-scoped-bands)', () => {
    /** An L1-AMBIGUOUS code request: ~8k window chars with ≥30% fenced code, one tool. */
    const codeBody = (system: string): Record<string, unknown> => ({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Z'.repeat(5_000) + '\n```\n' + 'x'.repeat(3_000) + '\n```' },
      ],
    });
    // log() reads ONE row — clear between sends inside a scenario.
    const clearLogs = (): Promise<unknown> =>
      pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [userId]);
    async function withScoped(
      rules: Array<{ matchType: 'auto_high' | 'auto_low'; cls: string; target: string }>,
      fn: () => Promise<void>,
    ): Promise<void> {
      const ids: string[] = [];
      for (const r of rules) {
        const row = await port.routingRules.insert(principal, {
          matchType: r.matchType,
          headerName: 'x-polyrouter-tier',
          headerValue: null,
          workloadClass: r.cls,
          target: r.target,
          priority: 0,
        });
        ids.push(row.id);
      }
      try {
        await fn();
      } finally {
        for (const id of ids) await port.routingRules.remove(principal, id);
      }
    }

    it('cheap-code → strong-code: the scoped cheap serves a good answer; a bad one escalates to the scoped strong — reasons carry scope=code on the served row AND the attempt context', async () => {
      // Generic pair: cheap-bad (escalates) + premium. Code scope: cheap-good (served) — a code
      // request served by cheap-good proves the scoped cheap leg was used.
      await setBand('auto_low', 'cheap-bad');
      await withScoped(
        [
          { matchType: 'auto_low', cls: 'code', target: 'tier:cheap-good' },
          { matchType: 'auto_high', cls: 'code', target: 'tier:premium' },
        ],
        async () => {
          const res = await sendWith('sysScopedCheapGood', codeBody('sysScopedCheapGood'));
          expect(res.status).toBe(200);
          const row = await log();
          expect(row.decisionLayer).toBe('cascade');
          expect(row.modelId).toBe(modelId['cheapGood']); // the SCOPED cheap leg
          expect(row.escalated).toBe(false);
          expect(row.workloadClass).toBe('code');
          expect(row.structuralBand).toBe('ambiguous');
          // the scope is the TERMINAL fragment — after the quality marker and any trail
          expect(row.routingReason).toMatch(/^cascade: cheap served \(q=[^)]*\).* scope=code$/);
          // a NON-code ambiguous request still cascades through the generic cheap-bad → premium
          await clearLogs();
          const prose = await send('sysGenericStillBad');
          expect(prose.status).toBe(200);
          const prow = await log();
          expect(prow.escalated).toBe(true);
          expect(prow.modelId).toBe(modelId['strong']);
          expect(prow.routingReason).not.toContain('scope=');
        },
      );
      // Escalation within the class: scoped cheap is BAD (cheap-bad), scoped strong is premium.
      const recorder = app.get(RequestRecorder);
      const attemptSpy = jest.spyOn(recorder, 'recordAttempt');
      try {
        await withScoped(
          [
            { matchType: 'auto_low', cls: 'code', target: 'tier:cheap-bad' },
            { matchType: 'auto_high', cls: 'code', target: 'tier:premium' },
          ],
          async () => {
            await clearLogs();
            const res = await sendWith('sysScopedEscalate', codeBody('sysScopedEscalate'));
            expect(res.status).toBe(200);
            const row = await log();
            expect(row.escalated).toBe(true);
            expect(row.modelId).toBe(modelId['strong']);
            expect(row.routingReason).toMatch(
              /^cascade: escalated cheap→premium \(q=.* scope=code$/,
            ); // terminal
            const ctxReasons = attemptSpy.mock.calls.map(
              (c) => (c[1] as { routingReason: string }).routingReason,
            );
            expect(
              ctxReasons.some((r) => r === 'cascade: cheap attempt (escalated) scope=code'),
            ).toBe(true);
          },
        );
      } finally {
        attemptSpy.mockRestore();
      }
    });

    it('hybrids fall back per band: only a scoped cheap → scoped cheap + generic strong; only a scoped strong → generic cheap + scoped strong', async () => {
      await setBand('auto_low', 'cheap-bad');
      await setBand('auto_high', 'premium');
      // only scoped cheap (good) → served by the scoped cheap
      await withScoped(
        [{ matchType: 'auto_low', cls: 'code', target: 'tier:cheap-good' }],
        async () => {
          await sendWith('sysHybridCheap', codeBody('sysHybridCheap'));
          const row = await log();
          expect(row.modelId).toBe(modelId['cheapGood']);
          expect(row.escalated).toBe(false);
        },
      );
      // only scoped strong: the generic cheap-bad escalates to the SCOPED strong (strong-mid behaves
      // differently from premium, so it is observable: mid-stream error → rescue to default) — use the
      // buffered path: strong-down fails → escalation continues to the default tier.
      await withScoped(
        [{ matchType: 'auto_high', cls: 'code', target: 'tier:strong-down' }],
        async () => {
          await clearLogs();
          await sendWith('sysHybridStrong', codeBody('sysHybridStrong'));
          const row = await log();
          expect(row.escalated).toBe(true);
          expect(row.modelId).toBe(modelId['default']); // scoped strong (down) → rescued by default
          expect(row.routingReason).toMatch(/ scope=code$/); // terminal on the rescued row too
        },
      );
    });

    it('the scoped TERMINAL branches end with scope=code too — all legs failed, non-retryable cheap, client disconnect (r5)', async () => {
      // ALL FAILED: scoped cheap = scoped strong = default = the 500-mode model.
      await setBand('auto_low', 'cheap-bad');
      await setBand('auto_high', 'premium');
      const defaultTierId = (await port.tiers.list(principal)).find((t) => t.key === 'default')!.id;
      await port.routingEntries.replaceForTier(principal, defaultTierId, [modelId['strongDown']!]);
      try {
        await withScoped(
          [
            { matchType: 'auto_low', cls: 'code', target: 'tier:strong-down' },
            { matchType: 'auto_high', cls: 'code', target: 'tier:strong-down' },
          ],
          async () => {
            await clearLogs();
            const res = await sendWith('sysScopedAllDown', codeBody('sysScopedAllDown'));
            expect(res.status).toBeGreaterThanOrEqual(500);
            expect((await port.requestLogs.list(principal))[0]!.status).toBe('error');
            const row = await log();
            expect(row.escalated).toBe(true);
            expect(row.routingReason).toMatch(/^cascade: escalated, all failed.* scope=code$/);
          },
        );
      } finally {
        await port.routingEntries.replaceForTier(principal, defaultTierId, [modelId['default']!]);
      }
      // NON-RETRYABLE: the scoped cheap 400s → surfaced (no escalation), scope still terminal.
      await withScoped(
        [{ matchType: 'auto_low', cls: 'code', target: 'tier:cheap-badreq' }],
        async () => {
          await clearLogs();
          const res = await sendWith('sysScopedBadReq', codeBody('sysScopedBadReq'));
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect(res.status).toBeLessThan(500);
          const row = await log();
          expect(row.escalated).toBe(false);
          expect(row.modelId).toBe(modelId['cheapBadReq']);
          expect(row.routingReason).toMatch(
            /^cascade: cheap failed non-retryably \(bad_request\).* scope=code$/,
          );
        },
      );
      // CLIENT DISCONNECT during the scoped cheap leg: exactly one cancelled row, scope terminal.
      await withScoped(
        [{ matchType: 'auto_low', cls: 'code', target: 'tier:cheap-hang' }],
        async () => {
          await clearLogs();
          const req = request(server)
            .post('/v1/chat/completions')
            .set('Authorization', `Bearer ${key}`)
            .send({ ...body('sysScopedClientAbort', false), ...codeBody('sysScopedClientAbort') });
          setTimeout(() => {
            req.abort();
          }, 150);
          await expect(req).rejects.toThrow();
          await new Promise((r) => setTimeout(r, 150));
          await writer.flush();
          expect((await port.requestLogs.list(principal))[0]!.status).toBe('cancelled');
          const row = await log();
          expect(row.escalated).toBe(false);
          expect(row.modelId).toBe(modelId['cheapHang']);
          expect(row.routingReason).toMatch(
            /^cascade: client disconnected during cheap attempt.* scope=code$/,
          );
        },
      );
    });

    it('a scoped cheap rule with an empty tier leaves the class without a plan — the default serves, no cheap call', async () => {
      await setBand('auto_low', 'cheap-good');
      const empty = await port.tiers.insert(principal, { key: 'empty-cheap' });
      try {
        await withScoped(
          [{ matchType: 'auto_low', cls: 'code', target: 'tier:empty-cheap' }],
          async () => {
            const before = stub.requests.length;
            await sendWith('sysScopedEmptyCheap', codeBody('sysScopedEmptyCheap'));
            const row = await log();
            expect(row.decisionLayer).toBe('default');
            expect(row.modelId).toBe(modelId['default']);
            expect(stub.requests.length - before).toBe(1); // one call — no cheap leg
            expect(await port.requestAttempts.listForRequest(principal, row.id)).toHaveLength(0);
          },
        );
      } finally {
        await port.tiers.remove(principal, empty.id);
        await setBand('auto_low', 'cheap-bad');
      }
    });
  });
});
