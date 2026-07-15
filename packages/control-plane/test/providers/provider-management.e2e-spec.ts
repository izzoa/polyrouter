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

  beforeEach(async () => {
    await pool.query('DELETE FROM provider WHERE owner_user_id = ANY($1)', [[alice, bob]]);
    nextTest = () => ({ ok: true, models: 0 });
    nextModels = () => [];
  });

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
    const svc = new ProvidersService(port, createProviderAdapter, {
      key: 'a'.repeat(64),
      mode: 'selfhosted',
    });
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
