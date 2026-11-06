// Provider-management HTTP + real-adapter e2e. Uses a stub principal guard
// (reads `x-test-user`) instead of the session plane, so this file never imports
// better-auth — keeping it clear of auth.e2e's single-ESM-import constraint.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  POLYROUTER_USER_AGENT,
  encryptSecret,
  userPrincipal,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { createProviderAdapter } from '@polyrouter/data-plane';
import type { ConnectionResult, ProviderAdapter, ProviderModelInfo } from '@polyrouter/data-plane';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import {
  PROVIDER_ADAPTER_FACTORY,
  ProvidersService,
  type ProviderAdapterFactory,
} from '../../src/providers/providers.service';
import { ProvidersModule } from '../../src/providers/providers.module';
import { uniqueEmail } from '../auth/auth-harness';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/providers/providers.config';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

/** Stub the session plane: `x-test-user: <id>` becomes the principal. */
@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

let nextTest: () => ConnectionResult = () => ({ ok: true, models: 0 });
let nextModels: () => ProviderModelInfo[] = () => [];
const fakeFactory: ProviderAdapterFactory = (() =>
  ({
    protocol: 'openai_compatible',
    chat: () => Promise.reject(new Error('n/a')),
    chatStream: async function* () {
      /* n/a */
    },
    testConnection: () => Promise.resolve(nextTest()),
    listModels: () => Promise.resolve(nextModels()),
  }) as unknown as ProviderAdapter) as unknown as ProviderAdapterFactory;

const CUSTOM = {
  name: 'p',
  kind: 'custom',
  protocol: 'openai_compatible',
  baseUrl: 'https://1.1.1.1/v1',
};

