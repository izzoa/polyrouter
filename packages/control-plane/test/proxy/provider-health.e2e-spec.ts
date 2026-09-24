// add-provider-health-signals (task 6.2): provider health recorded from LIVE
// TRAFFIC, over the real proxy + Postgres against the local stub upstream.
// Traffic writes happen only on shared-breaker transitions (open → failing; an
// applied served success on a provider not displayed ok → ok), are guarded by the
// incarnation each attempt used and ordered by the breaker-issued sequence, and
// run fire-and-forget off the request path.
import {
  Injectable,
  UnauthorizedException,
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
  encryptSecret,
  userPrincipal,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  createProviderAdapter,
  type BreakerConfig,
  type BreakerStore,
} from '@polyrouter/data-plane';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { startStubUpstream } from './stub-upstream';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
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
import { DatabaseModule } from '../../src/database/database.module';
import { SemanticModule } from '../../src/semantic/semantic.module';
import { ProvidersModule } from '../../src/providers/providers.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

const HMAC = 'a'.repeat(64);
const CRED_KEY = 'c'.repeat(64);
const CFG: BreakerConfig = {
  threshold: 3,
  cooldownMs: 200,
  probeLeaseMs: 2_000,
  stateTtlMs: 300_000,
};

@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.path.startsWith('/api')) return true;
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

/** The shared (primary) breaker store, switchable to "down" — the breaker then
 * serves from its per-instance fallback, which must record no traffic health. */
