// Budget CRUD + tenant-isolation e2e. A slim module — CRUD needs only Postgres
// (no Redis/BullMQ), so it mounts the controller + service + cache over the real
// persistence port with a stub principal guard (`x-test-user`).
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
import { DatabaseModule } from '../../src/database/database.module';
import { BudgetsController } from '../../src/budgets/budgets.controller';
import { BudgetsCrudService } from '../../src/budgets/budgets.crud';
import { BudgetCache } from '../../src/budgets/budget-cache';
import { BUDGETS_CONFIG, resolveBudgetsConfig } from '../../src/budgets/budgets.config';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/budgets/budgets.config';

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

const GLOBAL_BLOCK = {
  name: 'monthly cap',
  scope: 'global',
  window: 'month',
  action: 'block',
  amount: 100,
};

describe('budget CRUD + tenant isolation', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let alice: string;
  let bob: string;

  const mkUser = async (): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'u', $1, false) RETURNING id`,
        [`budget-${Math.random().toString(36).slice(2)}@crud.test`],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
      controllers: [BudgetsController],
      providers: [
        { provide: BUDGETS_CONFIG, useFactory: resolveBudgetsConfig },
        BudgetCache,
        BudgetsCrudService,
        { provide: APP_GUARD, useClass: TestPrincipalGuard },
      ],
    }).compile();
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
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM budget WHERE owner_user_id = ANY($1)', [[alice, bob]]);
  });

  const post = (user: string, body: unknown) =>
    request(server)
      .post('/api/budgets')
      .set('x-test-user', user)
      .send(body as object);

  it('creates, lists, and reads a budget (owner-scoped)', async () => {
    const res = await post(alice, GLOBAL_BLOCK);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'monthly cap',
      scope: 'global',
      window: 'month',
      action: 'block',
      amount: 100,
      agentId: null,
      enabled: true,
      notifyChannelIds: [],
    });
    const list = await request(server).get('/api/budgets').set('x-test-user', alice);
    expect(list.body).toHaveLength(1);
    const got = await request(server).get(`/api/budgets/${res.body.id}`).set('x-test-user', alice);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(res.body.id);
  });

  it('is tenant-isolated: B cannot read/update/delete A’s budget by id', async () => {
    const { body } = await post(alice, GLOBAL_BLOCK);
    expect(
      (await request(server).get(`/api/budgets/${body.id}`).set('x-test-user', bob)).status,
    ).toBe(404);
    expect(
      (
        await request(server)
          .patch(`/api/budgets/${body.id}`)
          .set('x-test-user', bob)
          .send({ amount: 1 })
      ).status,
    ).toBe(404);
    expect(
      (await request(server).delete(`/api/budgets/${body.id}`).set('x-test-user', bob)).status,
    ).toBe(404);
    // A's budget is unchanged
    const still = await request(server).get(`/api/budgets/${body.id}`).set('x-test-user', alice);
    expect(still.body.amount).toBe(100);
  });

  it('rejects an agent-scoped budget with no agentId (business rule → 422)', async () => {
    const res = await post(alice, { ...GLOBAL_BLOCK, scope: 'agent' });
    expect(res.status).toBe(422);
    expect((await request(server).get('/api/budgets').set('x-test-user', alice)).body).toHaveLength(
      0,
    );
  });

  it('rejects malformed input at the DTO (→ 400): non-positive/over-ceiling amount, unknown enum', async () => {
    expect((await post(alice, { ...GLOBAL_BLOCK, amount: 0 })).status).toBe(400);
    expect((await post(alice, { ...GLOBAL_BLOCK, amount: 2_000_000_000 })).status).toBe(400);
    expect((await post(alice, { ...GLOBAL_BLOCK, window: 'year' })).status).toBe(400);
    expect((await post(alice, { ...GLOBAL_BLOCK, action: 'throttle' })).status).toBe(400);
  });

  it('re-validates the merged state on update (global→agent without an agent → 422)', async () => {
    const { body } = await post(alice, GLOBAL_BLOCK);
    const res = await request(server)
      .patch(`/api/budgets/${body.id}`)
      .set('x-test-user', alice)
      .send({ scope: 'agent' });
    expect(res.status).toBe(422);
    // an ordinary field update succeeds and is reflected
    const ok = await request(server)
      .patch(`/api/budgets/${body.id}`)
      .set('x-test-user', alice)
      .send({ amount: 250 });
    expect(ok.status).toBe(200);
    expect(ok.body.amount).toBe(250);
  });

  it('deletes a budget; a second delete is 404', async () => {
    const { body } = await post(alice, GLOBAL_BLOCK);
    expect(
      (await request(server).delete(`/api/budgets/${body.id}`).set('x-test-user', alice)).status,
    ).toBe(200);
    expect(
      (await request(server).get(`/api/budgets/${body.id}`).set('x-test-user', alice)).status,
    ).toBe(404);
  });

  it('the DB check constraints are live (defense in depth behind the DTO)', async () => {
    // agent scope without an agent id ("window" is a reserved word — quote it)
    await expect(
      pool.query(
        `INSERT INTO budget (id, owner_user_id, name, scope, agent_id, "window", action, amount)
         VALUES (gen_random_uuid(), $1, 'x', 'agent', NULL, 'day', 'block', 5)`,
        [alice],
      ),
    ).rejects.toThrow(/budget_agent_iff_scope/);
    // non-positive amount
    await expect(
      pool.query(
        `INSERT INTO budget (id, owner_user_id, name, scope, agent_id, "window", action, amount)
         VALUES (gen_random_uuid(), $1, 'x', 'global', NULL, 'day', 'block', 0)`,
        [alice],
      ),
    ).rejects.toThrow(/budget_amount_range/);
  });
});