describe('provider management', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let alice: string;
  let bob: string;
  let stub: http.Server;
  let stubPort: number;
  /** One entry per `/models` request the stub served: the raw `user-agent` header
   * values it received, in any case (add-honest-user-agent). */
  let stubUserAgents: string[][] = [];

  const mkUser = async (): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'u', $1, false) RETURNING id`,
        [uniqueEmail('prov')],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    stub = http.createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        stubUserAgents.push(
          req.rawHeaders.filter(
            (_v, i) => i % 2 === 1 && /^user-agent$/i.test(req.rawHeaders[i - 1]!),
          ),
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-a' }, { id: 'stub-b' }] }));
      } else {
        res.writeHead(404).end('{}');
      }
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    stubPort = (stub.address() as AddressInfo).port;

    const moduleRef = await Test.createTestingModule({
      imports: [ProvidersModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    })
      .overrideProvider(PROVIDER_ADAPTER_FACTORY)
      .useValue(fakeFactory)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    alice = await mkUser();
    bob = await mkUser();
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[alice, bob]]);
    await app.close();
    await pool.end();
    stub.close();
  });

  /** Catalog keys the capability tests seed. `model_price` is GLOBAL and
   * append-only (no owner, no delete through the port), so unlike providers it
   * does not fall out with the tenant — it is cleared here explicitly, or the
   * next run collides on `(model_key, valid_from)`. */
  const TEST_CATALOG_KEYS = [
    'openrouter:openai/cap-exact',
    'anthropic:cap-native',
    'openrouter:vendor/contested',
  ];

  beforeEach(async () => {
    await pool.query('DELETE FROM provider WHERE owner_user_id = ANY($1)', [[alice, bob]]);
    await pool.query('DELETE FROM model_price WHERE model_key = ANY($1)', [TEST_CATALOG_KEYS]);
    nextTest = () => ({ ok: true, models: 0 });
    nextModels = () => [];
    stubUserAgents = [];
  });

  /** Direct-construction helper for the in-process service tests: passthrough lock
   * facilities + a plain-unwrap oauth stub (no OAuth envelopes are minted here). */
  function mkSvc(
    port: PersistencePort,
    f: ProviderAdapterFactory,
    rt: { key: string; mode: 'selfhosted' | 'cloud' },
  ): ProvidersService {
    const facilities = {
      withAdvisoryLock: (_k: number, fn: (tx: PersistencePort) => Promise<unknown>) => fn(port),
    } as unknown as import('@polyrouter/shared/server').PersistenceFacilities;
    const oauth = {
      presetFor: () => undefined,
      resolveCredential: () => Promise.reject(new Error('not used in this test')),
    } as unknown as import('../../src/subscription-oauth/subscription-oauth.service').SubscriptionOauthService;
    return new ProvidersService(port, facilities, f, rt, oauth);
  }

  const asAlice = (): request.Test =>
    request(server).post('/api/providers').set('x-test-user', alice);

  it('encrypts the credential at rest; never returns it', async () => {
    const res = await asAlice().send({ ...CUSTOM, credential: 'sk-secret-e2e' });
    expect(res.status).toBe(201);
    expect(res.body.hasCredential).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('sk-secret-e2e');
    const rows = await pool.query<{ encrypted_credentials: string | null }>(
      'SELECT encrypted_credentials FROM provider WHERE id = $1',
      [res.body.id],
    );
    const stored = rows.rows[0]?.encrypted_credentials ?? '';
    expect(stored).toMatch(/^poly-enc:/);
    expect(stored).not.toContain('sk-secret-e2e');
  });

  // add-provider-health-signals (task 1.4): the list returns the DISPLAYED health
  // — whichever record was recorded last, by revision, never by timestamp — with a
  // fixed label, and never the sequence, the revisions, or the envelope.
  it('exposes displayed health by recording order, with fixed labels and nothing internal', async () => {
    const created = await asAlice().send({ ...CUSTOM, credential: 'sk-health-secret' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const listOne = async (): Promise<Record<string, unknown>> => {
      const res = await request(server).get('/api/providers').set('x-test-user', alice);
      const row = (res.body as Array<Record<string, unknown>>).find((p) => p['id'] === id);
      if (!row) throw new Error('provider missing from list');
      return row;
    };
    // A fresh provider: no recorded health.
    expect((await listOne())['health']).toEqual({
      state: 'unknown',
      kind: null,
      message: null,
      source: null,
      at: null,
    });
    // Check recorded FIRST (rev 1, a LATER timestamp), traffic recorded AFTER (rev 2).
    await pool.query(
      `UPDATE provider SET status='error', last_error_kind='auth', status_source='test',
         status_changed_at = now() + interval '1 hour', status_rev=1,
         traffic_state='ok', traffic_at=now(), traffic_seq=123456, traffic_rev=2, health_rev=2
       WHERE id=$1`,
      [id],
    );
    let row = await listOne();
    expect(row['health']).toMatchObject({ state: 'ok', kind: null, source: 'traffic' });
    expect(row['lastErrorKind']).toBe('auth');
    expect(row['lastErrorMessage']).toBe('authentication failed');
    // The check re-recorded after the traffic record wins, despite an older timestamp.
    await pool.query(
      `UPDATE provider SET status_changed_at = now() - interval '1 hour', status_rev=3, health_rev=3
       WHERE id=$1`,
      [id],
    );
    row = await listOne();
    expect(row['health']).toMatchObject({
      state: 'error',
      kind: 'auth',
      message: 'authentication failed',
      source: 'test',
    });
    const body = JSON.stringify(row);
    for (const internal of [
      'trafficSeq',
      'statusRev',
      'trafficRev',
      'healthRev',
      'encryptedCredentials',
    ]) {
      expect(row).not.toHaveProperty(internal);
    }
    expect(body).not.toContain('123456');
    expect(body).not.toContain('sk-health-secret');
    expect(body).not.toContain('poly-enc:');
  });

  it('an edit resets health for the new credential or endpoint; a name-only edit does not', async () => {
    const created = await asAlice().send({ ...CUSTOM, credential: 'sk-edit-1' });
    const id = created.body.id as string;
    const seed = (): Promise<unknown> =>
      pool.query(
        `UPDATE provider SET status='error', last_error_kind='auth', status_source='test',
           status_changed_at=now(), status_rev=1, traffic_state='failing', traffic_error_kind='auth',
           traffic_at=now(), traffic_seq=10, traffic_rev=2, health_rev=2 WHERE id=$1`,
        [id],
      );
    const health = async (): Promise<Record<string, unknown>> =>
      (
        await pool.query<Record<string, unknown>>(
          `SELECT status, last_error_kind, status_source, traffic_state, traffic_seq, health_rev
             FROM provider WHERE id=$1`,
          [id],
        )
      ).rows[0]!;
    const patch = (body: Record<string, unknown>): request.Test =>
      request(server).patch(`/api/providers/${id}`).set('x-test-user', alice).send(body);

    await seed();
    expect((await patch({ name: 'renamed' })).status).toBe(200);
    expect(await health()).toMatchObject({
      status: 'error',
      traffic_state: 'failing',
      health_rev: '2',
    });

    for (const body of [{ credential: 'sk-edit-2' }, { baseUrl: 'https://1.0.0.1/v1' }]) {
      await seed();
      const res = await patch(body);
      expect(res.status).toBe(200);
      expect(await health()).toMatchObject({
        status: 'unknown',
        last_error_kind: null,
        status_source: 'edit',
        traffic_state: null,
        traffic_seq: null,
        health_rev: '3',
      });
      expect(res.body.health).toMatchObject({ state: 'unknown', source: 'edit' });
    }
  });

  it('rejects a private/metadata or userinfo base_url with 422', async () => {
    for (const baseUrl of [
      'http://169.254.169.254/v1',
      'http://10.0.0.1/v1',
      'https://user:tok@1.1.1.1/v1',
    ]) {
      expect((await asAlice().send({ ...CUSTOM, baseUrl })).status).toBe(422);
    }
  });

  it('accepts a local loopback provider under self-host', async () => {
    const res = await asAlice().send({
      name: 'ollama',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('local');
  });

  it('accepts the canonical TLD-less local host (A-42), still SSRF-gated for non-local', async () => {
    // `localhost` is a single-label host that the old `@IsUrl` require_tld rejected
    // outright (a 400 shape error) — the canonical Ollama URL. It must now pass the
    // shape check and be accepted for a local provider under self-host.
    const ok = await asAlice().send({
      name: 'ollama-host',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'http://localhost:11434',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe('local');
    // The address decision still belongs to the SSRF gate: the same TLD-less
    // loopback host for a `custom` provider is rejected (loopback is local-only).
    const gated = await asAlice().send({
      ...CUSTOM,
      baseUrl: 'http://localhost:11434',
      credential: 'k',
    });
    expect(gated.status).toBe(422);
  });

  // fix-4xx-error-taxonomy. The Responses / subscription-OAuth contracts said
  // "401/403 → auth". A 403 is now a typed `permission` failure: still never masked
  // as healthy, still sets the provider to error — but it does NOT imply the
  // credential needs reauthorizing, because the credential is valid.
  it('a 403 probe surfaces permission — errored, sanitized, and not a reauthorize prompt', async () => {
    const created = await asAlice().send({ ...CUSTOM, credential: 'sk-perm-e2e' });
    nextTest = () => ({
      ok: false,
      kind: 'permission',
      message: 'your key may not use this model',
    });
    const res = await request(server)
      .post(`/api/providers/${created.body.id}/test-connection`)
      .set('x-test-user', alice);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    // the operator gets a label of its own, never the generic fallback and never
    // wording that sends them to rotate a working key
    expect(String(res.body.message)).toBe('permission denied for this model or region');
    expect(String(res.body.message)).not.toMatch(/authentication failed/i);
    expect(JSON.stringify(res.body)).not.toContain('sk-perm-e2e');
    const after = await request(server)
      .get(`/api/providers/${created.body.id}`)
      .set('x-test-user', alice);
    expect(after.body.status).toBe('error'); // never masked as healthy
    // the reauthorize affordance is driven by the DURABLE credential condition,
    // which a permission denial must not set
    expect(after.body.credentialError ?? null).not.toBe('reauthorize_required');
  });

  it('a 401 probe still surfaces auth', async () => {
    const created = await asAlice().send({ ...CUSTOM, credential: 'sk-auth-e2e' });
    nextTest = () => ({ ok: false, kind: 'auth', message: 'invalid key' });
    const res = await request(server)
      .post(`/api/providers/${created.body.id}/test-connection`)
      .set('x-test-user', alice);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.message)).toBe('authentication failed');
  });

  it('test-connection sets status and stays sanitized on a reflected-credential failure', async () => {
    const created = await asAlice().send({ ...CUSTOM, credential: 'sk-reflect-e2e' });
    nextTest = () => ({ ok: false, kind: 'bad_request', message: 'upstream said sk-reflect-e2e' });
    const res = await request(server)
      .post(`/api/providers/${created.body.id}/test-connection`)
      .set('x-test-user', alice);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('sk-reflect-e2e');
    const after = await request(server)
      .get(`/api/providers/${created.body.id}`)
      .set('x-test-user', alice);
    expect(after.body.status).toBe('error');
  });

  it('sync-models creates models with null prices; delete cascades them', async () => {
    const created = await asAlice().send({ ...CUSTOM, credential: 'k' });
    nextModels = () => [{ id: 'm1', displayName: 'M1' }, { id: 'm1' }, { id: 'm2' }];
    const sync = await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);
    expect(sync.body.synced).toBe(2);

    const models = await request(server).get('/api/models').set('x-test-user', alice);
    expect(models.body).toHaveLength(2);
    expect(models.body.every((m: { isFree: boolean }) => m.isFree === false)).toBe(true);

    await request(server)
      .delete(`/api/providers/${created.body.id}`)
      .set('x-test-user', alice)
      .expect(200);
    expect((await request(server).get('/api/models').set('x-test-user', alice)).body).toHaveLength(
      0,
    );
  });

  // --- add-provider-price-sync-and-edit: provider-listed price as a DISPLAY estimate ---

  const OR = {
    name: 'openrouter',
    kind: 'api_key',
    protocol: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  };
  const listModelsFor = (user: string): request.Test =>
    request(server).get('/api/models').set('x-test-user', user);

  it('captures a provider-listed price as a display estimate, never as catalog/billing data', async () => {
    const created = await asAlice().send({ ...OR, credential: 'k' });
    nextModels = () => [
      { id: 'moonshotai/kimi-listed-probe', pricing: { inputPricePer1m: 3, outputPricePer1m: 15 } },
    ];
    const sync = await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);
    expect(sync.body.synced).toBe(1);
    expect(sync.body.pricesCaptured).toBe(1);

    const list = await listModelsFor(alice);
    const model = list.body.find(
      (m: { externalModelId: string }) => m.externalModelId === 'moonshotai/kimi-listed-probe',
    );
    // Effective price is the LISTED estimate, flagged; billing columns stay null.
    expect(model.effectivePrice).toMatchObject({
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      source: 'listed',
      estimated: true,
    });
    expect(model.inputPricePer1m).toBeNull();
    expect(model.outputPricePer1m).toBeNull();
    // The global catalog is NOT written by a sync (invariant 4): the synced model's
    // derived key has no catalog row (a shared test DB may hold unrelated openrouter rows,
    // so assert the specific key, not a prefix count).
    const cat = await pool.query<{ n: string }>(
      "SELECT count(*)::text n FROM model_price WHERE model_key = 'openrouter:moonshotai/kimi-listed-probe'",
    );
    expect(cat.rows[0]!.n).toBe('0');

    await request(server)
      .delete(`/api/providers/${created.body.id}`)
      .set('x-test-user', alice)
      .expect(200);
  });

  it('a priceless sync captures no estimate (unpriced)', async () => {
    const created = await asAlice().send({ ...OR, credential: 'k' });
    nextModels = () => [{ id: 'vendor/no-price' }];
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice)
      .expect(200);
    const list = await listModelsFor(alice);
    const model = list.body.find(
      (m: { externalModelId: string }) => m.externalModelId === 'vendor/no-price',
    );
    expect(model.effectivePrice).toBeNull();
    await request(server).delete(`/api/providers/${created.body.id}`).set('x-test-user', alice);
  });

  it('a later priceless re-sync clears a stale estimate', async () => {
    const created = await asAlice().send({ ...OR, credential: 'k' });
    nextModels = () => [{ id: 'x/model', pricing: { inputPricePer1m: 2, outputPricePer1m: 4 } }];
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);
    // Re-sync: the same model but now with no price → the estimate must be cleared.
    nextModels = () => [{ id: 'x/model' }];
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);
    const list = await listModelsFor(alice);
    expect(list.body[0].effectivePrice).toBeNull();
    await request(server).delete(`/api/providers/${created.body.id}`).set('x-test-user', alice);
  });

  it('a base_url change clears the listed estimates AND the derived classification', async () => {
    const created = await asAlice().send({ ...OR, credential: 'k' });
    nextModels = () => [
      { id: 'y/model:batch', pricing: { inputPricePer1m: 1, outputPricePer1m: 2 } },
    ];
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);
    // Change the endpoint → the estimate captured from the old one must be dropped.
    await request(server)
      .patch(`/api/providers/${created.body.id}`)
      .set('x-test-user', alice)
      .send({ baseUrl: 'https://openrouter.ai/v1' })
      .expect(200);
    const list = await listModelsFor(alice);
    expect(list.body[0].effectivePrice).toBeNull();
    // Both were derived from the old endpoint's family: a retained model must not
    // stay non-routable on a provider now pointed elsewhere
    // (add-model-variant-detection).
    expect(list.body[0].variant).toBeNull();
    // A name-only edit leaves an estimate intact (control).
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);
    await request(server)
      .patch(`/api/providers/${created.body.id}`)
      .set('x-test-user', alice)
      .send({ name: 'renamed' })
      .expect(200);
    const after = await listModelsFor(alice);
    expect(after.body[0].effectivePrice).not.toBeNull();
    // The re-sync also re-derives the classification — which is only possible
    // because `variant` rides the upsert's ON CONFLICT set (a first-insert-only
    // write would have frozen the cleared null forever).
    expect(after.body[0].variant).toBe('batch');
    await request(server).delete(`/api/providers/${created.body.id}`).set('x-test-user', alice);
  });

  it('the models-list is_free filter uses the effective price', async () => {
    const created = await asAlice().send({ ...OR, credential: 'k' });
    nextModels = () => [
      { id: 'free/one', pricing: { inputPricePer1m: 0, outputPricePer1m: 0, isFree: true } },
      { id: 'paid/one', pricing: { inputPricePer1m: 5, outputPricePer1m: 5 } },
    ];
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);
    const free = await request(server).get('/api/models?isFree=true').set('x-test-user', alice);
    const ids = free.body.map((m: { externalModelId: string }) => m.externalModelId);
    expect(ids).toContain('free/one');
    expect(ids).not.toContain('paid/one');
    await request(server).delete(`/api/providers/${created.body.id}`).set('x-test-user', alice);
  });

  it('resolves capability from the catalog, with provenance, scoped to the tenant', async () => {
    const port = app.get<PersistencePort>(PERSISTENCE_PORT);
    const at = new Date('2020-01-01T00:00:00.000Z');
    // The EXACT channel key describes one model; only the NATIVE-FAMILY key
    // describes the other, so the second must come back marked as an estimate.
    await port.pricing.insertVersion({
      modelKey: 'openrouter:openai/cap-exact',
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      contextWindow: 128_000,
      supportsTools: true,
      supportsVision: false, // an ASSERTED negative
      source: 'manual',
      validFrom: at,
    });
    await port.pricing.insertVersion({
      modelKey: 'anthropic:cap-native',
      inputPricePer1m: 3,
      outputPricePer1m: 4,
      supportsVision: true,
      source: 'manual',
      validFrom: at,
    });

    const created = await asAlice().send({ ...OR, credential: 'k' });
    nextModels = () => [
      { id: 'openai/cap-exact' },
      { id: 'anthropic/cap-native' },
      { id: 'nobody/knows-this' }, // no catalog row at any tier -> unknown
    ];
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);

    const body = (await listModelsFor(alice)).body as Record<string, unknown>[];
    const byExt = new Map(body.map((m) => [m.externalModelId as string, m]));

    const exact = byExt.get('openai/cap-exact')!;
    expect(exact).toMatchObject({ supportsTools: true, supportsVision: false });
    expect(exact).not.toHaveProperty('supportsReasoning'); // the row is silent
    expect(exact).not.toHaveProperty('capabilitiesEstimated');

    const native = byExt.get('anthropic/cap-native')!;
    expect(native).toMatchObject({ supportsVision: true, capabilitiesEstimated: true });

    // No tier describes this one: unknown is ABSENT, never a rendered false.
    const unknown = byExt.get('nobody/knows-this')!;
    expect(unknown).not.toHaveProperty('supportsTools');
    expect(unknown).not.toHaveProperty('supportsVision');

    // Capability filters match the RESOLVED value and never match unknown.
    const toolsYes = await request(server)
      .get('/api/models?supportsTools=true')
      .set('x-test-user', alice);
    const yesIds = toolsYes.body.map((m: { externalModelId: string }) => m.externalModelId);
    expect(yesIds).toEqual(['openai/cap-exact']);
    const visionNo = await request(server)
      .get('/api/models?supportsVision=false')
      .set('x-test-user', alice);
    const noIds = visionNo.body.map((m: { externalModelId: string }) => m.externalModelId);
    expect(noIds).toEqual(['openai/cap-exact']);

    // Tenant scoping is unaffected: the catalog is global, the models are not.
    expect((await listModelsFor(bob)).body).toEqual([]);

    await request(server).delete(`/api/providers/${created.body.id}`).set('x-test-user', alice);
  });

  it('captures a provider capability claim as the ladder LAST tier, never as catalog data', async () => {
    const port = app.get<PersistencePort>(PERSISTENCE_PORT);
    const before = (await port.pricing.listLatest(new Date())).length;

    const created = await asAlice().send({ ...OR, credential: 'k' });
    nextModels = () => [
      {
        id: 'vendor/claimed',
        capabilities: { supportsVision: true, supportsTools: false, contextWindow: 65_536 },
      },
      { id: 'vendor/silent' },
    ];
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);

    const byExt = new Map(
      ((await listModelsFor(alice)).body as Record<string, unknown>[]).map((m) => [
        m.externalModelId as string,
        m,
      ]),
    );
    const claimed = byExt.get('vendor/claimed')!;
    // No catalog row exists for this id at any tier, so the claim is what answers —
    // and because it sits below the exact key, it is ALWAYS marked an estimate.
    expect(claimed).toMatchObject({
      supportsVision: true,
      supportsTools: false,
      contextWindow: 65_536,
      capabilitiesEstimated: true,
    });
    expect(claimed).not.toHaveProperty('supportsReasoning'); // the provider was silent

    // A model the provider says nothing about stays unknown.
    const silent = byExt.get('vendor/silent')!;
    expect(silent).not.toHaveProperty('supportsVision');
    expect(silent).not.toHaveProperty('capabilitiesEstimated');

    // The claim NEVER reaches the global catalog — it is per-provider display data.
    expect((await port.pricing.listLatest(new Date())).length).toBe(before);

    await request(server).delete(`/api/providers/${created.body.id}`).set('x-test-user', alice);
  });

  it('never lets a provider claim override what the catalog states', async () => {
    const port = app.get<PersistencePort>(PERSISTENCE_PORT);
    await port.pricing.insertVersion({
      modelKey: 'openrouter:vendor/contested',
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      supportsVision: false, // the catalog says NO
      source: 'manual',
      validFrom: new Date('2020-01-01T00:00:00.000Z'),
    });
    const created = await asAlice().send({ ...OR, credential: 'k' });
    nextModels = () => [
      { id: 'vendor/contested', capabilities: { supportsVision: true } }, // the provider says YES
    ];
    await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);

    const m = ((await listModelsFor(alice)).body as Record<string, unknown>[]).find(
      (x) => x.externalModelId === 'vendor/contested',
    )!;
    // The catalog wins, and nothing is marked estimated — the exact key answered.
    expect(m.supportsVision).toBe(false);
    expect(m).not.toHaveProperty('capabilitiesEstimated');

    await request(server).delete(`/api/providers/${created.body.id}`).set('x-test-user', alice);
  });

  it('an endpoint change during an in-flight sync does not persist the old endpoint estimate', async () => {
    const port = app.get<PersistencePort>(PERSISTENCE_PORT);
    const principal: Principal = userPrincipal(alice);
    const provider = await port.providers.insert(principal, {
      name: 'race',
      kind: 'api_key',
      protocol: 'openai_compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      encryptedCredentials: encryptSecret('k', 'a'.repeat(64)),
    });
    // Adapter whose listModels flips the provider's base_url mid-call (simulating a
    // concurrent PATCH), then returns a price captured from the OLD endpoint.
    const racingFactory: ProviderAdapterFactory = (() =>
      ({
        protocol: 'openai_compatible',
        chat: () => Promise.reject(new Error('n/a')),
        chatStream: async function* () {
          /* n/a */
        },
        testConnection: () => Promise.resolve({ ok: true, models: 0 }),
        listModels: async () => {
          await port.providers.update(principal, provider.id, {
            baseUrl: 'https://openrouter.ai/v1',
          });
          // A `:batch` id so the CLASSIFICATION is exercised too: it would classify
          // on the original (aggregator) endpoint, and must not once it moved.
          return [
            {
              id: 'race/model:batch',
              pricing: { inputPricePer1m: 9, outputPricePer1m: 9 },
              // A capability claim from the OLD endpoint must not attach to the
              // new one either (honest-model-capabilities).
              capabilities: { supportsVision: true, supportsTools: true },
            },
          ];
        },
      }) as unknown as ProviderAdapter) as unknown as ProviderAdapterFactory;
    const svc = mkSvc(port, racingFactory, { key: 'a'.repeat(64), mode: 'selfhosted' });
    const res = await svc.syncModels(principal, provider.id);
    expect(res.ok).toBe(true);
    expect(res.pricesCaptured).toBe(0); // the moved endpoint voids the capture
    const models = await svc.listModels(principal, {});
    const m = models.find((x) => x.externalModelId === 'race/model:batch');
    expect(m?.effectivePrice ?? null).toBeNull();
    // The moved endpoint voids the classification exactly as it voids the price
    // (add-model-variant-detection): both were derived from the old family.
    expect(m?.variant ?? null).toBeNull();
    // …and the capability claim, for the same reason: it is the OLD provider's
    // statement about the OLD provider's models.
    expect(m).not.toHaveProperty('supportsVision');
    expect(m).not.toHaveProperty('supportsTools');
    await port.providers.remove(principal, provider.id);
  });

  it('cross-tenant access fails closed (404) and the models list is scoped', async () => {
    const created = await asAlice().send({ ...CUSTOM, credential: 'k' });
    const id = created.body.id;
    const attempts: Array<() => request.Test> = [
      () => request(server).get(`/api/providers/${id}`).set('x-test-user', bob),
      () =>
        request(server).patch(`/api/providers/${id}`).set('x-test-user', bob).send({ name: 'x' }),
      () => request(server).delete(`/api/providers/${id}`).set('x-test-user', bob),
      () => request(server).post(`/api/providers/${id}/sync-models`).set('x-test-user', bob),
    ];
    for (const make of attempts) {
      expect((await make()).status).toBe(404);
    }
    expect(
      (await request(server).get(`/api/providers/${id}`).set('x-test-user', alice)).status,
    ).toBe(200);
    expect((await request(server).get('/api/models').set('x-test-user', bob)).body).toEqual([]);
    expect((await request(server).get('/api/providers').set('x-test-user', bob)).body).toEqual([]);
  });

  it('unauthenticated requests are rejected', async () => {
    expect((await request(server).get('/api/providers')).status).toBe(401);
  });

  it('default wiring: the real adapter connects, syncs, and upserts atomically over a loopback stub', async () => {
    const port = app.get<PersistencePort>(PERSISTENCE_PORT);
    const principal: Principal = userPrincipal(alice);
    const svc = mkSvc(port, createProviderAdapter, { key: 'a'.repeat(64), mode: 'selfhosted' });
    const provider = await port.providers.insert(principal, {
      name: 'stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    });
    expect((await svc.testConnection(principal, provider.id)).ok).toBe(true);
    expect((await svc.syncModels(principal, provider.id)).synced).toBe(2);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        port.models.upsertForProvider(principal, provider.id, {
          externalModelId: 'shared',
          lastSyncedAt: new Date(),
        }),
      ),
    );
    expect(results.every((r) => r !== null)).toBe(true);
    const shared = (await port.models.listForPrincipal(principal)).filter(
      (m) => m.externalModelId === 'shared',
    );
    expect(shared).toHaveLength(1);
  });

  // add-honest-user-agent: provider management announces polyrouter on the wire,
  // and the User-Agent is not a user-configurable field.
  it('test-connection and sync-models each send exactly one polyrouter User-Agent', async () => {
    const port = app.get<PersistencePort>(PERSISTENCE_PORT);
    const principal: Principal = userPrincipal(alice);
    const svc = mkSvc(port, createProviderAdapter, { key: 'a'.repeat(64), mode: 'selfhosted' });
    const provider = await port.providers.insert(principal, {
      name: 'ua-stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    });
    expect((await svc.testConnection(principal, provider.id)).ok).toBe(true);
    const afterTest = stubUserAgents.length;
    expect(afterTest).toBeGreaterThan(0);
    expect((await svc.syncModels(principal, provider.id)).synced).toBe(2);
    expect(stubUserAgents.length).toBeGreaterThan(afterTest);
    for (const seen of stubUserAgents) expect(seen).toEqual([POLYROUTER_USER_AGENT]);
  });

  it('refuses a userAgent field on create and update with a 400 and stores nothing', async () => {
    const created = await asAlice().send({ ...CUSTOM, userAgent: 'evil/1.0' });
    expect(created.status).toBe(400);
    expect(JSON.stringify(created.body)).toContain('userAgent');
    const none = await pool.query('SELECT 1 FROM provider WHERE owner_user_id = $1', [alice]);
    expect(none.rowCount).toBe(0);

    const ok = await asAlice().send(CUSTOM);
    expect(ok.status).toBe(201);
    const id = ok.body.id as string;
    const before = await pool.query('SELECT * FROM provider WHERE id = $1', [id]);
    const patched = await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ userAgent: 'evil/1.0' });
    expect(patched.status).toBe(400);
    const after = await pool.query('SELECT * FROM provider WHERE id = $1', [id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(JSON.stringify(after.rows[0])).not.toContain('evil/1.0');
  });

  // ---- add-live-subscription-models: unlisted models (task 6.1) ----
  describe('unlisted models (add-live-subscription-models)', () => {
    const CUSTOM = {
      name: 'custom',
      kind: 'custom',
      protocol: 'openai_compatible',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'k',
    };
    const sync = (id: string, list: ProviderModelInfo[]): request.Test => {
      nextModels = () => list;
      return request(server).post(`/api/providers/${id}/sync-models`).set('x-test-user', alice);
    };
    type M = { id: string; externalModelId: string; unlistedSince: string | null };
    const modelsOf = async (providerId: string, who = alice): Promise<M[]> =>
      (
        (await request(server).get(`/api/models?providerId=${providerId}`).set('x-test-user', who))
          .body as M[]
      ).sort((x, y) => x.externalModelId.localeCompare(y.externalModelId));
    const byExt = (list: M[], ext: string): M => list.find((m) => m.externalModelId === ext)!;

    it('flags a model the provider stopped listing, keeps the first time, and clears it on return', async () => {
      const { body: p } = await asAlice().send(CUSTOM);
      await sync(p.id, [{ id: 'keep' }, { id: 'retired' }]).expect(200);
      expect((await modelsOf(p.id)).every((m) => m.unlistedSince === null)).toBe(true);

      await sync(p.id, [{ id: 'keep' }]).expect(200);
      const first = byExt(await modelsOf(p.id), 'retired').unlistedSince;
      expect(first).not.toBeNull();
      expect(byExt(await modelsOf(p.id), 'keep').unlistedSince).toBeNull();

      await sync(p.id, [{ id: 'keep' }]).expect(200); // still absent: earliest kept
      expect(byExt(await modelsOf(p.id), 'retired').unlistedSince).toBe(first);

      await sync(p.id, [{ id: 'keep' }, { id: 'retired' }]).expect(200); // back again
      expect(byExt(await modelsOf(p.id), 'retired').unlistedSince).toBeNull();
    });

    it('an empty listing flags nothing', async () => {
      const { body: p } = await asAlice().send(CUSTOM);
      await sync(p.id, [{ id: 'a' }]).expect(200);
      await sync(p.id, []).expect(200);
      expect(byExt(await modelsOf(p.id), 'a').unlistedSince).toBeNull();
    });

    it('a listing made with a replaced credential flags nothing (incarnation guard)', async () => {
      const { body: p } = await asAlice().send(CUSTOM);
      await sync(p.id, [{ id: 'a' }, { id: 'b' }]).expect(200);
      const port = app.get<PersistencePort>(PERSISTENCE_PORT);
      const row = (await port.providers.findById(userPrincipal(alice), p.id))!;
      const stale = { envelope: 'an-older-cipher', baseUrl: row.baseUrl, protocol: row.protocol };
      const applied = await port.models.reconcileListing(
        userPrincipal(alice),
        p.id,
        ['a'],
        new Date(),
        stale,
      );
      expect(applied).toBe(false);
      expect(byExt(await modelsOf(p.id), 'b').unlistedSince).toBeNull();
      // Another tenant can never reconcile alice's provider, even with the right guard.
      const current = {
        envelope: row.encryptedCredentials,
        baseUrl: row.baseUrl,
        protocol: row.protocol,
      };
      expect(
        await port.models.reconcileListing(userPrincipal(bob), p.id, ['a'], new Date(), current),
      ).toBe(false);
      expect(byExt(await modelsOf(p.id), 'b').unlistedSince).toBeNull();
    });

    it('DELETE removes only an unlisted model: 204, 409 while listed, 404 across tenants', async () => {
      const { body: p } = await asAlice().send(CUSTOM);
      await sync(p.id, [{ id: 'keep' }, { id: 'gone' }]).expect(200);
      await sync(p.id, [{ id: 'keep' }]).expect(200);
      const list = await modelsOf(p.id);
      const gone = byExt(list, 'gone');
      const keep = byExt(list, 'keep');

      // Another tenant: 404 whether flagged or not — existence is not disclosed.
      await request(server).delete(`/api/models/${gone.id}`).set('x-test-user', bob).expect(404);
      await request(server).delete(`/api/models/${keep.id}`).set('x-test-user', bob).expect(404);
      // Still listed: 409, nothing changes.
      await request(server).delete(`/api/models/${keep.id}`).set('x-test-user', alice).expect(409);
      // Unlisted: removed.
      await request(server).delete(`/api/models/${gone.id}`).set('x-test-user', alice).expect(204);
      expect((await modelsOf(p.id)).map((m) => m.externalModelId)).toEqual(['keep']);
      await request(server).delete(`/api/models/${gone.id}`).set('x-test-user', alice).expect(404);
    });

    it('removal compacts tier positions; a model: rule keeps its (now unresolved) target', async () => {
      const { body: p } = await asAlice().send(CUSTOM);
      await sync(p.id, [{ id: 'm0' }, { id: 'm1' }, { id: 'm2' }]).expect(200);
      await sync(p.id, [{ id: 'm0' }, { id: 'm2' }]).expect(200);
      const list = await modelsOf(p.id);
      const port = app.get<PersistencePort>(PERSISTENCE_PORT);
      const who = userPrincipal(alice);
      const tier = await port.tiers.insert(who, { key: `unl-${Date.now()}` });
      for (const [i, ext] of ['m0', 'm1', 'm2'].entries()) {
        await port.routingEntries.add(who, {
          tierId: tier.id,
          modelId: byExt(list, ext).id,
          position: i,
        });
      }
      const rule = await port.routingRules.insert(who, {
        matchType: 'header',
        headerValue: 'unl',
        target: `model:${byExt(list, 'm1').id}`,
      });
      await request(server)
        .delete(`/api/models/${byExt(list, 'm1').id}`)
        .set('x-test-user', alice)
        .expect(204);
      const entries = await port.routingEntries.listForTier(who, tier.id);
      expect(entries.map((e) => [e.position, e.modelId])).toEqual([
        [0, byExt(list, 'm0').id],
        [1, byExt(list, 'm2').id],
      ]);
      expect((await port.routingRules.findById(who, rule.id))?.target).toBe(
        `model:${byExt(list, 'm1').id}`,
      );
      await port.routingRules.remove(who, rule.id);
      await port.tiers.remove(who, tier.id);
    });

    it('a base_url change clears the unlisted flag with the other endpoint-derived columns', async () => {
      const { body: p } = await asAlice().send(CUSTOM);
      await sync(p.id, [{ id: 'a' }, { id: 'b' }]).expect(200);
      await sync(p.id, [{ id: 'a' }]).expect(200);
      expect(byExt(await modelsOf(p.id), 'b').unlistedSince).not.toBeNull();
      await request(server)
        .patch(`/api/providers/${p.id}`)
        .set('x-test-user', alice)
        .send({ baseUrl: 'https://8.8.8.8/v1' })
        .expect(200);
      expect(byExt(await modelsOf(p.id), 'b').unlistedSince).toBeNull();
    });

    it('a re-sync rewrites the listed capability claim instead of freezing the first insert', async () => {
      const { body: p } = await asAlice().send(CUSTOM);
      await sync(p.id, [{ id: 'c', capabilities: { contextWindow: 1_000 } }]).expect(200);
      await sync(p.id, [{ id: 'c', capabilities: { contextWindow: 2_000 } }]).expect(200);
      const read = async (): Promise<{ w: number | null; at: Date | null }> => {
        const r = await pool.query<{ w: number | null; at: Date | null }>(
          `SELECT listed_context_window AS w, listed_capabilities_captured_at AS at
             FROM model WHERE provider_id = $1 AND external_model_id = 'c'`,
          [p.id],
        );
        return r.rows[0]!;
      };
      expect((await read()).w).toBe(2_000);
      await sync(p.id, [{ id: 'c' }]).expect(200); // claimless: cleared, not preserved
      expect(await read()).toEqual({ w: null, at: null });
    });
  });

  // ---- add-auto-prune-unlisted-models: the port-level prune (real Postgres) ----
  describe('auto-prune of unlisted models (add-auto-prune-unlisted-models)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = new Date('2026-10-31T12:00:00Z');
    const CUTOFF = new Date(NOW.getTime() - 7 * DAY);
    let tierSeq = 0;

    // Rules and tiers are not removed with a provider: clear this describe's own.
    beforeEach(async () => {
      await pool.query('DELETE FROM routing_rule WHERE owner_user_id = ANY($1)', [[alice, bob]]);
      await pool.query('DELETE FROM tier WHERE owner_user_id = ANY($1)', [[alice, bob]]);
    });

    const port = (): PersistencePort => app.get<PersistencePort>(PERSISTENCE_PORT);
    const who = (id = alice): Principal => userPrincipal(id);

    /** A custom provider owned by `owner`, with an optional auto-prune switch. */
    const mkProvider = async (owner = alice, autoPruneUnlisted = true) =>
      port().providers.insert(who(owner), {
        name: 'prune',
        kind: 'custom',
        protocol: 'openai_compatible',
        baseUrl: 'https://1.1.1.1/v1',
        autoPruneUnlisted,
      });
    const guardOf = async (providerId: string, owner = alice) => {
      const row = (await port().providers.findById(who(owner), providerId))!;
      return { envelope: row.encryptedCredentials, baseUrl: row.baseUrl, protocol: row.protocol };
    };
    /** A model row, unlisted since `since` (null = listed). Returns its id. */
    const mkModel = async (
      providerId: string,
      ext: string,
      since: Date | null,
      owner = alice,
    ): Promise<string> => {
      const row = (await port().models.upsertForProvider(who(owner), providerId, {
        externalModelId: ext,
        lastSyncedAt: NOW,
      }))!;
      await pool.query('UPDATE model SET unlisted_since = $1 WHERE id = $2', [since, row.id]);
      return row.id;
    };
    const prune = async (
      providerId: string,
      opts: {
        owner?: string;
        cancelled?: boolean;
        guard?: Awaited<ReturnType<typeof guardOf>>;
      } = {},
    ): Promise<number> =>
      port().models.pruneUnlisted(
        who(opts.owner ?? alice),
        providerId,
        CUTOFF,
        opts.guard ?? (await guardOf(providerId)),
        () => opts.cancelled === true,
      );
    const remaining = async (providerId: string): Promise<string[]> =>
      (
        await pool.query<{ e: string }>(
          'SELECT external_model_id AS e FROM model WHERE provider_id = $1 ORDER BY 1',
          [providerId],
        )
      ).rows.map((r) => r.e);
    const mkTier = async (owner = alice) =>
      port().tiers.insert(who(owner), { key: `prune-${Date.now()}-${++tierSeq}` });

    it('prunes a stale unreferenced model, keeps one inside the grace period, and honours the exact boundary', async () => {
      const p = await mkProvider();
      await mkModel(p.id, 'stale', new Date(CUTOFF.getTime() - DAY));
      await mkModel(p.id, 'boundary', CUTOFF); // exactly 7 days: pruned
      await mkModel(p.id, 'just-inside', new Date(CUTOFF.getTime() + 60_000)); // 6d23h59m
      await mkModel(p.id, 'listed', null);
      expect(await prune(p.id)).toBe(2);
      expect(await remaining(p.id)).toEqual(['just-inside', 'listed']);
    });

    it('a model flagged, cleared, then flagged again restarts its grace period', async () => {
      const p = await mkProvider();
      await mkModel(p.id, 'flap', new Date(CUTOFF.getTime() - 30 * DAY));
      const guard = await guardOf(p.id);
      // It returns: the reconcile clears the old flag…
      expect(await port().models.reconcileListing(who(), p.id, ['flap'], NOW, guard)).toBe(true);
      // …and a later listing omits it again: the flag restarts at the new time.
      expect(await port().models.reconcileListing(who(), p.id, ['other'], NOW, guard)).toBe(true);
      expect(await prune(p.id)).toBe(0);
      expect(await remaining(p.id)).toEqual(['flap']);
    });

    it('never prunes a model that sits in a tier chain, and leaves positions alone', async () => {
      const p = await mkProvider();
      const keep = await mkModel(p.id, 'in-chain', new Date(CUTOFF.getTime() - 30 * DAY));
      const drop = await mkModel(p.id, 'dropped', new Date(CUTOFF.getTime() - 30 * DAY));
      const other = await mkModel(p.id, 'listed', null);
      const tier = await mkTier();
      await port().routingEntries.add(who(), { tierId: tier.id, modelId: other, position: 0 });
      await port().routingEntries.add(who(), { tierId: tier.id, modelId: keep, position: 1 });
      expect(await prune(p.id)).toBe(1);
      expect(await remaining(p.id)).toEqual(['in-chain', 'listed']);
      const entries = await port().routingEntries.listForTier(who(), tier.id);
      expect(entries.map((e) => [e.modelId, e.position])).toEqual([
        [other, 0],
        [keep, 1],
      ]);
      expect(drop).toBeDefined();
    });

    it.each([
      ['header', { headerValue: 'x' }],
      ['default', {}],
      ['auto_high', {}],
      ['auto_low', {}],
      ['auto_workload', { workloadClass: 'code' }],
      ['auto_high', { workloadClass: 'vision' }], // a workload-scoped band
    ] as const)('never prunes a model that is a %s rule target %j', async (matchType, extra) => {
      const p = await mkProvider();
      const id = await mkModel(p.id, 'targeted', new Date(CUTOFF.getTime() - 30 * DAY));
      await mkModel(p.id, 'free', new Date(CUTOFF.getTime() - 30 * DAY));
      await port().routingRules.insert(who(), { matchType, target: `model:${id}`, ...extra });
      expect(await prune(p.id)).toBe(1);
      expect(await remaining(p.id)).toEqual(['targeted']);
    });

    it('prunes nothing while the provider switch is off, and the flag survives', async () => {
      const p = await mkProvider(alice, false);
      await mkModel(p.id, 'stale', new Date(CUTOFF.getTime() - 30 * DAY));
      expect(await prune(p.id)).toBe(0);
      expect(await remaining(p.id)).toEqual(['stale']);
    });

    it('prunes nothing for a replaced credential, another tenant, or a cancelled caller', async () => {
      const p = await mkProvider();
      await mkModel(p.id, 'stale', new Date(CUTOFF.getTime() - 30 * DAY));
      const current = await guardOf(p.id);
      expect(await prune(p.id, { guard: { ...current, envelope: 'an-older-cipher' } })).toBe(0);
      expect(await prune(p.id, { owner: bob, guard: current })).toBe(0);
      expect(await prune(p.id, { cancelled: true })).toBe(0);
      expect(await remaining(p.id)).toEqual(['stale']);
      expect(await prune(p.id)).toBe(1); // the same call, uncancelled and current, prunes
    });

    it("two tenants with the same external id: only the syncing tenant's row is pruned", async () => {
      const a = await mkProvider(alice);
      const b = await mkProvider(bob);
      const old = new Date(CUTOFF.getTime() - 30 * DAY);
      await mkModel(a.id, 'shared', old, alice);
      await mkModel(b.id, 'shared', old, bob);
      expect(await prune(a.id)).toBe(1);
      expect(await remaining(a.id)).toEqual([]);
      expect(await remaining(b.id)).toEqual(['shared']);
    });

    it('prunes a stale :batch twin on its own evidence and keeps its referenced base', async () => {
      const p = await mkProvider();
      const base = await mkModel(p.id, 'openai/gpt-x', null);
      const twin = await mkModel(p.id, 'openai/gpt-x:batch', new Date(CUTOFF.getTime() - DAY));
      await pool.query(`UPDATE model SET variant = 'batch' WHERE id = $1`, [twin]);
      const tier = await mkTier();
      await port().routingEntries.add(who(), { tierId: tier.id, modelId: base, position: 0 });
      expect(await prune(p.id)).toBe(1);
      expect(await remaining(p.id)).toEqual(['openai/gpt-x']);
    });

    // ---- through the HTTP surface: the switch, and a real sync pruning ----
    const apiCustom = {
      name: 'custom',
      kind: 'custom',
      protocol: 'openai_compatible',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'k',
    };
    const syncAs = (id: string, list: ProviderModelInfo[], who = alice): request.Test => {
      nextModels = () => list;
      return request(server).post(`/api/providers/${id}/sync-models`).set('x-test-user', who);
    };
    const backdate = (providerId: string, ext: string, days: number): Promise<unknown> =>
      pool.query(
        `UPDATE model SET unlisted_since = now() - make_interval(days => $3)
          WHERE provider_id = $1 AND external_model_id = $2`,
        [providerId, ext, days],
      );

    it('the switch defaults on, round-trips through create and PATCH, and rejects null and other tenants', async () => {
      const created = await asAlice().send(apiCustom).expect(201);
      expect(created.body.autoPruneUnlisted).toBe(true);
      const off = await asAlice()
        .send({ ...apiCustom, autoPruneUnlisted: false })
        .expect(201);
      expect(off.body.autoPruneUnlisted).toBe(false);

      const patch = (id: string, body: object, who = alice): request.Test =>
        request(server).patch(`/api/providers/${id}`).set('x-test-user', who).send(body);
      expect(
        (await patch(created.body.id, { autoPruneUnlisted: false }).expect(200)).body
          .autoPruneUnlisted,
      ).toBe(false);
      expect(
        (await patch(created.body.id, { name: 'renamed' }).expect(200)).body.autoPruneUnlisted,
      ).toBe(false); // omitted preserves
      expect(
        (await patch(created.body.id, { autoPruneUnlisted: true }).expect(200)).body
          .autoPruneUnlisted,
      ).toBe(true);
      expect(
        (await request(server).get(`/api/providers/${created.body.id}`).set('x-test-user', alice))
          .body.autoPruneUnlisted,
      ).toBe(true);

      // An explicit null is a 400 (a NOT NULL column must never see it), as is a non-boolean.
      await patch(created.body.id, { autoPruneUnlisted: null }).expect(400);
      await patch(created.body.id, { autoPruneUnlisted: 'yes' }).expect(400);
      await asAlice()
        .send({ ...apiCustom, autoPruneUnlisted: null })
        .expect(400);
      // Another tenant cannot change it; the row is unchanged.
      await patch(created.body.id, { autoPruneUnlisted: false }, bob).expect(404);
      expect(
        (await request(server).get(`/api/providers/${created.body.id}`).set('x-test-user', alice))
          .body.autoPruneUnlisted,
      ).toBe(true);
    });

    it('a sync prunes a retired model only after the grace period, and reports how many', async () => {
      const { body: p } = await asAlice().send(apiCustom);
      expect(
        (await syncAs(p.id, [{ id: 'keep' }, { id: 'retired' }]).expect(200)).body.pruned,
      ).toBe(0);

      // First omission: flagged now, inside the grace period, so kept.
      const first = await syncAs(p.id, [{ id: 'keep' }]).expect(200);
      expect(first.body.pruned).toBe(0);
      expect(await remaining(p.id)).toEqual(['keep', 'retired']);

      // Six days later: still inside the grace period.
      await backdate(p.id, 'retired', 6);
      expect((await syncAs(p.id, [{ id: 'keep' }]).expect(200)).body.pruned).toBe(0);
      expect(await remaining(p.id)).toEqual(['keep', 'retired']);

      // Eight days: pruned, and the count is reported.
      await backdate(p.id, 'retired', 8);
      const pruned = await syncAs(p.id, [{ id: 'keep' }]).expect(200);
      expect(pruned.body).toMatchObject({ ok: true, pruned: 1 });
      expect(await remaining(p.id)).toEqual(['keep']);
    });

    it('a model that came back, a referenced model, and a switched-off provider are never pruned', async () => {
      const { body: p } = await asAlice().send(apiCustom);
      await syncAs(p.id, [{ id: 'back' }, { id: 'used' }, { id: 'gone' }]).expect(200);
      await syncAs(p.id, []).expect(200); // empty: flags nothing
      await syncAs(p.id, [{ id: 'keep' }]).expect(200); // flags back, used, gone
      const ids = Object.fromEntries(
        (
          await pool.query<{ id: string; e: string }>(
            'SELECT id, external_model_id AS e FROM model WHERE provider_id = $1',
            [p.id],
          )
        ).rows.map((r) => [r.e, r.id]),
      );
      const tier = await mkTier();
      await port().routingEntries.add(who(), {
        tierId: tier.id,
        modelId: ids['used']!,
        position: 0,
      });
      for (const e of ['back', 'used', 'gone']) await backdate(p.id, e, 30);

      // 'back' is listed again: its flag clears and it survives; 'used' is referenced; 'gone' goes.
      const r = await syncAs(p.id, [{ id: 'keep' }, { id: 'back' }]).expect(200);
      expect(r.body.pruned).toBe(1);
      expect(await remaining(p.id)).toEqual(['back', 'keep', 'used']);

      // Switched off: the same retired model is flagged and kept.
      await request(server)
        .patch(`/api/providers/${p.id}`)
        .set('x-test-user', alice)
        .send({ autoPruneUnlisted: false })
        .expect(200);
      await backdate(p.id, 'used', 30);
      await syncAs(p.id, [{ id: 'keep' }, { id: 'back' }, { id: 'new' }]).expect(200);
      await pool.query(
        `UPDATE model SET unlisted_since = now() - interval '30 days' WHERE id = $1`,
        [ids['back']],
      );
      const off = await syncAs(p.id, [{ id: 'keep' }, { id: 'new' }]).expect(200);
      expect(off.body.pruned).toBe(0);
      expect(await remaining(p.id)).toContain('back');
    });

    it('an empty, truncated, or failed listing prunes nothing, however old the flags', async () => {
      const { body: p } = await asAlice().send(apiCustom);
      await syncAs(p.id, [{ id: 'keep' }, { id: 'old' }]).expect(200);
      await syncAs(p.id, [{ id: 'keep' }]).expect(200);
      await backdate(p.id, 'old', 30);

      expect((await syncAs(p.id, []).expect(200)).body.pruned).toBe(0);
      const truncated = Object.assign([{ id: 'keep' }], { truncated: true as const });
      expect((await syncAs(p.id, truncated).expect(200)).body.pruned).toBe(0);
      nextModels = () => {
        throw new Error('listing failed');
      };
      const failed = await request(server)
        .post(`/api/providers/${p.id}/sync-models`)
        .set('x-test-user', alice);
      expect(failed.body.pruned).toBeUndefined();
      expect(await remaining(p.id)).toEqual(['keep', 'old']);
    });

    // ---- the reference/prune race, with real row locks on separate connections ----
    // A held lock stands in for "the other side is mid-transaction", so each case is
    // deterministic: no sleeps decide the outcome, only lock order does.
    const held: import('pg').PoolClient[] = [];
    const holdLocks = async (): Promise<import('pg').PoolClient> => {
      const c = await pool.connect();
      held.push(c);
      await c.query('BEGIN');
      return c;
    };
    // A failing assertion must not leave a connection holding a row lock: that would hang
    // the pool's shutdown and mask the real failure.
    afterEach(async () => {
      for (const c of held.splice(0)) {
        try {
          await c.query('ROLLBACK');
        } catch {
          /* already finished */
        }
        try {
          c.release();
        } catch {
          /* already released by the test */
        }
      }
    });
    /** Resolve once some backend is blocked on a lock (the writer waiting on the prune). */
    const waitForLockWaiter = async (): Promise<void> => {
      for (let i = 0; i < 200; i += 1) {
        const r = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (Number(r.rows[0]!.n) > 0) return;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error('no backend ever waited on a lock');
    };
    const entryCount = async (modelId: string): Promise<number> =>
      Number(
        (
          await pool.query<{ n: string }>(
            'SELECT count(*) AS n FROM routing_entry WHERE model_id = $1',
            [modelId],
          )
        ).rows[0]!.n,
      );
    const modelExists = async (id: string): Promise<boolean> =>
      (await pool.query('SELECT 1 FROM model WHERE id = $1', [id])).rowCount === 1;

    it('a prune parked on the provider row that is cancelled meanwhile deletes nothing', async () => {
      const p = await mkProvider();
      await mkModel(p.id, 'stale', new Date(CUTOFF.getTime() - 30 * DAY));
      // Another sync holds the provider row (reconcileListing takes it FOR UPDATE).
      const holder = await holdLocks();
      await holder.query('SELECT id FROM provider WHERE id = $1 FOR UPDATE', [p.id]);
      let cancelled = false;
      const pruning = port().models.pruneUnlisted(
        who(),
        p.id,
        CUTOFF,
        await guardOf(p.id),
        () => cancelled,
      );
      await waitForLockWaiter(); // the prune is waiting for the provider row
      cancelled = true; // the scheduled refresh's deadline lands while it waits
      await holder.query('COMMIT');
      holder.release();
      await expect(pruning).resolves.toBe(0);
      expect(await remaining(p.id)).toEqual(['stale']);
    });

    it('a chain write that already references the model wins: the prune skips the locked row', async () => {
      const p = await mkProvider();
      const id = await mkModel(p.id, 'stale', new Date(CUTOFF.getTime() - 30 * DAY));
      const tier = await mkTier();
      // The writer's FK insert takes FOR KEY SHARE on the model row; it has not committed.
      const writer = await holdLocks();
      try {
        await writer.query(
          `INSERT INTO routing_entry (id, tier_id, model_id, position)
           VALUES (gen_random_uuid()::text, $1, $2, 0)`,
          [tier.id, id],
        );
        expect(await prune(p.id)).toBe(0); // skipped, not waited on, not deleted
      } finally {
        await writer.query('COMMIT');
        writer.release();
      }
      expect(await modelExists(id)).toBe(true);
      expect(await entryCount(id)).toBe(1);
      expect(await prune(p.id)).toBe(0); // and now it is referenced
    });

    it('a chain write that loses to the prune is rejected as an unknown model, never cascaded', async () => {
      const p = await mkProvider();
      const id = await mkModel(p.id, 'stale', new Date(CUTOFF.getTime() - 30 * DAY));
      const tier = await mkTier();
      // The prune holds the row FOR UPDATE and is about to delete it.
      const pruner = await holdLocks();
      await pruner.query('SELECT id FROM model WHERE id = $1 FOR UPDATE', [id]);
      const write = port().routingEntries.replaceForTier(who(), tier.id, [id]);
      await waitForLockWaiter(); // the chain write is parked on the model row
      await pruner.query('DELETE FROM model WHERE id = $1', [id]);
      await pruner.query('COMMIT');
      pruner.release();
      await expect(write).resolves.toMatchObject({ status: 'unknown_models' });
      expect(await entryCount(id)).toBe(0);
    });

    it('a single-entry add that loses to the prune returns nothing and saves nothing', async () => {
      const p = await mkProvider();
      const id = await mkModel(p.id, 'stale', new Date(CUTOFF.getTime() - 30 * DAY));
      const tier = await mkTier();
      const pruner = await holdLocks();
      await pruner.query('SELECT id FROM model WHERE id = $1 FOR UPDATE', [id]);
      const write = port().routingEntries.add(who(), { tierId: tier.id, modelId: id, position: 0 });
      await waitForLockWaiter();
      await pruner.query('DELETE FROM model WHERE id = $1', [id]);
      await pruner.query('COMMIT');
      pruner.release();
      await expect(write).resolves.toBeNull();
      expect(await entryCount(id)).toBe(0);
    });

    it('a rule write that loses to the prune reports the target gone and saves nothing', async () => {
      const p = await mkProvider();
      const existing = await port().routingRules.insert(who(), {
        matchType: 'default',
        target: 'tier:default',
      });
      const writes = [
        (id: string) =>
          port().routingRules.insertLockingTarget(who(), {
            matchType: 'default',
            target: `model:${id}`,
          }),
        (id: string) =>
          port().routingRules.updateLockingTarget(who(), existing.id, { target: `model:${id}` }),
      ];
      const tried: string[] = [];
      for (const [n, write] of writes.entries()) {
        const id = await mkModel(p.id, `stale-${n}`, new Date(CUTOFF.getTime() - 30 * DAY));
        const pruner = await holdLocks();
        await pruner.query('SELECT id FROM model WHERE id = $1 FOR UPDATE', [id]);
        tried.push(id);
        const pending = write(id);
        await waitForLockWaiter();
        await pruner.query('DELETE FROM model WHERE id = $1', [id]);
        await pruner.query('COMMIT');
        pruner.release();
        await expect(pending).resolves.toBe('target_gone');
      }
      const rules = await port().routingRules.list(who());
      expect(rules.filter((r) => tried.some((id) => r.target === `model:${id}`))).toHaveLength(0);
      expect(rules.find((r) => r.id === existing.id)!.target).toBe('tier:default');
    });

    it('a rule write that holds the model first wins: the prune skips it and the rule resolves', async () => {
      const p = await mkProvider();
      const id = await mkModel(p.id, 'stale', new Date(CUTOFF.getTime() - 30 * DAY));
      const writer = await holdLocks();
      try {
        // What `insertLockingTarget` holds between its check and its insert.
        await writer.query('SELECT id FROM model WHERE id = $1 FOR KEY SHARE', [id]);
        expect(await prune(p.id)).toBe(0);
      } finally {
        await writer.query('COMMIT');
        writer.release();
      }
      const rule = await port().routingRules.insertLockingTarget(who(), {
        matchType: 'default',
        target: `model:${id}`,
      });
      expect(rule).not.toBe('target_gone');
      expect(await prune(p.id)).toBe(0); // referenced now
      expect(await modelExists(id)).toBe(true);
    });

    it('recorded history cannot be touched: only routing_entry holds a foreign key to model', async () => {
      const r = await pool.query<{ t: string }>(
        `SELECT conrelid::regclass::text AS t FROM pg_constraint
          WHERE contype = 'f' AND confrelid = 'model'::regclass ORDER BY 1`,
      );
      expect(r.rows.map((x) => x.t)).toEqual(['routing_entry']);
    });
  });
});
