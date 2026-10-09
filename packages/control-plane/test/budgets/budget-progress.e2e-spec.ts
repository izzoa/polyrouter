import { randomUUID } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { writeFile } from 'node:fs/promises';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  loadConfig,
  type AvailableBudgetProgress,
  type BudgetProgressResponse,
} from '@polyrouter/shared';
import { PERSISTENCE_PORT, userPrincipal, type PersistencePort } from '@polyrouter/shared/server';
import { DatabaseModule } from '../../src/database/database.module';
import { buildBudgetReader } from '../../src/database/budget.reader';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createBudgetProgressAccessor } from '../../src/database/budget-progress.queries';
import { BudgetsController } from '../../src/budgets/budgets.controller';
import { BudgetProgressService } from '../../src/budgets/budget-progress.service';
import { BudgetsCrudService } from '../../src/budgets/budgets.crud';
import { BudgetCache } from '../../src/budgets/budget-cache';
import { BUDGETS_CONFIG, resolveBudgetsConfig } from '../../src/budgets/budgets.config';
import { configureApp } from '../../src/app.setup';
import type { NestExpressApplication } from '@nestjs/platform-express';
import '../../src/database/database.config';

@Injectable()
class SessionFixture implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string>;
      principal?: ReturnType<typeof userPrincipal>;
    }>();
    const owner = req.headers['x-test-user'];
    if (!owner) throw new UnauthorizedException();
    req.principal = userPrincipal(owner);
    return true;
  }
}

