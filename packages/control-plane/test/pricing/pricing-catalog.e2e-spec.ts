// Pricing-catalog e2e. Stub principal guard (no better-auth); PRICING_FETCH is
// overridden with a fake so the litellm path is exercised without a network.
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
import { userPrincipal } from '@polyrouter/shared/server';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { BUNDLED_CATALOG_VERSION } from '../../src/pricing/bundled-catalog';
import { PRICING_FETCH, type PricingFetch } from '../../src/pricing/pricing.service';
import { PricingModule } from '../../src/pricing/pricing.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/pricing/pricing.config';
import '../../src/database/database.config';

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

const fakeFetch: PricingFetch = () =>
  Promise.resolve({
    'refreshed-model': {
      litellm_provider: 'openai',
      mode: 'chat',
      input_cost_per_token: 0.000009,
      output_cost_per_token: 0.00001,
    },
  });

async function buildApp(mode: 'selfhosted' | 'cloud'): Promise<INestApplication> {
  process.env['NODE_ENV'] = 'test';
  process.env['MODE'] = mode;
  process.env['BIND_ADDRESS'] = '127.0.0.1';
  const probe = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await probe.query('SELECT 1');
    // Reset the GLOBAL catalog so boot re-seeds fresh — it isn't owned by a
    // user, so it survives cross-run and would otherwise leak prior overrides.
    await probe.query('DELETE FROM model_price');
  } catch (error) {
    throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
  } finally {
    await probe.end();
  }
  const moduleRef = await Test.createTestingModule({
    imports: [PricingModule],
    providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
  })
    .overrideProvider(PRICING_FETCH)
    .useValue(fakeFetch)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.init(); // runs migrations + seeds the bundled catalog
  return app;
}

describe('pricing catalog (self-host)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let admin: string;
  let user: string;

  beforeAll(async () => {
    app = await buildApp('selfhosted');
    server = app.getHttpServer();
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    admin = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified, role) VALUES (gen_random_uuid(), 'a', $1, true, 'admin') RETURNING id`,
        [`admin-${Date.now()}@pricing.test`],
      )
    ).rows[0]!.id;
    user = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'u', $1, true) RETURNING id`,
        [`user-${Date.now()}@pricing.test`],
      )
    ).rows[0]!.id;
  }, 60_000);
  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[admin, user]]);
    await app.close();
    await pool.end();
  });

  it('boot seeds the bundled catalog including the free set', async () => {
    const res = await request(server).get('/api/pricing').set('x-test-user', user);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(5);
    expect(res.body.some((r: { modelKey: string }) => r.modelKey === 'openai:gpt-4o')).toBe(true);
    expect(res.body.some((r: { isFree: boolean }) => r.isFree === true)).toBe(true);
  });

  it('seeds ≥1 priced row per §8 BYOK family, resolvable to a USD price (E5.3)', async () => {
    const res = await request(server).get('/api/pricing').set('x-test-user', user);
    expect(res.status).toBe(200);
    const keys = (res.body as { modelKey: string }[]).map((r) => r.modelKey);
    for (const prefix of ['dashscope:', 'moonshot:', 'minimax:', 'zai:']) {
      expect(keys.some((k) => k.startsWith(prefix))).toBe(true);
    }
    // A Qwen (dashscope) row resolves to its non-null bundled USD price.
    const qwen = await request(server)
      .get('/api/pricing/dashscope:qwen-max')
      .set('x-test-user', user);
    expect(qwen.status).toBe(200);
    expect(qwen.body.inputPricePer1m).toBeCloseTo(1.6, 6);
  });

  it('priceAt is effective-dated', async () => {
    const before = BUNDLED_CATALOG_VERSION.getTime() - 1000;
    const notYet = await request(server)
      .get('/api/pricing/openai:gpt-4o')
      .query({ at: new Date(before).toISOString() })
      .set('x-test-user', user);
    expect(notYet.status).toBe(404); // before valid_from
    const nowRow = await request(server).get('/api/pricing/openai:gpt-4o').set('x-test-user', user);
    expect(nowRow.body.inputPricePer1m).toBe(2.5);
  });

  it('a manual override (admin) appends; a past lookup still returns the old price', async () => {
    const ov = await request(server)
      .post('/api/pricing/openai:gpt-4o/override')
      .set('x-test-user', admin)
      .send({ inputPricePer1m: 99, outputPricePer1m: 199 });
    expect(ov.status).toBe(200);
    expect(ov.body.added).toBe(1);

    const current = await request(server)
      .get('/api/pricing/openai:gpt-4o')
      .set('x-test-user', user);
    expect(current.body).toMatchObject({ source: 'manual', inputPricePer1m: 99 });

    const past = await request(server)
      .get('/api/pricing/openai:gpt-4o')
      .query({ at: BUNDLED_CATALOG_VERSION.toISOString() })
      .set('x-test-user', user);
    expect(past.body).toMatchObject({ source: 'bundled', inputPricePer1m: 2.5 }); // immutable
  });

  it('a litellm refresh (admin, injected fetch) appends a new model', async () => {
    const res = await request(server)
      .post('/api/pricing/refresh')
      .set('x-test-user', admin)
      .send({ source: 'litellm' });
    expect(res.status).toBe(200);
    expect(res.body.added).toBeGreaterThanOrEqual(1);
    const row = await request(server)
      .get('/api/pricing/openai:refreshed-model')
      .set('x-test-user', user);
    expect(row.body.inputPricePer1m).toBe(9);
  });

  it('a non-admin cannot mutate; reads still work', async () => {
    expect(
      (
        await request(server)
          .post('/api/pricing/openai:gpt-4o/override')
          .set('x-test-user', user)
          .send({ inputPricePer1m: 1, outputPricePer1m: 1 })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .post('/api/pricing/refresh')
          .set('x-test-user', user)
          .send({ source: 'bundled' })
      ).status,
    ).toBe(403);
    expect((await request(server).get('/api/pricing').set('x-test-user', user)).status).toBe(200);
  });
});

describe('pricing catalog (cloud disables mutations)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let admin: string;

  beforeAll(async () => {
    app = await buildApp('cloud');
    server = app.getHttpServer();
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    admin = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified, role) VALUES (gen_random_uuid(), 'a', $1, true, 'admin') RETURNING id`,
        [`cadmin-${Date.now()}@pricing.test`],
      )
    ).rows[0]!.id;
  }, 60_000);
  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = $1', [admin]);
    await app.close();
    await pool.end();
  });

  it('even an admin cannot mutate the global catalog in cloud mode', async () => {
    const res = await request(server)
      .post('/api/pricing/openai:gpt-4o/override')
      .set('x-test-user', admin)
      .send({ inputPricePer1m: 1, outputPricePer1m: 1 });
    expect(res.status).toBe(403);
  });
});
