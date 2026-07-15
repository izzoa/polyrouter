// Routing-config e2e (real Postgres). Stub principal guard (no better-auth);
// each tenant's default tier + provider/models are seeded through the port.
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
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { RoutingConfigModule } from '../../src/routing-config/routing-config.module';
import { COMPOSE_HINT } from '../tenancy/harness';
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

interface Tenant {
  userId: string;
  principal: Principal;
  modelIds: string[];
}

async function seedTenant(port: PersistencePort, pool: Pool, label: string): Promise<Tenant> {
  const userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${Date.now()}@routing.test`],
    )
  ).rows[0]!.id;
  const principal = userPrincipal(userId);
  await port.ensureDefaultTier(principal);
  const provider = await port.providers.insert(principal, {
    name: 'p',
    kind: 'api_key',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.example.com',
  });
  const modelIds: string[] = [];
  for (const ext of ['m-a', 'm-b', 'm-c']) {
    const m = await port.models.createForProvider(principal, provider.id, { externalModelId: ext });
    modelIds.push(m!.id);
  }
  return { userId, principal, modelIds };
}

describe('routing-config e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let A: Tenant;
  let B: Tenant;

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
    const moduleRef = await Test.createTestingModule({
      imports: [RoutingConfigModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init(); // runs migrations
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    A = await seedTenant(port, pool, 'routeA');
    B = await seedTenant(port, pool, 'routeB');
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[A.userId, B.userId]]);
    await app.close();
    await pool.end();
  });

  const asA = (m: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string) =>
    request(server)[m](path).set('x-test-user', A.userId);

  // --- tiers ---

  it('seeds a default tier and does CRUD, protecting default', async () => {
    const list = await asA('get', '/api/routing/tiers');
    expect(list.status).toBe(200);
    expect(list.body.some((t: { key: string }) => t.key === 'default')).toBe(true);
    const defaultId = list.body.find((t: { key: string }) => t.key === 'default').id;

    expect((await asA('post', '/api/routing/tiers').send({ key: 'auto' })).status).toBe(422);
    const created = await asA('post', '/api/routing/tiers').send({ key: 'fast', displayName: 'F' });
    expect(created.status).toBe(201);
    expect((await asA('post', '/api/routing/tiers').send({ key: 'fast' })).status).toBe(409);

    const patched = await asA('patch', `/api/routing/tiers/${created.body.id}`).send({
      displayName: 'Renamed',
    });
    expect(patched.body).toMatchObject({ key: 'fast', displayName: 'Renamed' });

    expect((await asA('delete', `/api/routing/tiers/${defaultId}`)).status).toBe(422);
    expect((await asA('delete', `/api/routing/tiers/${created.body.id}`)).status).toBe(200);
  });

  // --- entries ---

  it('replaces the ordered chain, enforcing cap/dedupe/ownership', async () => {
    const tiers = await asA('get', '/api/routing/tiers');
    const defaultId = tiers.body.find((t: { key: string }) => t.key === 'default').id;
    const entriesUrl = `/api/routing/tiers/${defaultId}/entries`;

    const put = await asA('put', entriesUrl).send({ modelIds: A.modelIds });
    expect(put.status).toBe(200);
    expect(put.body.map((e: { position: number; modelId: string }) => e.position)).toEqual([0, 1, 2]);

    const get = await asA('get', entriesUrl);
    expect(get.body.map((e: { modelId: string }) => e.modelId)).toEqual(A.modelIds);
    expect(get.body[0].model.externalModelId).toBe('m-a');

    // Reorder + unassign (shorter list).
    const reordered = await asA('put', entriesUrl).send({
      modelIds: [A.modelIds[2], A.modelIds[0]],
    });
    expect(reordered.body.map((e: { modelId: string }) => e.modelId)).toEqual([
      A.modelIds[2],
      A.modelIds[0],
    ]);

    // Over-cap (6) → 4xx; duplicate → 422; another tenant's model → 422.
    expect(
      (await asA('put', entriesUrl).send({ modelIds: [...A.modelIds, ...A.modelIds] })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await asA('put', entriesUrl).send({ modelIds: [A.modelIds[0], A.modelIds[0]] })).status,
    ).toBe(422);
    expect((await asA('put', entriesUrl).send({ modelIds: [B.modelIds[0]] })).status).toBe(422);
  });

  // --- rules ---

  it('does rule CRUD with target validation and priority bounds', async () => {
    const okTier = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerValue: 'fast',
      target: 'tier:default',
    });
    expect(okTier.status).toBe(201);
    expect(okTier.body.headerName).toBe('x-polyrouter-tier');

    const okModel = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerName: 'X-Route',
      headerValue: 'm',
      target: `model:${A.modelIds[0]}`,
    });
    expect(okModel.body.headerName).toBe('x-route');

    expect(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'header',
          headerValue: 'x',
          target: 'tier:ghost',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'header',
          headerValue: 'x',
          target: 'bogus',
        })
      ).status,
    ).toBe(422);
    // header rule without a header_value → 422
    expect(
      (await asA('post', '/api/routing/rules').send({ matchType: 'header', target: 'tier:default' }))
        .status,
    ).toBe(422);
    // priority out of range → 4xx (DTO bound), never a 500
    expect(
      (
        await asA('post', '/api/routing/rules').send({
          matchType: 'header',
          headerValue: 'x',
          target: 'tier:default',
          priority: 2_000_000,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);

    const del = await asA('delete', `/api/routing/rules/${okModel.body.id}`);
    expect(del.status).toBe(200);
  });

  it('persists a rule when its target tier is deleted; the key can be recreated', async () => {
    const temp = await asA('post', '/api/routing/tiers').send({ key: 'temp' });
    const ruleRes = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerValue: 't',
      target: 'tier:temp',
    });
    expect((await asA('delete', `/api/routing/tiers/${temp.body.id}`)).status).toBe(200);

    // The rule is NOT rewritten/deleted — its target persists (now unresolved; #10's concern).
    const stillThere = await asA('get', `/api/routing/rules/${ruleRes.body.id}`);
    expect(stillThere.body.target).toBe('tier:temp');

    // The key is free to recreate (late-bound targets rebind at #10).
    expect((await asA('post', '/api/routing/tiers').send({ key: 'temp' })).status).toBe(201);
    await asA('delete', `/api/routing/rules/${ruleRes.body.id}`);
  });

  // --- tenant isolation ---

  it('never leaks another tenant’s tiers, entries, or rules by id', async () => {
    const aTiers = await asA('get', '/api/routing/tiers');
    const aDefault = aTiers.body.find((t: { key: string }) => t.key === 'default').id;
    const aRule = await asA('post', '/api/routing/rules').send({
      matchType: 'header',
      headerValue: 'iso',
      target: 'tier:default',
    });
    const asB = (m: 'get' | 'patch' | 'delete' | 'put', path: string) =>
      request(server)[m](path).set('x-test-user', B.userId);

    expect((await asB('get', `/api/routing/tiers/${aDefault}`)).status).toBe(404);
    expect((await asB('patch', `/api/routing/tiers/${aDefault}`).send({ displayName: 'x' })).status).toBe(404);
    expect((await asB('delete', `/api/routing/tiers/${aDefault}`)).status).toBe(404);
    // B cannot replace entries on A's tier (tier_not_found → 404), even with B's own models.
    expect(
      (await asB('put', `/api/routing/tiers/${aDefault}/entries`).send({ modelIds: [B.modelIds[0]] }))
        .status,
    ).toBe(404);
    // B cannot see or fetch A's rule.
    expect((await asB('get', `/api/routing/rules/${aRule.body.id}`)).status).toBe(404);
    const bRules = await request(server).get('/api/routing/rules').set('x-test-user', B.userId);
    expect(bRules.body.some((r: { id: string }) => r.id === aRule.body.id)).toBe(false);

    // A's data is unchanged.
    expect((await asA('get', `/api/routing/rules/${aRule.body.id}`)).status).toBe(200);
    await asA('delete', `/api/routing/rules/${aRule.body.id}`);
  });
});
