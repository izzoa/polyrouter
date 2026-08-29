// Layer-2 semantic routing e2e (add-semantic-routing) — real Postgres + Redis +
// a local stub upstream, with a CONTROLLED stub embedder injected so verdicts
// are deterministic. Content markers steer the semantic band: the embedder maps
// the bundled anchors to fixed poles and a marked request to the matching pole,
// so an L1-AMBIGUOUS request routes via Layer 2 to auto_high/auto_low with
// decision_layer='semantic', while an unmarked one stays ambiguous and cascades.
// Proves the wiring end-to-end: resolvePlan insertion, band-target resolution,
// the four telemetry columns, the ordered L1→L2 reason trail, configured-
// default-rule eligibility (clink r1 High-1), and layer-off byte-identity.
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
  HIGH_ANCHORS,
  InMemoryBreakerStore,
  LOW_ANCHORS,
  createProviderAdapter,
  extractSemanticInput,
  type Embedder,
  WORKLOAD_ANCHORS,
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
import { SemanticRouter } from '../../src/semantic/semantic-router';
import { SEMANTIC_LOADER } from '../../src/semantic/onnx-loader';
import { SEMANTIC_CONFIG, type SemanticConfig } from '../../src/semantic/semantic.config';
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
import { RedisModule } from '../../src/redis/redis.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

const HMAC = 'a'.repeat(64);
const DIMS = 8;
const ESCALATE = 'ESCALATE_MARKER_9Q';
const TRIVIAL = 'TRIVIAL_MARKER_7Z';
// add-semantic-workloads: workload-class markers + fault markers for the controlled embedder.
const RESEARCH_MARKER = 'RESEARCH_MARKER_3R';
const WRITING_MARKER = 'WRITING_MARKER_5W';
const WEAK_RESEARCH_MARKER = 'WEAK_RESEARCH_MARKER_1F'; // research direction but far below the similarity floor
const FAIL_EMBED_MARKER = 'FAIL_EMBED_MARKER_0X'; // the embedder rejects (timeout/abort stand-in)
const ZERO_VECTOR_MARKER = 'ZERO_VECTOR_MARKER_0Z'; // a degenerate (zero-norm) vector
const SLOW_EMBED_MARKER = 'SLOW_EMBED_MARKER_9S'; // resolves only AFTER the bounded timeout (a real timeout crossing)
const RESEARCH_HIGH_MARKER = 'RESEARCH_HIGH_MARKER_2H'; // research class AND an L2-high band (e0 + e4)
const SLOW_EMBED_MS = 200; // > SEMANTIC_CFG.timeoutMs (50)
/** Workload classes → basis e3..e7 (code, research, vision, structured, writing). */
const WORKLOAD_BASIS: Record<string, number> = {
  code: 3,
  research: 4,
  vision: 5,
  structured: 6,
  writing: 7,
};
function unit(vals: Partial<Record<number, number>>): Float32Array {
  const v = new Float32Array(DIMS);
  for (const [i, x] of Object.entries(vals)) v[Number(i)] = x ?? 0;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < DIMS; i += 1) v[i] = (v[i] ?? 0) / n;
  return v;
}

/** Basis vector e_i, unit-norm. */
function basis(i: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[i] = 1;
  return v;
}

/**
 * A deterministic embedder: the bundled HIGH anchors map to e_0, LOW anchors to
 * e_1 (so the centroids are exactly those poles), an ESCALATE-marked request to
 * e_0, a TRIVIAL-marked one to e_1, and anything else to e_2 (orthogonal to
 * both → an ambiguous score). Anchors are matched by their SERIALIZED form
 * (the classifier runs them through the extractor), so this mirrors the live
 * path exactly.
 */
/** Every embed() call across the suite — the workload-routing scenario asserts
 * that a claimed request never reaches Layer 2 (no embedding at all). */
let embedCalls = 0;