describe('budget progress — real PostgreSQL snapshot, without Redis', () => {
  let pool: Pool;
  let app: INestApplication;
  let server: App;
  let port: PersistencePort;
  const owner = randomUUID();
  const other = randomUUID();
  const agent = randomUUID();
  const otherAgent = randomUUID();
  const principal = userPrincipal(owner);
  const url = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
  let cash: string;
  let notional: string;
  let foreign: string;
  const at = new Date();
  at.setUTCHours(0, 0, 0, 0);
  const earlier = new Date(at.getTime() + 1);
  const before = new Date(at.getTime() - 1);

  async function budget(
    user: string,
    basis = 'cash',
    scope = 'agent',
    agentId: string | null = agent,
    action = 'block',
    enabled = true,
  ) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO budget (id,owner_user_id,name,scope,agent_id,"window",action,amount,metering_basis,enabled)
      VALUES ($1,$2,'test',$3,$4,'day',$5,25,$6,$7)`,
      [id, user, scope, agentId, action, basis, enabled],
    );
    return id;
  }
  async function log(
    user = owner,
    kind: string | null = 'api_key',
    cost: number | null = 2,
    agentId = agent,
    time = earlier,
    estimated = false,
    source = 'bundled',
  ) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO request_log
      (id,owner_user_id,agent_id,decision_layer,routing_reason,input_tokens,output_tokens,duration_ms,status,cost,provider_kind,usage_estimated,price_source,created_at)
      VALUES ($1,$2,$3,'explicit','test',1,1,1,'success',$4,$5,$6,$7,$8)`,
      [id, user, agentId, cost, kind, estimated, source, time],
    );
    return id;
  }
  async function attempt(
    parent: string,
    user = owner,
    cost = 0.5,
    time = earlier,
    kind: string | null = 'api_key',
    estimated = false,
    source = 'bundled',
    index = 0,
  ) {
    await pool.query(
      `INSERT INTO request_attempt
      (id,request_log_id,owner_user_id,attempt_index,input_tokens,output_tokens,status,cost,provider_kind,usage_estimated,price_source,created_at)
      VALUES ($1,$2,$3,$4,1,1,'success',$5,$6,$7,$8,$9)`,
      [randomUUID(), parent, user, index, cost, kind, estimated, source, time],
    );
  }
  async function batch(
    user = owner,
    status = 'submitting',
    ceiling: number | null = 3000000,
    time = earlier,
    agentId = agent,
  ) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO batch_job
      (id,owner_user_id,agent_id,provider_id,model_id,endpoint,protocol,status,item_count,estimated_input_tokens,price_mode,completion_window_ms,reserved_ceiling_micros,submitted_at,terminal_at)
      VALUES ($1,$2,$3,'p','m','/v1/chat/completions','openai_compatible',$4,1,1,'batch',86400000,$5,$6,$7)`,
      [id, user, agentId, status, ceiling, time, status === 'completed' ? time : null],
    );
    return id;
  }
  const get = (ids: string[]) =>
    request(server)
      .get('/api/budgets/progress')
      .query({ ids: ids.join(',') })
      .set('x-test-user', owner);
  const read = async (ids = [cash]) => await port.budgetProgress.read(principal, ids);
  const available = (response: BudgetProgressResponse, index = 0) =>
    response.results[index] as AvailableBudgetProgress;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    await pool.query('SELECT 1');
    const mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      controllers: [BudgetsController],
      providers: [
        BudgetCache,
        BudgetsCrudService,
        BudgetProgressService,
        { provide: BUDGETS_CONFIG, useFactory: resolveBudgetsConfig },
        { provide: APP_GUARD, useClass: SessionFixture },
      ],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    port = app.get(PERSISTENCE_PORT);
    for (const id of [owner, other])
      await pool.query(
        'INSERT INTO "user" (id,name,email,email_verified) VALUES ($1,\'u\',$2,false)',
        [id, `${id}@progress.test`],
      );
  });
  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, other]]);
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM request_log WHERE owner_user_id=ANY($1)', [[owner, other]]);
    await pool.query('DELETE FROM batch_job WHERE owner_user_id=ANY($1)', [[owner, other]]);
    await pool.query('DELETE FROM budget WHERE owner_user_id=ANY($1)', [[owner, other]]);
    cash = await budget(owner);
    notional = await budget(owner, 'notional');
    foreign = await budget(other);
  });
  it('resolves the literal route, preserves request order, hides foreign/missing ids and requires a session', async () => {
    const missing = randomUUID();
    const res = await get([notional, foreign, missing, cash]).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as BudgetProgressResponse).results.map((r) => r.id)).toEqual([
      notional,
      foreign,
      missing,
      cash,
    ]);
    expect(res.body.results.slice(1, 3)).toEqual([
      { id: foreign, availability: 'not_found' },
      { id: missing, availability: 'not_found' },
    ]);
    expect(res.body.results[0].budget).not.toHaveProperty('ownerUserId');
    await request(server)
      .get('/api/budgets/progress')
      .query({ ids: cash })
      .set('Authorization', 'Bearer poly_fake')
      .expect(401);
    await request(server).get(`/api/budgets/${cash}`).set('x-test-user', owner).expect(200);
  });
  it('validates every bounded query edge before aggregation', async () => {
    for (const ids of [
      '',
      `${cash},`,
      `${cash},${cash}`,
      'x'.repeat(129),
      Array.from({ length: 21 }, (_, i) => `b${i}`).join(','),
    ]) {
      await request(server)
        .get('/api/budgets/progress')
        .query({ ids })
        .set('x-test-user', owner)
        .expect(400);
    }
    await request(server).get('/api/budgets/progress').set('x-test-user', owner).expect(400);
    await request(server)
      .get(`/api/budgets/progress?ids=${cash}&ids=${notional}`)
      .set('x-test-user', owner)
      .expect(400);
    await request(server)
      .get('/api/budgets/progress')
      .query({ ids: cash, owner: other })
      .set('x-test-user', owner)
      .expect(400);
    await get(Array.from({ length: 20 }, () => randomUUID())).expect(200);
    await request(server)
      .get('/api/budgets/progress')
      .query({ ids: ` ${cash} ` })
      .set('x-test-user', owner)
      .expect(200);
  });
  it('includes earlier spend, sums each ledger once with its own time, basis and provenance', async () => {
    const parent = await log();
    await attempt(parent);
    await attempt(parent, owner, 0.25, earlier, 'api_key', false, 'listed', 1);
    await log(owner, 'subscription', 5, agent, earlier, true, 'native_family');
    await log(owner, null, 1);
    await log(owner, 'api_key', null);
    await log(owner, 'api_key', 0);
    await log(owner, 'api_key', 99, otherAgent);
    const old = await log(owner, 'api_key', 10, agent, before);
    await attempt(old, owner, 0.1);
    await attempt(parent, owner, 10, before, 'api_key', false, 'bundled', 2);
    await log(other, 'api_key', 99, agent);
    const result = await read([cash, notional]);
    expect(available(result).spentMicros).toBe(3850000);
    expect(available(result, 1).spentMicros).toBe(8850000);
    expect(available(result).provenance).toEqual({
      meteredRows: 7,
      unpricedRows: 1,
      unknownSpendMicros: 1000000,
      usageEstimated: false,
      priceEstimated: true,
    });
    expect(available(result, 1).provenance.usageEstimated).toBe(true);
    expect(available(result).points.at(-1)!.spentMicros).toBe(available(result).spentMicros);
    const canonical = await buildBudgetReader(drizzle(pool)).spendMicrosFor(
      owner,
      agent,
      at,
      new Date(result.asOf),
      'cash',
    );
    expect(canonical.micros).toBe(available(result).spentMicros);
    const recreated = await budget(owner);
    expect(available(await read([recreated])).spentMicros).toBe(3850000);
  });
  it('scopes both sides of attempt attribution while global attempts retain their own owner', async () => {
    const parent = await log(other, 'api_key', 99, agent);
    await attempt(parent, owner, 7, earlier, 'api_key', true, 'listed');
    expect(available(await read()).spentMicros).toBe(0);
    expect(available(await read()).provenance.meteredRows).toBe(0);
    const global = await budget(owner, 'cash', 'global', null);
    expect(available(await read([global])).spentMicros).toBe(7000000);
  });
  it('uses per-row micros and preserves estimates only in the included population', async () => {
    await log(owner, 'api_key', 0.00000049);
    await log(owner, 'api_key', 0.00000049);
    await log(owner, 'api_key', 0.00000051);
    await log(owner, 'subscription', 1, agent, earlier, true, 'listed');
    const first = available(await read());
    expect(first.spentMicros).toBe(1);
    expect(first.provenance.priceEstimated).toBe(false);
    const sub = available(await read([notional]));
    expect(sub.provenance.usageEstimated).toBe(true);
    // Neither provider existence/kind nor current prices are consulted by this read.
    await pool.query('UPDATE request_log SET provider_id=$1,model_id=$2 WHERE owner_user_id=$3', [
      randomUUID(),
      randomUUID(),
      owner,
    ]);
    expect(available(await read()).spentMicros).toBe(1);
  });
  it('keeps historical progress immutable through provider kind, price and deletion changes', async () => {
    const provider = randomUUID(),
      model = randomUUID();
    await pool.query(
      `INSERT INTO provider (id,owner_user_id,name,kind,protocol) VALUES ($1,$2,'progress fixture','api_key','openai_compatible')`,
      [provider, owner],
    );
    await pool.query(
      `INSERT INTO model (id,provider_id,external_model_id,input_price_per_1m,output_price_per_1m) VALUES ($1,$2,'fixture',1,2)`,
      [model, provider],
    );
    const parent = await log();
    await attempt(parent, owner, 1);
    await pool.query('UPDATE request_log SET provider_id=$1,model_id=$2 WHERE id=$3', [
      provider,
      model,
      parent,
    ]);
    const first = available(await read());
    await pool.query("UPDATE provider SET kind='subscription' WHERE id=$1", [provider]);
    await pool.query(
      'UPDATE model SET input_price_per_1m=999,output_price_per_1m=999 WHERE id=$1',
      [model],
    );
    expect(available(await read()).spentMicros).toBe(first.spentMicros);
    await pool.query('DELETE FROM provider WHERE id=$1', [provider]);
    expect(available(await read()).spentMicros).toBe(first.spentMicros);
  });
  it('retains attempt provenance and distinguishes priced zero from unpriced activity', async () => {
    const parent = await log(owner, 'api_key', 0);
    let result = available(await read());
    expect(result.provenance).toMatchObject({ meteredRows: 1, unpricedRows: 0 });
    await attempt(parent, owner, 0, earlier, 'subscription', true, 'native_family');
    result = available(await read());
    expect(result.provenance.usageEstimated).toBe(false);
    expect(available(await read([notional])).provenance).toMatchObject({
      usageEstimated: true,
      priceEstimated: true,
    });
    await pool.query(
      'UPDATE request_attempt SET cost=NULL,provider_kind=NULL WHERE request_log_id=$1',
      [parent],
    );
    result = available(await read());
    expect(result).toMatchObject({
      spentMicros: 0,
      provenance: { meteredRows: 2, unpricedRows: 1, usageEstimated: true, priceEstimated: true },
    });
    expect(Object.keys(port.budgetProgress)).toEqual(['read']);
  });
  it('keeps finite current-period pending separate, including partial settlement, then releases at terminal', async () => {
    const live = await batch();
    await batch(owner, 'in_progress', 1000000);
    await batch(owner, 'in_progress', 7000000, before);
    await batch(owner, 'submitting', null);
    await batch(other, 'submitting', 99000000);
    await batch(owner, 'completed', 99000000);
    await log(owner, 'api_key', 12.4);
    const alert = await budget(owner, 'cash', 'agent', agent, 'alert');
    const disabled = await budget(owner, 'cash', 'agent', agent, 'block', false);
    const res = await read([cash, notional, alert, disabled]);
    expect(available(res)).toMatchObject({
      spentMicros: 12400000,
      pendingMicros: 4000000,
      remainingMicros: 12600000,
      availableMicros: 8600000,
    });
    expect(available(res, 1).pendingMicros).toBe(4000000);
    expect(available(res, 2).availableMicros).toBeNull();
    expect(available(res, 3).availableMicros).toBeNull();
    await pool.query(
      "UPDATE batch_job SET status='completed',terminal_at=now(),settled_cost_micros=12400000 WHERE id=$1",
      [live],
    );
    expect(available(await read()).pendingMicros).toBe(1000000);
  });
  it('keeps configuration and totals in one repeatable-read snapshot during an edit', async () => {
    await log();
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK request_log IN ACCESS EXCLUSIVE MODE');
    const pending = read();
    try {
      for (let i = 0; i < 60; i++) {
        const wait = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%from "request_log"%'`,
        );
        if (wait.rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await pool.query('UPDATE budget SET amount=50 WHERE id=$1', [cash]);
      await blocker.query('COMMIT');
      const res = available(await pending);
      expect(res.budget.amount).toBe(25);
      expect(res.spentMicros).toBe(2000000);
      expect(available(await read()).budget.amount).toBe(50);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
  it('bounds lock waits, reports sanitized 503, and releases the failed transaction', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK request_log IN ACCESS EXCLUSIVE MODE');
    try {
      const res = await get([cash]).expect(503);
      expect(res.body).toMatchObject({ code: 'budget_progress_unavailable' });
      expect(JSON.stringify(res.body)).not.toMatch(/SELECT|request_log|password|spentMicros/);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(available(await read()).spentMicros).toBe(0);
  });
  it('bounds pool acquisition and returns a late checkout without starting work', async () => {
    const small = new Pool({ connectionString: url, max: 1 });
    const held = await small.connect();
    try {
      await expect(createBudgetProgressAccessor(small, 30).read(principal, [cash])).rejects.toThrow(
        'deadline',
      );
    } finally {
      held.release();
    }
    await small.query('SELECT 1');
    expect(small.waitingCount).toBe(0);
    await small.end();
  });
  it('uses bounded grouped work and existing indexes on representative month data', async () => {
    const month = new Date(at);
    month.setUTCDate(1);
    await pool.query(
      `INSERT INTO request_log
      (id,owner_user_id,agent_id,decision_layer,routing_reason,input_tokens,output_tokens,duration_ms,status,cost,provider_kind,created_at)
      SELECT gen_random_uuid()::text,CASE WHEN n<=20000 THEN $1 ELSE $2 END,'plan-agent-'||(n%10)::text,
        'explicit','plan-fixture',1,1,1,'success',0.000001,'api_key',
        $3::timestamptz+(n%1000)*interval '1 second' FROM generate_series(1,120000) n`,
      [owner, other, month],
    );
    await pool.query(
      `INSERT INTO request_attempt
      (id,request_log_id,owner_user_id,attempt_index,input_tokens,output_tokens,status,cost,provider_kind,created_at)
      SELECT gen_random_uuid()::text,id,owner_user_id,0,1,1,'success',0.000001,'api_key',created_at
      FROM request_log WHERE routing_reason='plan-fixture' AND owner_user_id=ANY($1)`,
      [[owner, other]],
    );
    await pool.query('ANALYZE request_log');
    await pool.query('ANALYZE request_attempt');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++)
      for (const basis of ['cash', 'notional'])
        ids.push(await budget(owner, basis, 'agent', `plan-agent-${i}`));
    await pool.query('UPDATE budget SET "window"=\'month\' WHERE id=ANY($1)', [ids]);
    const captured: { text: string; values: unknown[] }[] = [];
    // The accessor only uses the promise checkout overload. Capture exactly the SQL
    // executed by Drizzle, retaining the real connection and query implementation.
    const instrumented = {
      connect: async () => {
        const connection = await pool.connect();
        return new Proxy(connection, {
          get(target, key) {
            if (key === 'query')
              return (...args: unknown[]) => {
                const q = args[0];
                if (
                  typeof q === 'object' &&
                  q !== null &&
                  'text' in q &&
                  typeof q.text === 'string' &&
                  q.text.includes('group by 1')
                )
                  captured.push({ text: q.text, values: Array.isArray(args[1]) ? args[1] : [] });
                return Reflect.apply(target.query.bind(target), target, args);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pick<Pool, 'connect'>;
    const accessor = createBudgetProgressAccessor(instrumented);
    const started = performance.now();
    const response = await accessor.read(principal, ids);
    const distinctMs = performance.now() - started;
    expect(captured).toHaveLength(40);
    expect(response.results).toHaveLength(20);
    for (const item of response.results)
      expect((item as AvailableBudgetProgress).spentMicros).toBe(4000);
    const plans = [];
    for (const q of captured.slice(0, 2)) {
      const explained = await pool.query(
        'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + q.text,
        q.values,
      );
      plans.push(explained.rows[0]['QUERY PLAN']);
    }
    const planText = JSON.stringify(plans);
    // PostgreSQL can prefer owner-only/agent bitmap scans when the period covers
    // all of an owner's rows, or a parent lookup for selective agent attempts.
    // Verify indexed access, without prescribing one optimizer-specific plan.
    expect(planText).toMatch(/request_log_(owner(_created)?|agent)_idx/);
    expect(planText).toMatch(/request_attempt_(owner(_created)?|request)_idx/);
    // Twenty cards sharing a group execute only two ledger aggregates.
    await pool.query(
      "UPDATE budget SET agent_id='plan-agent-0',metering_basis='cash' WHERE id=ANY($1)",
      [ids],
    );
    captured.length = 0;
    const sharedStart = performance.now();
    await accessor.read(principal, ids);
    const sharedMs = performance.now() - sharedStart;
    expect(captured).toHaveLength(2);
    await writeFile(
      '/tmp/polyrouter-budget-progress-plans.json',
      JSON.stringify({ rowsPerLedger: 120000, groups: 20, distinctMs, sharedMs, plans }, null, 2),
    );
  }, 15000);
});
