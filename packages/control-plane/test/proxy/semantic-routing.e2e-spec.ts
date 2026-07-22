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
import { SEMANTIC_LOADER } from '../../src/semantic/onnx-loader';
import { SEMANTIC_CONFIG, type SemanticConfig } from '../../src/semantic/semantic.config';
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
const DIMS = 8;
const ESCALATE = 'ESCALATE_MARKER_9Q';
const TRIVIAL = 'TRIVIAL_MARKER_7Z';

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
function controlledEmbedder(): Embedder & { readonly saturated: boolean } {
  const serialize = (text: string): string =>
    extractSemanticInput(
      { model: 'auto', messages: [{ role: 'user', content: [{ type: 'text', text }] }], params: {} },
      { totalChars: 2000 },
    );
  const highSet = new Set(HIGH_ANCHORS.map(serialize));
  const lowSet = new Set(LOW_ANCHORS.map(serialize));
  return {
    id: 'sha256:e2e-controlled',
    dims: DIMS,
    saturated: false,
    embed(text: string): Promise<Float32Array> {
      if (highSet.has(text) || text.includes(ESCALATE)) return Promise.resolve(basis(0));
      if (lowSet.has(text) || text.includes(TRIVIAL)) return Promise.resolve(basis(1));
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
      { provide: CALIBRATION_RAILS, useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()) },
      {
        provide: StructuralBaselineStore,
        inject: [REDIS_CLIENT],
        useFactory: (redis: Redis): StructuralBaselineStore => new StructuralBaselineStore(redis, HMAC),
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
    .useValue(() => Promise.resolve({ embedder: controlledEmbedder(), warmupMs: 0 }))
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
    const model = { default: await mk('gpt-4o'), strong: await mk('gpt-4o-hi'), cheap: await mk('gpt-4o-mini') };
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
              structural_band as "structuralBand"
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
});