function controlledEmbedder(): Embedder & { readonly saturated: boolean } {
  const serialize = (text: string): string =>
    extractSemanticInput(
      {
        model: 'auto',
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        params: {},
      },
      { totalChars: 2000 },
    );
  const highSet = new Set(HIGH_ANCHORS.map(serialize));
  const lowSet = new Set(LOW_ANCHORS.map(serialize));
  // Workload anchors (add-semantic-workloads): each class's 30 anchors map to ONE
  // basis vector, so the boot-built centroid IS that pole (pairwise cosine 0).
  const workloadSets = new Map<number, Set<string>>();
  for (const [cls, idx] of Object.entries(WORKLOAD_BASIS)) {
    workloadSets.set(
      idx,
      new Set((WORKLOAD_ANCHORS as Record<string, readonly string[]>)[cls]!.map(serialize)),
    );
  }
  return {
    id: 'sha256:e2e-controlled',
    dims: DIMS,
    saturated: false,
    embed(text: string): Promise<Float32Array> {
      embedCalls += 1;
      // A SLOW embed is raced against the configured bound exactly as the real
      // embedder is (clink r5 L2): the caller sees a rejection after `timeoutMs`,
      // never the late vector.
      if (text.includes(SLOW_EMBED_MARKER)) {
        const slow = new Promise<Float32Array>((resolve) =>
          setTimeout(() => resolve(basis(4)), SLOW_EMBED_MS),
        );
        const bound = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`semantic embed timeout after ${String(SEMANTIC_CFG.timeoutMs)}ms`)),
            SEMANTIC_CFG.timeoutMs,
          ),
        );
        return Promise.race([slow, bound]);
      }
      if (text.includes(FAIL_EMBED_MARKER))
        return Promise.reject(new Error('embed timeout (injected)'));
      if (text.includes(ZERO_VECTOR_MARKER)) return Promise.resolve(new Float32Array(DIMS));
      for (const [idx, set] of workloadSets) if (set.has(text)) return Promise.resolve(basis(idx));
      if (highSet.has(text) || text.includes(ESCALATE)) return Promise.resolve(basis(0));
      if (lowSet.has(text) || text.includes(TRIVIAL)) return Promise.resolve(basis(1));
      // A tie between the two reserved classes → margin 0 → `none`.
      if (text.includes(RESEARCH_MARKER) && text.includes(WRITING_MARKER))
        return Promise.resolve(unit({ 4: 1, 7: 1 }));
      if (text.includes(WEAK_RESEARCH_MARKER)) return Promise.resolve(unit({ 2: 0.98, 4: 0.15 })); // topSim ≈ 0.15 < 0.20
      if (text.includes(RESEARCH_HIGH_MARKER)) return Promise.resolve(unit({ 0: 1, 4: 1 }));
      if (text.includes(RESEARCH_MARKER)) return Promise.resolve(basis(4));
      if (text.includes(WRITING_MARKER)) return Promise.resolve(basis(7));
      return Promise.resolve(basis(2));
    },
  };
}

const SEMANTIC_CFG: SemanticConfig = {
  modelPath: '/injected', // non-undefined → the runtime loads via the stub loader
  timeoutMs: 50,
  maxInputChars: 2000,
  concurrency: 2,
  highThreshold: 0.15,
  lowThreshold: 0.15,
  workload: { margin: 0.05, minSim: 0.2 },
  learning: {
    minCohort: 8,
    minSamples: 50,
    alpha: 0.2,
    maxDrift: 0.35,
    cooldownH: 24,
    stateTtlD: 30,
    maxCohorts: 4096,
    // OFF: this suite tests routing, not scheduling. A live BullMQ Worker leaks
    // handles + a late module import past `app.close()` (jest reports "import a
    // file after the environment has been torn down"), destabilizing the shared
    // --runInBand process and tipping the documented auth.e2e ESM flake.
    schedEnabled: false,
    schedCron: '0 3 * * *',
  },
};

/** An AMBIGUOUS `auto` turn (size + one tool schema lands between the L1
 * thresholds). Markers steer only the SEMANTIC verdict; L1 stays ambiguous. */
