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
      { id: 'moonshotai/kimi-k3', pricing: { inputPricePer1m: 3, outputPricePer1m: 15 } },
    ];
    const sync = await request(server)
      .post(`/api/providers/${created.body.id}/sync-models`)
      .set('x-test-user', alice);
    expect(sync.body.synced).toBe(1);
    expect(sync.body.pricesCaptured).toBe(1);

    const list = await listModelsFor(alice);
    const model = list.body.find(
      (m: { externalModelId: string }) => m.externalModelId === 'moonshotai/kimi-k3',
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
      "SELECT count(*)::text n FROM model_price WHERE model_key = 'openrouter:moonshotai/kimi-k3'",
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
});