class ToggleStore implements BreakerStore {
  down = false;
  constructor(private readonly inner: BreakerStore) {}
  private gate(): Promise<void> {
    return this.down ? Promise.reject(new Error('shared store down')) : Promise.resolve();
  }
  decide(...a: Parameters<BreakerStore['decide']>) {
    return this.gate().then(() => this.inner.decide(...a));
  }
  complete(...a: Parameters<BreakerStore['complete']>) {
    return this.gate().then(() => this.inner.complete(...a));
  }
  renew(...a: Parameters<BreakerStore['renew']>) {
    return this.gate().then(() => this.inner.renew(...a));
  }
  reset(...a: Parameters<BreakerStore['reset']>) {
    return this.gate().then(() => this.inner.reset(...a));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('provider health from live traffic (add-provider-health-signals)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let stub: import('./stub-upstream').StubUpstream;
  let store: ToggleStore;
  const users: string[] = [];
  let seq = 0;

  interface Tenant {
    userId: string;
    principal: Principal;
    key: string;
  }

  const chat = (t: Tenant, model: string) =>
    request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${t.key}`)
      .send({ model, messages: [{ role: 'user', content: 'hi' }] });

  async function tenant(): Promise<Tenant> {
    const userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'ph', $1, true) RETURNING id`,
        [`ph-${Date.now()}-${++seq}@t.test`],
      )
    ).rows[0]!.id;
    users.push(userId);
    const principal = userPrincipal(userId);
    await port.ensureDefaultTier(principal);
    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl')`,
      [userId, minted.hash, minted.prefix],
    );
    return { userId, principal, key: minted.key };
  }

  /** A provider on the stub with uniquely-named models (explicit routing by model). */
  async function provider(
    t: Tenant,
    tag: string,
  ): Promise<{ id: string; model: (m: string) => string }> {
    const p = await port.providers.insert(t.principal, {
      name: `ph-${tag}`,
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
      encryptedCredentials: encryptSecret(`local-key-${tag}`, CRED_KEY),
    });
    const model = (m: string): string => `oai-${m}-${tag}`;
    for (const m of ['unauth', 'good', 'slowhead', 'noperm', 'badreq']) {
      await port.models.createForProvider(t.principal, p.id, { externalModelId: model(m) });
    }
    return { id: p.id, model };
  }

  const health = async (id: string): Promise<Record<string, unknown>> =>
    (
      await pool.query<Record<string, unknown>>(
        `SELECT status, status_rev, traffic_state, traffic_error_kind, traffic_seq, traffic_rev
           FROM provider WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  /** Traffic writes are fire-and-forget — wait until the row settles. */
  async function eventually(
    id: string,
    pred: (h: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    for (let i = 0; i < 50; i += 1) {
      const h = await health(id);
      if (pred(h)) return h;
      await sleep(20);
    }
    return health(id);
  }

  const trip = async (t: Tenant, model: string): Promise<void> => {
    for (let i = 0; i < CFG.threshold; i += 1) await chat(t, model);
  };

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = CRED_KEY;
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    stub = await startStubUpstream();
    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    store = new ToggleStore(new InMemoryBreakerStore());
    const moduleRef = await Test.createTestingModule({
      imports: [
        SemanticModule,
        DatabaseModule,
        RecordingModule,
        ObservabilityModule,
        ProvidersModule,
      ],
      controllers: [ChatCompletionsController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        {
          provide: SubscriptionOauthService,
          useValue: {
            resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')),
            requestForcedRefresh: () => Promise.resolve('skipped'),
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
        {
          provide: PROXY_BREAKER,
          useValue: new CircuitBreaker(store, { config: CFG, onError: () => undefined }),
        },
        { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
        {
          provide: CALIBRATION_RAILS,
          useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()),
        },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
        { provide: APP_GUARD, useClass: TestPrincipalGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
    store.down = false;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [users]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  it('a provider failing in live traffic shows as failing without a Test', async () => {
    const t = await tenant();
    const p = await provider(t, 'fail');
    await trip(t, p.model('unauth'));
    const h = await eventually(p.id, (x) => x['traffic_state'] === 'failing');
    expect(h).toMatchObject({ traffic_state: 'failing', traffic_error_kind: 'auth' });
    const listed = await request(server).get('/api/providers').set('x-test-user', t.userId);
    const row = (listed.body as Array<{ id: string; health: unknown }>).find((x) => x.id === p.id)!;
    expect(row.health).toMatchObject({ state: 'failing', kind: 'auth', source: 'traffic' });
  });

  it('a recovery by an applied success is displayed over an older failed Test', async () => {
    const t = await tenant();
    const p = await provider(t, 'recover');
    await pool.query(
      `UPDATE provider SET status='error', last_error_kind='auth', status_source='test',
         status_changed_at=now(), status_rev=1, health_rev=1 WHERE id=$1`,
      [p.id],
    );
    expect((await chat(t, p.model('good'))).status).toBe(200);
    const h = await eventually(p.id, (x) => x['traffic_state'] === 'ok');
    expect(h['traffic_state']).toBe('ok');
    expect(Number(h['traffic_rev'])).toBeGreaterThan(Number(h['status_rev']));
  });

  it('a recovery is written ONCE — even against a check record stamped in the future', async () => {
    const t = await tenant();
    const p = await provider(t, 'once');
    // A check timestamp far in the future: display order is the revision, never the clock.
    await pool.query(
      `UPDATE provider SET status='error', last_error_kind='auth', status_source='test',
         status_changed_at = now() + interval '1 day', status_rev=1, health_rev=1 WHERE id=$1`,
      [p.id],
    );
    const spy = jest.spyOn(port.providers, 'setHealth');
    for (let i = 0; i < 5; i += 1) {
      expect((await chat(t, p.model('good'))).status).toBe(200);
      await eventually(p.id, (x) => x['traffic_state'] === 'ok');
    }
    expect(spy.mock.calls.filter((c) => c[1] === p.id)).toHaveLength(1);
  });

  it('an ok provider serving requests costs zero health writes', async () => {
    const t = await tenant();
    const p = await provider(t, 'quiet');
    await pool.query(`UPDATE provider SET status='ok', status_rev=1, health_rev=1 WHERE id=$1`, [
      p.id,
    ]);
    const spy = jest.spyOn(port.providers, 'setHealth');
    for (let i = 0; i < 4; i += 1) expect((await chat(t, p.model('good'))).status).toBe(200);
    await sleep(100);
    expect(spy.mock.calls.filter((c) => c[1] === p.id)).toHaveLength(0);
  });

  it('a success admitted before a trip, completing after it, cannot erase the trip', async () => {
    const t = await tenant();
    const p = await provider(t, 'stale');
    // supertest only dispatches on then(): start it NOW so it is admitted while closed.
    const slow = chat(t, p.model('slowhead')).then((r) => r); // ~1s to headers
    await sleep(100);
    await trip(t, p.model('unauth'));
    await eventually(p.id, (x) => x['traffic_state'] === 'failing');
    expect((await slow).status).toBe(200); // it did serve…
    await sleep(150);
    // …but its completion was stale on the shared breaker: no `ok` write. (Two guards
    // reject it here — the breaker's `applied` gate and the stale completion's seq 0 vs
    // the recorded sequence; attempt-health.spec isolates the `applied` gate.)
    expect(await health(p.id)).toMatchObject({ traffic_state: 'failing' });
  });

  it('observations made against a replaced credential are discarded', async () => {
    const t = await tenant();
    const p = await provider(t, 'edit');
    await pool.query(`UPDATE provider SET status='error', status_rev=1, health_rev=1 WHERE id=$1`, [
      p.id,
    ]);
    const slow = chat(t, p.model('slowhead')).then((r) => r); // built with the OLD credential
    await sleep(150);
    await port.providers.updateResettingHealth(
      t.principal,
      p.id,
      { encryptedCredentials: encryptSecret('rotated', CRED_KEY) },
      'edit',
    );
    expect((await slow).status).toBe(200);
    await sleep(150);
    expect(await health(p.id)).toMatchObject({ status: 'unknown', traffic_state: null });
  });

  it('traffic writes are sequenced: the later observation carries the higher sequence', async () => {
    const t = await tenant();
    const p = await provider(t, 'seq');
    await trip(t, p.model('unauth'));
    const failing = await eventually(p.id, (x) => x['traffic_state'] === 'failing');
    await sleep(CFG.cooldownMs + 50);
    expect((await chat(t, p.model('good'))).status).toBe(200); // the half-open probe closes it
    const ok = await eventually(p.id, (x) => x['traffic_state'] === 'ok');
    expect(Number(ok['traffic_seq'])).toBeGreaterThan(Number(failing['traffic_seq']));
  });

  it('per-model refusals and sub-threshold failures do not change health', async () => {
    const t = await tenant();
    const p = await provider(t, 'refusal');
    await pool.query(`UPDATE provider SET status='ok', status_rev=1, health_rev=1 WHERE id=$1`, [
      p.id,
    ]);
    await chat(t, p.model('noperm'));
    await chat(t, p.model('badreq'));
    for (let i = 0; i < CFG.threshold - 1; i += 1) await chat(t, p.model('unauth'));
    await sleep(150);
    expect(await health(p.id)).toMatchObject({ status: 'ok', traffic_state: null });
  });

  it('a slow or failing health write never delays or alters the request', async () => {
    const t = await tenant();
    const p = await provider(t, 'slowwrite');
    await pool.query(`UPDATE provider SET status='error', status_rev=1, health_rev=1 WHERE id=$1`, [
      p.id,
    ]);
    jest
      .spyOn(port.providers, 'setHealth')
      .mockImplementation(() => new Promise<boolean>(() => undefined));
    const started = Date.now();
    const res = await chat(t, p.model('good'));
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toContain('Hello from stub');
    expect(Date.now() - started).toBeLessThan(5_000);
    jest.spyOn(port.providers, 'setHealth').mockRejectedValue(new Error('db down'));
    expect((await chat(t, p.model('good'))).status).toBe(200);
  });

  it('while the shared breaker store is down, traffic records nothing', async () => {
    const t = await tenant();
    const p = await provider(t, 'fallback');
    store.down = true;
    await trip(t, p.model('unauth'));
    await chat(t, p.model('good'));
    await sleep(150);
    expect(await health(p.id)).toMatchObject({ traffic_state: null });
  });

  it("one tenant's traffic writes only that tenant's provider", async () => {
    const a = await tenant();
    const b = await tenant();
    const pa = await provider(a, 'ten-a');
    const pb = await provider(b, 'ten-b');
    await trip(a, pa.model('unauth'));
    await eventually(pa.id, (x) => x['traffic_state'] === 'failing');
    expect(await health(pb.id)).toMatchObject({ traffic_state: null, status: 'unknown' });
    const listed = await request(server).get('/api/providers').set('x-test-user', b.userId);
    expect((listed.body as Array<{ id: string }>).map((x) => x.id)).toEqual([pb.id]);
  });
});