function ambiguousBody(system: string, marker = ''): Record<string, unknown> {
  return {
    model: 'auto',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: (marker ? `${marker} ` : '') + 'Z'.repeat(8_000) },
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

/** A structurally HIGH `auto` turn → a confident Layer-1 route (never reaches L2). */
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
      SemanticModule,
    ],
    controllers: [ChatCompletionsController, AutoLayersController],
    providers: [
      AgentApiKeyGuard,
      ProxyService,
      {
        provide: SubscriptionOauthService,
        useValue: { resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')) },
      },
      AutoLayersService,
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
      },
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
      { provide: APP_GUARD, useClass: PermissivePrincipalGuard },
    ],
  })
    // Inject the controlled embedder + config so the classifier is READY with
    // deterministic centroids (no real ONNX in CI).
    .overrideProvider(SEMANTIC_CONFIG)
    .useValue(SEMANTIC_CFG)
    .overrideProvider(SEMANTIC_LOADER)
    .useValue(() => {
      // The loader's full shape (recover-semantic-centroid-build): both seams,
      // the bounded factory, and a quiescent activity view — these cases
      // exercise routing, not recovery.
      const e = controlledEmbedder();
      return Promise.resolve({
        embedder: e,
        bootEmbedder: e,
        boundEmbedder: () => e,
        activity: { inferenceInFlight: false, lastRequestAttemptAt: null, isQuiet: () => true },
        warmupMs: 0,
      });
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.init(); // runs bootstrap hooks → the classifier builds centroids
  return { app, server: app.getHttpServer() };
}

interface Tenant {
  userId: string;
  principal: Principal;
  key: string;
  model: { default: string; strong: string; cheap: string };
}

interface SemRow {
  modelId: string | null;
  decisionLayer: string;
  routingReason: string;
  semanticBand: string | null;
  semanticScore: number | null;
  semanticSource: string | null;
  semanticRevision: string | null;
  structuralBand: string | null;
  structuralScore: number | null;
  workloadClass: string | null;
  workloadScore: number | null;
  workloadSource: string | null;
  workloadRevision: string | null;
}

describe('Layer-2 semantic routing e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let writer: LogWriter;
  let stub: import('./stub-upstream').StubUpstream;
  let T: Tenant;

  async function seedTenant(label: string, defaultRule: boolean): Promise<Tenant> {
    const userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
        [label, `${label}-${Date.now()}@sem.test`],
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
    if (defaultRule) {
      // A CONFIGURED `default` rule (clink r1 High-1): resolves to decision
      // layer 'default' just like the seeded default tier, and must remain
      // eligible for L1/L2 refinement.
      await port.routingRules.insert(principal, {
        matchType: 'default',
        headerName: 'x-polyrouter-tier', // NOT NULL; ignored for a default rule
        headerValue: null,
        target: 'tier:default',
        priority: 0,
      });
    }
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
    // Semantic + cascade both available; each implies structural.
    process.env['ROUTING_AUTO_LAYERS'] = 'cascade,semantic';
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
    T = await seedTenant('sem', false);
  }, 60_000);

  afterAll(async () => {
    if (T?.userId) await pool.query('DELETE FROM "user" WHERE id = $1', [T.userId]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM request_log WHERE owner_user_id = $1', [T.userId]);
  });

  async function proxy(t: Tenant, b: Record<string, unknown>): Promise<void> {
    const res = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${t.key}`)
      .send(b);
    expect(res.status).toBe(200);
    await writer.flush();
  }

  async function lastRow(t: Tenant): Promise<SemRow> {
    const rows = await pool.query<SemRow>(
      `SELECT model_id as "modelId", decision_layer as "decisionLayer", routing_reason as "routingReason",
              semantic_band as "semanticBand", semantic_score as "semanticScore",
              semantic_source as "semanticSource", semantic_revision as "semanticRevision",
              structural_band as "structuralBand", structural_score as "structuralScore",
              workload_class as "workloadClass", workload_score as "workloadScore",
              workload_source as "workloadSource", workload_revision as "workloadRevision"
       FROM request_log WHERE owner_user_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [t.userId],
    );
    return rows.rows[0]!;
  }

  it('L1-ambiguous + L2-high routes via auto_high with decision_layer=semantic + telemetry', async () => {
    await proxy(T, ambiguousBody('sem-high', ESCALATE));
    const row = await lastRow(T);
    expect(row.decisionLayer).toBe('semantic');
    expect(row.modelId).toBe(T.model.strong);
    expect(row.structuralBand).toBe('ambiguous'); // L1 handed off
    expect(row.semanticBand).toBe('high');
    expect(row.semanticSource).toBe('bundled');
    expect(row.semanticScore).toBeGreaterThan(0.15);
    expect(row.semanticRevision).toMatch(/^sha256:/);
    expect(row.routingReason).toContain('semantic:high');
  });

  it('L1-ambiguous + L2-low routes via auto_low', async () => {
    await proxy(T, ambiguousBody('sem-low', TRIVIAL));
    const row = await lastRow(T);
    expect(row.decisionLayer).toBe('semantic');
    expect(row.modelId).toBe(T.model.cheap);
    expect(row.semanticBand).toBe('low');
    expect(row.semanticScore).toBeLessThan(-0.15);
  });

  it('L1-ambiguous + L2-ambiguous cascades, recording the ordered L1→L2 trail', async () => {
    await proxy(T, ambiguousBody('sem-amb')); // no marker → e_2 → ambiguous
    const row = await lastRow(T);
    expect(row.decisionLayer).toBe('cascade');
    expect(row.semanticBand).toBe('ambiguous');
    expect(row.semanticSource).toBe('bundled');
    // The cascade recorder's constructed reason carries the ordered trail.
    expect(row.routingReason).toContain('structural:ambiguous');
    expect(row.routingReason).toContain('semantic:ambiguous');
  });

  it('an L1-confident request never reaches L2 (semantic columns null)', async () => {
    await proxy(T, highBody('sem-conf'));
    const row = await lastRow(T);
    expect(row.decisionLayer).toBe('structural');
    expect(row.semanticBand).toBeNull();
    expect(row.semanticScore).toBeNull();
    expect(row.semanticSource).toBeNull();
    expect(row.semanticRevision).toBeNull();
  });

  it('a CONFIGURED default rule stays eligible for L2 (clink r1 High-1)', async () => {
    const withRule = await seedTenant('sem-defrule', true);
    try {
      await proxy(withRule, ambiguousBody('sem-defrule-high', ESCALATE));
      const row = await lastRow(withRule);
      expect(row.decisionLayer).toBe('semantic');
      expect(row.modelId).toBe(withRule.model.strong);
      expect(row.semanticBand).toBe('high');
    } finally {
      await pool.query('DELETE FROM "user" WHERE id = $1', [withRule.userId]);
    }
  });

  it('a confident-but-UNROUTABLE L2 band stays on default and does NOT cascade (clink r2 High-1)', async () => {
    // A fresh tenant whose auto_high target is EMPTY (a tier with no models):
    // L2 classifies high (marker) but the band is unroutable → the Layer-0
    // default serves, no cheap/strong cascade call is made, verdict recorded.
    const t = await seedTenant('sem-unroutable', false);
    try {
      // Empty the premium tier so auto_high resolves to nothing.
      const premium = (await port.tiers.list(t.principal)).find((x) => x.key === 'premium')!;
      await port.routingEntries.replaceForTier(t.principal, premium.id, []);
      await proxy(t, ambiguousBody('sem-unroutable-high', ESCALATE));
      const row = await lastRow(t);
      expect(row.decisionLayer).toBe('default'); // NOT 'cascade', NOT 'semantic'
      expect(row.modelId).toBe(t.model.default);
      expect(row.semanticBand).toBe('high'); // the verdict is still recorded
      expect(row.semanticSource).toBe('bundled');
      // no cascade attempt rows for this request
      const attempts = await pool.query<{ n: string }>(
        `SELECT count(*) as n FROM request_attempt WHERE request_log_id
           IN (SELECT id FROM request_log WHERE owner_user_id = $1)`,
        [t.userId],
      );
      expect(Number(attempts.rows[0]!.n)).toBe(0); // default single-shot, no cascade ledger
    } finally {
      await pool.query('DELETE FROM "user" WHERE id = $1', [t.userId]);
    }
  });

  it('the semantic preference persists and a legacy PUT omitting it is preserved (clink r2 Med-5)', async () => {
    const t = await seedTenant('sem-pref', false);
    try {
      const put = (dto: Record<string, unknown>) =>
        request(server).put('/api/routing/auto-layers').set('x-test-user', t.userId).send(dto);
      // Disable semantic explicitly.
      expect((await put({ structural: true, cascade: true, semantic: false })).body).toMatchObject({
        semantic: false,
      });
      // A legacy client omits `semantic` while keeping structural on → preserved false.
      const legacy = await put({ structural: true, cascade: true });
      expect(legacy.body.semantic).toBe(false);
      // A full opt-out from a legacy client clears semantic too (dependency-down).
      await put({ structural: true, cascade: true, semantic: true }); // re-enable first
      const optOut = await put({ structural: false, cascade: false });
      expect(optOut.body).toMatchObject({ structural: false, cascade: false, semantic: false });
    } finally {
      await pool.query('DELETE FROM "user" WHERE id = $1', [t.userId]);
    }
  });

  it('GET auto-layers reports both capability halves true (fix-image-healthcheck-and-l2-hint)', async () => {
    const res = await request(server).get('/api/routing/auto-layers').set('x-test-user', T.userId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      semanticAvailable: true,
      semanticFlagEnabled: true,
      semanticClassifierReady: true,
    });
  });

  it('with semantic toggled OFF, an L1-ambiguous request cascades with null semantic columns', async () => {
    expect(
      (
        await request(server)
          .put('/api/routing/auto-layers')
          .set('x-test-user', T.userId)
          .send({ structural: true, cascade: true, semantic: false })
      ).status,
    ).toBe(200);
    try {
      await proxy(T, ambiguousBody('sem-off', ESCALATE)); // marker present, but L2 is off
      const row = await lastRow(T);
      expect(row.decisionLayer).toBe('cascade');
      expect(row.semanticBand).toBeNull();
      expect(row.semanticRevision).toBeNull();
    } finally {
      await request(server)
        .put('/api/routing/auto-layers')
        .set('x-test-user', T.userId)
        .send({ structural: true, cascade: true, semantic: true });
    }
  });

  it('a workload-routed request never reaches Layer 2: no embed, semantic columns null (add-workload-routing)', async () => {
    const codeBody = (system: string): Record<string, unknown> => ({
      model: 'auto',
      messages: [
        { role: 'system', content: system },
        // L1-AMBIGUOUS window (~8k chars, one tool) with ≥30% fenced code → `code`.
        { role: 'user', content: 'Z'.repeat(5_000) + '\n```\n' + 'x'.repeat(3_000) + '\n```' },
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
    const rule = await port.routingRules.insert(T.principal, {
      matchType: 'auto_workload',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      workloadClass: 'code',
      target: 'tier:cheap',
      priority: 0,
    });
    try {
      const before = embedCalls;
      await proxy(T, codeBody('sem-wl'));
      const row = await lastRow(T);
      expect(row.decisionLayer).toBe('workload');
      expect(row.modelId).toBe(T.model.cheap);
      expect(row.routingReason).toMatch(/^workload:code/);
      expect(row.semanticBand).toBeNull();
      expect(row.semanticScore).toBeNull();
      expect(row.semanticSource).toBeNull();
      expect(row.semanticRevision).toBeNull();
      expect(embedCalls).toBe(before); // Layer 2 was never consulted
    } finally {
      await port.routingRules.remove(T.principal, rule.id);
    }
    // Control: the SAME shape without the rule is L1-ambiguous and DOES reach
    // Layer 2 (an embed happens) — so the scenario above proves pre-emption,
    // not merely an L1-confident short-circuit.
    const before = embedCalls;
    await proxy(T, codeBody('sem-wl-control'));
    const control = await lastRow(T);
    expect(control.structuralBand).toBe('ambiguous');
    expect(control.decisionLayer).not.toBe('workload');
    expect(embedCalls).toBeGreaterThan(before);
  });

  // ── add-semantic-workloads: the semantic WORKLOAD source ───────────────────

  describe('semantic workload source (add-semantic-workloads)', () => {
    const SEM_REV = /^semantic\/v1\/s1\/[0-9a-f]{12}$/;
    const researchBody = (system: string, marker = RESEARCH_MARKER): Record<string, unknown> =>
      ambiguousBody(system, marker); // L1-ambiguous shape, structural `none`, embeds to the research pole
    async function withRule(
      t: Tenant,
      cls: string,
      target: string,
      fn: () => Promise<void>,
    ): Promise<void> {
      const rule = await port.routingRules.insert(t.principal, {
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
        await port.routingRules.remove(t.principal, rule.id);
      }
    }
    const putLayers = (t: Tenant, dto: Record<string, unknown>) =>
      request(server).put('/api/routing/auto-layers').set('x-test-user', t.userId).send(dto);

    it('auto-layers reports the workload source as its own capability + effective flag, riding the semantic preference', async () => {
      const t = await seedTenant('sem-wl-cap', false);
      try {
        const on = await request(server)
          .get('/api/routing/auto-layers')
          .set('x-test-user', t.userId);
        expect(on.body).toMatchObject({
          semanticAvailable: true,
          semanticWorkloadAvailable: true,
          semantic: true,
          semanticWorkload: true,
        });
        const off = await putLayers(t, { structural: true, cascade: true, semantic: false });
        expect(off.body).toMatchObject({
          semanticWorkloadAvailable: true,
          semantic: false,
          semanticWorkload: false,
        });
      } finally {
        await pool.query('DELETE FROM "user" WHERE id = $1', [t.userId]);
      }
    });

    it('a research request with auto_workload(research) is CLAIMED: one embed, decision_layer workload, semantic quad, no band resolution, no L2 band classification', async () => {
      await withRule(T, 'research', 'tier:cheap', async () => {
        const router = app.get(SemanticRouter);
        const classifyBand = jest.spyOn(router, 'classifyBand');
        const structural = app.get(StructuralRouter);
        const resolveBand = jest.spyOn(structural, 'resolveBand');
        try {
          const before = embedCalls;
          await proxy(T, researchBody('sem-wl-claim'));
          expect(embedCalls - before).toBe(1); // exactly ONE embed — the workload classification itself
          const row = await lastRow(T);
          expect(row.decisionLayer).toBe('workload');
          expect(row.modelId).toBe(T.model.cheap);
          expect(row.routingReason).toMatch(
            /^workload:research score=\d\.\d{4} m=\d\.\d{4} sim2=-?\d\.\d{4} top=research top2=\w+ src=semantic/,
          );
          expect(row.workloadClass).toBe('research');
          expect(row.workloadSource).toBe('semantic');
          expect(row.workloadScore).toBeCloseTo(1, 3);
          expect(row.workloadRevision).toMatch(SEM_REV);
          expect(row.structuralBand).toBe('ambiguous'); // the band verdict is recorded…
          expect(resolveBand).toHaveBeenCalledTimes(0); // …but never resolved
          expect(classifyBand).toHaveBeenCalledTimes(0); // no Layer-2 band classification
          expect(row.semanticBand).toBeNull();
          expect(row.semanticSource).toBeNull();
        } finally {
          classifyBand.mockRestore();
          resolveBand.mockRestore();
        }
      });
    });

    it('a structural class request (fenced code) embeds NOTHING even with reserved rules configured', async () => {
      await withRule(T, 'research', 'tier:cheap', async () => {
        const before = embedCalls;
        await proxy(T, highBody('sem-wl-structural'));
        expect(embedCalls - before).toBe(0);
        const row = await lastRow(T);
        expect(row.decisionLayer).toBe('structural');
        expect(row.workloadClass).toBe('code');
        expect(row.workloadSource).toBe('structural');
      });
    });

    it('without a rule, a semantic research verdict is recorded and the SAME vector is reused by Layer 2 (one embed, evidence identity)', async () => {
      const router = app.get(SemanticRouter);
      const svc = app.get(ProxyService) as unknown as {
        prepare: (...a: unknown[]) => Promise<{ learningEvidence: Float32Array | null }>;
      };
      const embedSpy = jest.spyOn(router, 'embed');
      const classifyBand = jest.spyOn(router, 'classifyBand');
      const prepareSpy = jest.spyOn(svc, 'prepare');
      try {
        const before = embedCalls;
        await proxy(T, researchBody('sem-wl-reuse'));
        expect(embedCalls - before).toBe(1); // embedded ONCE for both the workload source and the L2 band
        const embedded = (await embedSpy.mock.results[0]!.value) as { vector: Float32Array } | null;
        expect(embedded).not.toBeNull();
        expect(classifyBand).toHaveBeenCalledTimes(1);
        expect(classifyBand.mock.calls[0]![0]).toBe(embedded!.vector); // the SAME instance — no re-embed
        const prepared = await prepareSpy.mock.results[0]!.value;
        expect(prepared.learningEvidence).toBe(embedded!.vector); // …and it rides to the learning contributor unchanged
        const row = await lastRow(T);
        expect(row.workloadClass).toBe('research'); // recorded (source semantic) though unrouted
        expect(row.workloadSource).toBe('semantic');
        expect(row.decisionLayer).toBe('cascade'); // L1 ambiguous + L2 ambiguous (the research pole is orthogonal to both bands) → cascade
        expect(row.semanticBand).toBe('ambiguous');
      } finally {
        embedSpy.mockRestore();
        classifyBand.mockRestore();
        prepareSpy.mockRestore();
      }
    });

    it('below the margin (a reserved tie) and below the floor record none/semantic and never claim', async () => {
      await withRule(T, 'research', 'tier:cheap', async () => {
        await proxy(T, ambiguousBody('sem-wl-tie', `${RESEARCH_MARKER} ${WRITING_MARKER}`));
        const tie = await lastRow(T);
        expect(tie.decisionLayer).not.toBe('workload');
        expect(tie.workloadClass).toBe('none');
        expect(tie.workloadSource).toBe('semantic');
        expect(tie.workloadRevision).toMatch(SEM_REV);
        expect(tie.workloadScore).toBeCloseTo(Math.SQRT1_2, 3); // the winning cosine is recorded even for `none` (clink r5 M1)
        await proxy(T, ambiguousBody('sem-wl-weak', WEAK_RESEARCH_MARKER));
        const weak = await lastRow(T);
        expect(weak.decisionLayer).not.toBe('workload');
        expect(weak.workloadClass).toBe('none');
        expect(weak.workloadSource).toBe('semantic');
        expect(weak.workloadScore).toBeGreaterThan(0.1); // the real sub-floor confidence, not a fabricated zero
        expect(weak.workloadScore).toBeLessThan(0.2);
      });
    });

    it('an embed failure and a degenerate vector record no semantic verdict and skip Layer 2 (one wait, never two); a classify throw keeps the vector for Layer 2', async () => {
      const router = app.get(SemanticRouter);
      await withRule(T, 'research', 'tier:cheap', async () => {
        // 1) the embedder rejects
        let classifyBand = jest.spyOn(router, 'classifyBand');
        let before = embedCalls;
        await proxy(T, ambiguousBody('sem-wl-fail', FAIL_EMBED_MARKER));
        expect(embedCalls - before).toBe(1); // the one bounded wait was spent at the stage…
        expect(classifyBand).toHaveBeenCalledTimes(0); // …and Layer 2 did not embed again
        let row = await lastRow(T);
        expect(row.decisionLayer).toBe('cascade'); // served through the unclaimed flow
        expect(row.workloadClass).toBe('none');
        expect(row.workloadSource).toBe('structural'); // no semantic verdict fabricated
        expect(row.semanticBand).toBeNull();
        classifyBand.mockRestore();
        // 2) a zero-norm vector is an embed-quality failure: same outcome, never reused
        classifyBand = jest.spyOn(router, 'classifyBand');
        before = embedCalls;
        await proxy(T, ambiguousBody('sem-wl-zero', ZERO_VECTOR_MARKER));
        expect(embedCalls - before).toBe(1);
        expect(classifyBand).toHaveBeenCalledTimes(0);
        row = await lastRow(T);
        expect(row.workloadSource).toBe('structural');
        expect(row.semanticBand).toBeNull();
        classifyBand.mockRestore();
        // 2b) a REAL bounded timeout: the embed resolves only after SEMANTIC_TIMEOUT_MS → the stage
        //     sees the rejection after one bounded wait; L2 never embeds again; served.
        classifyBand = jest.spyOn(router, 'classifyBand');
        before = embedCalls;
        const t0 = Date.now();
        await proxy(T, ambiguousBody('sem-wl-slow', SLOW_EMBED_MARKER));
        const elapsed = Date.now() - t0;
        expect(embedCalls - before).toBe(1);
        expect(classifyBand).toHaveBeenCalledTimes(0);
        expect(elapsed).toBeGreaterThanOrEqual(SEMANTIC_CFG.timeoutMs - 5); // the bound was actually waited
        row = await lastRow(T);
        expect(row.decisionLayer).toBe('cascade');
        expect(row.workloadSource).toBe('structural');
        expect(row.semanticBand).toBeNull();
        classifyBand.mockRestore();
        // 3) the classifier throws over a VALID vector: no semantic verdict, but L2 classifies from the kept vector
        classifyBand = jest.spyOn(router, 'classifyBand');
        const classifyWorkload = jest
          .spyOn(router, 'classifyWorkload')
          .mockImplementationOnce(() => {
            throw new Error('injected classifier fault');
          });
        before = embedCalls;
        await proxy(T, researchBody('sem-wl-cls-throw'));
        expect(embedCalls - before).toBe(1);
        expect(classifyBand).toHaveBeenCalledTimes(1); // the kept vector went to Layer 2
        row = await lastRow(T);
        expect(row.decisionLayer).not.toBe('workload');
        expect(row.workloadSource).toBe('structural'); // the structural `none` stands
        expect(row.semanticBand).toBe('ambiguous');
        classifyBand.mockRestore();
        classifyWorkload.mockRestore();
      });
    });

    it('a band-resolution fault after a successful semantic classification clears BOTH quads (atomic commit) and the default serves', async () => {
      const structural = app.get(StructuralRouter) as unknown as { bandTargetOf: () => unknown };
      const band = jest.spyOn(structural, 'bandTargetOf').mockImplementationOnce(() => {
        throw new Error('band boom');
      });
      try {
        // Structural HIGH without fenced code (workload `none`) + the research pole: the
        // stage classifies research (no rule → unclaimed) → band HIGH → bandTargetOf throws.
        await proxy(T, {
          ...highBody('sem-wl-atomic'),
          messages: [
            { role: 'system', content: 'sem-wl-atomic' },
            { role: 'user', content: `${RESEARCH_MARKER} ` + 'Z'.repeat(9_000) },
          ],
        });
        expect(band).toHaveBeenCalledTimes(1);
        const row = await lastRow(T);
        expect(row.decisionLayer).toBe('default');
        expect(row.modelId).toBe(T.model.default);
        expect(row.structuralBand).toBeNull();
        expect(row.structuralScore).toBeNull();
        expect(row.workloadClass).toBeNull();
        expect(row.workloadSource).toBeNull();
        expect(row.workloadRevision).toBeNull();
      } finally {
        band.mockRestore();
      }
    });

    it('a structural WORKLOAD-classifier fault still lets the semantic source classify; a whole Layer-1 skip embeds nothing', async () => {
      const structural = app.get(StructuralRouter) as unknown as {
        workloadOf: () => unknown;
        classify: () => unknown;
      };
      await withRule(T, 'research', 'tier:cheap', async () => {
        const wl = jest.spyOn(structural, 'workloadOf').mockImplementationOnce(() => {
          throw new Error('structural workload fault');
        });
        try {
          const before = embedCalls;
          await proxy(T, researchBody('sem-wl-wlfault'));
          expect(embedCalls - before).toBe(1);
          const row = await lastRow(T);
          expect(row.decisionLayer).toBe('workload'); // the semantic source decided
          expect(row.workloadSource).toBe('semantic');
        } finally {
          wl.mockRestore();
        }
        const cls = jest
          .spyOn(structural, 'classify')
          .mockResolvedValueOnce({ kind: 'skip' } as never);
        try {
          const before = embedCalls;
          await proxy(T, researchBody('sem-wl-l1skip'));
          expect(embedCalls - before).toBe(0); // whole Layer-1 skip → no source runs
          const row = await lastRow(T);
          expect(row.decisionLayer).toBe('default');
          expect(row.structuralBand).toBeNull();
          expect(row.workloadClass).toBeNull();
        } finally {
          cls.mockRestore();
        }
      });
    });

    it('with the semantic layer toggled OFF for the tenant, reserved rules are inert and nothing embeds', async () => {
      const t = await seedTenant('sem-wl-off', false);
      try {
        await putLayers(t, { structural: true, cascade: true, semantic: false });
        await withRule(t, 'research', 'tier:cheap', async () => {
          const before = embedCalls;
          await proxy(t, researchBody('sem-wl-off-req'));
          expect(embedCalls - before).toBe(0);
          const row = await lastRow(t);
          expect(row.decisionLayer).not.toBe('workload');
          expect(row.workloadClass).toBe('none');
          expect(row.workloadSource).toBe('structural');
        });
      } finally {
        await pool.query('DELETE FROM "user" WHERE id = $1', [t.userId]);
      }
    });

    it('invariant 8 — sentinels in a semantically classified request reach no column, reason, revision, or log line', async () => {
      const SENTINELS = ['SENTINEL_SYS_w3a1', 'SENTINEL_USER_w3b2', 'SENTINEL_TOOL_w3c3'];
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
        await withRule(T, 'research', 'tier:cheap', async () => {
          await proxy(T, {
            model: 'auto',
            messages: [
              { role: 'system', content: 'SENTINEL_SYS_w3a1 ' + 'S'.repeat(200) },
              { role: 'user', content: `${RESEARCH_MARKER} SENTINEL_USER_w3b2 ` + 'U'.repeat(400) },
            ],
            tools: [
              {
                type: 'function',
                function: {
                  name: 'SENTINEL_TOOL_w3c3',
                  parameters: { type: 'object', properties: {} },
                },
              },
            ],
          });
        });
      } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        spies.forEach((sp) => sp.mockRestore());
      }
      const row = await lastRow(T);
      expect(row.workloadSource).toBe('semantic');
      const blob = JSON.stringify(row) + '\n' + lines.join('\n');
      for (const sentinel of SENTINELS) expect(blob).not.toContain(sentinel);
      expect(row.workloadRevision).toMatch(SEM_REV);
    });
  });

  // ── add-workload-scoped-bands: Layer 2 + the learning contributor under a class scope ─

  describe('class-scoped bands through Layer 2 and learning (add-workload-scoped-bands)', () => {
    async function withScoped(
      t: Tenant,
      rules: Array<{ matchType: 'auto_high' | 'auto_low'; cls: string; target: string }>,
      fn: () => Promise<void>,
    ): Promise<void> {
      const ids: string[] = [];
      for (const r of rules) {
        const row = await port.routingRules.insert(t.principal, {
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
        for (const id of ids) await port.routingRules.remove(t.principal, id);
      }
    }

    it('an L2-high research request resolves the research-scoped strong target (decision_layer semantic, reason suffixed); without the scoped rule the generic strong serves', async () => {
      // The scoped strong points at the CHEAP model so it is distinguishable from the generic premium/strong.
      await withScoped(
        T,
        [{ matchType: 'auto_high', cls: 'research', target: 'tier:cheap' }],
        async () => {
          await proxy(T, ambiguousBody('sem-scoped-high', RESEARCH_HIGH_MARKER));
          const row = await lastRow(T);
          expect(row.decisionLayer).toBe('semantic');
          expect(row.modelId).toBe(T.model.cheap); // the research-scoped strong target
          expect(row.workloadClass).toBe('research');
          expect(row.workloadSource).toBe('semantic');
          expect(row.semanticBand).toBe('high');
          expect(row.routingReason).toMatch(/^semantic:high .* scope=research$/); // TERMINAL fragment
        },
      );
      await proxy(T, ambiguousBody('sem-generic-high', RESEARCH_HIGH_MARKER));
      const generic = await lastRow(T);
      expect(generic.decisionLayer).toBe('semantic');
      expect(generic.modelId).toBe(T.model.strong); // generic auto_high → premium
      expect(generic.routingReason).not.toContain('scope=');
    });

    it('learning evidence is suppressed ONLY when the selected cheap leg is class-scoped (generic cheap + scoped strong still contributes)', async () => {
      const svc = app.get(ProxyService) as unknown as {
        prepare: (
          ...a: unknown[]
        ) => Promise<{ learningEvidence: Float32Array | null; cascade?: unknown }>;
      };
      // 1) scoped cheap for research → no evidence (cheapScoped)
      await withScoped(
        T,
        [{ matchType: 'auto_low', cls: 'research', target: 'tier:cheap' }],
        async () => {
          const prepareSpy = jest.spyOn(svc, 'prepare');
          try {
            await proxy(T, ambiguousBody('sem-learn-scoped-cheap', RESEARCH_MARKER)); // L1 ambiguous, L2 ambiguous (e4 ⟂ bands) → cascade
            const prepared = await prepareSpy.mock.results[0]!.value;
            const row = await lastRow(T);
            expect(row.decisionLayer).toBe('cascade');
            expect(row.routingReason).toMatch(/ scope=research$/);
            expect(prepared.learningEvidence).toBeNull(); // the scoped cheap leg contributes nothing
          } finally {
            prepareSpy.mockRestore();
          }
        },
      );
      // 2) generic cheap + scoped STRONG for research → evidence kept (cheapScoped=false)
      await withScoped(
        T,
        [{ matchType: 'auto_high', cls: 'research', target: 'tier:premium' }],
        async () => {
          const prepareSpy = jest.spyOn(svc, 'prepare');
          try {
            await proxy(T, ambiguousBody('sem-learn-generic-cheap', RESEARCH_MARKER));
            const prepared = await prepareSpy.mock.results[0]!.value;
            const row = await lastRow(T);
            expect(row.decisionLayer).toBe('cascade');
            expect(prepared.learningEvidence).not.toBeNull(); // the generic cheap chain → evidence as before
          } finally {
            prepareSpy.mockRestore();
          }
        },
      );
    });
  });
});
