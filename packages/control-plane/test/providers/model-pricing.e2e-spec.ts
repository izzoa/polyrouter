// Custom/local model-pricing e2e (#18 §7.7). A stub principal guard (`x-test-user`)
// over the real ProvidersModule/ModelsController + persistence — asserts the
// request-shape pricing rules, the custom/local-only restriction, owner-scoping,
// and cost-immutability (editing a model's price never rewrites a recorded log).
import { randomUUID } from 'node:crypto';
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
import { PERSISTENCE_PORT, userPrincipal, type PersistencePort } from '@polyrouter/shared/server';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { ProvidersModule } from '../../src/providers/providers.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/providers/providers.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

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

describe('custom/local model pricing (#18)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let alice: string;
  let bob: string;

  const mkUser = async (): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'u', $1, false) RETURNING id`,
        [`price-${randomUUID()}@t.test`],
      )
    ).rows[0]!.id;

  async function mkModel(owner: string, kind: 'custom' | 'local' | 'api_key'): Promise<string> {
    const principal = userPrincipal(owner);
    const provider = await port.providers.insert(principal, {
      name: kind,
      kind,
      protocol: 'openai_compatible',
      baseUrl: kind === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://1.1.1.1/v1',
      ...(kind === 'api_key' ? { encryptedCredentials: null } : {}),
    });
    const model = await port.models.createForProvider(principal, provider.id, {
      externalModelId: `m-${randomUUID().slice(0, 8)}`,
    });
    return model!.id;
  }

  const patch = (user: string, id: string, body: unknown) =>
    request(server)
      .patch(`/api/models/${id}`)
      .set('x-test-user', user)
      .send(body as object);

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [ProvidersModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    alice = await mkUser();
    bob = await mkUser();
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[alice, bob]]);
    await app.close();
    await pool.end();
  });

  it('sets a price pair on a custom model and reflects it in the models list', async () => {
    const id = await mkModel(alice, 'custom');
    const res = await patch(alice, id, { inputPricePer1m: 1.5, outputPricePer1m: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inputPricePer1m: 1.5, outputPricePer1m: 3, isFree: false });
    // The PATCH response carries a freshly resolved effective price (source 'model', not
    // an estimate) so an optimistic client replace stays consistent (add-provider-price-sync-and-edit).
    expect(res.body.effectivePrice).toMatchObject({
      inputPricePer1m: 1.5,
      outputPricePer1m: 3,
      source: 'model',
      estimated: false,
    });
    const list = await request(server)
      .get(`/api/models?providerId=${res.body.providerId}`)
      .set('x-test-user', alice);
    expect(list.body[0]).toMatchObject({ inputPricePer1m: 1.5, outputPricePer1m: 3 });
  });

  it('marks a local model free (normalizes to 0/0/free)', async () => {
    const id = await mkModel(alice, 'local');
    const res = await patch(alice, id, { isFree: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inputPricePer1m: 0, outputPricePer1m: 0, isFree: true });
  });

  it('rejects malformed request shapes (422) — validated on the body, not merged state', async () => {
    const id = await mkModel(alice, 'custom');
    expect((await patch(alice, id, {})).status).toBe(422); // empty
    expect((await patch(alice, id, { inputPricePer1m: 1 })).status).toBe(422); // lone price
    expect((await patch(alice, id, { isFree: false })).status).toBe(422); // isFree:false alone
    expect(
      (await patch(alice, id, { isFree: true, inputPricePer1m: 1, outputPricePer1m: 2 })).status,
    ).toBe(422);
    // a single price onto an already-priced model is still 422 (no silent merge)
    expect((await patch(alice, id, { inputPricePer1m: 1, outputPricePer1m: 2 })).status).toBe(200);
    expect((await patch(alice, id, { inputPricePer1m: 5 })).status).toBe(422);
    // negative / non-finite rejected by the DTO
    expect((await patch(alice, id, { inputPricePer1m: -1, outputPricePer1m: 2 })).status).toBe(400);
  });

  it('rejects pricing a known-provider (api_key) model (422)', async () => {
    const id = await mkModel(alice, 'api_key');
    expect((await patch(alice, id, { isFree: true })).status).toBe(422);
    expect((await patch(alice, id, { inputPricePer1m: 1, outputPricePer1m: 2 })).status).toBe(422);
  });

  it('is owner-scoped: a cross-tenant edit by id is 404', async () => {
    const id = await mkModel(alice, 'custom');
    expect((await patch(bob, id, { isFree: true })).status).toBe(404);
    expect((await patch('ghost-user', id, { isFree: true })).status).toBe(404);
  });

  it('clears stale model prices when a provider kind leaves custom/local (E5.4)', async () => {
    const principal = userPrincipal(alice);
    const provider = await port.providers.insert(principal, {
      name: 'custom-then-apikey',
      kind: 'custom',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.z.ai/api/paas/v4', // an intl BYOK host (catalog-priceable as api_key)
    });
    const model = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'glm-4.5',
    });
    expect((await patch(alice, model!.id, { inputPricePer1m: 7, outputPricePer1m: 9 })).status).toBe(
      200,
    );
    // Kind change custom → api_key: the stale user prices are cleared in the same flow.
    const kindChange = await request(server)
      .patch(`/api/providers/${provider.id}`)
      .set('x-test-user', alice)
      .send({ kind: 'api_key', credential: 'sk-test' });
    expect(kindChange.status).toBe(200);
    const list = await request(server)
      .get(`/api/models?providerId=${provider.id}`)
      .set('x-test-user', alice);
    expect(list.body[0]).toMatchObject({
      inputPricePer1m: null,
      outputPricePer1m: null,
      isFree: false,
    });
  });

  it('a within-custom update leaves user prices intact (E5.4)', async () => {
    const principal = userPrincipal(alice);
    const provider = await port.providers.insert(principal, {
      name: 'stays-custom',
      kind: 'custom',
      protocol: 'openai_compatible',
      baseUrl: 'https://2.2.2.2/v1',
    });
    const model = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'm-keep',
    });
    await patch(alice, model!.id, { inputPricePer1m: 4, outputPricePer1m: 6 });
    // Rename only — kind stays custom → prices must survive.
    const rename = await request(server)
      .patch(`/api/providers/${provider.id}`)
      .set('x-test-user', alice)
      .send({ name: 'renamed' });
    expect(rename.status).toBe(200);
    const list = await request(server)
      .get(`/api/models?providerId=${provider.id}`)
      .set('x-test-user', alice);
    expect(list.body[0]).toMatchObject({ inputPricePer1m: 4, outputPricePer1m: 6 });
  });

  it('does not rewrite historical cost — a recorded log keeps its snapshot after a price edit', async () => {
    const id = await mkModel(alice, 'custom');
    await patch(alice, id, { inputPricePer1m: 1, outputPricePer1m: 1 });
    // A recorded request snapshots the price-in-effect and its computed cost.
    const logId = randomUUID();
    await pool.query(
      `INSERT INTO request_log
        (id, owner_user_id, model_id, decision_layer, routing_reason, input_tokens, output_tokens,
         input_price_snapshot, output_price_snapshot, cost, duration_ms, status)
       VALUES ($1,$2,$3,'default','test',1000,1000,1,1,0.002,1,'success')`,
      [logId, alice, id],
    );
    // Editing the model's current price must not touch the immutable log row.
    expect((await patch(alice, id, { inputPricePer1m: 99, outputPricePer1m: 99 })).status).toBe(
      200,
    );
    const row = await pool.query<{ cost: string; input_price_snapshot: string }>(
      'SELECT cost, input_price_snapshot FROM request_log WHERE id = $1',
      [logId],
    );
    expect(Number(row.rows[0]!.cost)).toBeCloseTo(0.002, 9);
    expect(Number(row.rows[0]!.input_price_snapshot)).toBe(1);
  });
});
