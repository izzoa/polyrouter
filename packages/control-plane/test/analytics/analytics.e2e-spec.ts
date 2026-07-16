// Analytics aggregation e2e (#17). A stub principal guard over the real
// AnalyticsModule + persistence — asserts summary/timeseries/breakdown/list
// correctness (both-ledger µ$ spend), tenant isolation incl. an adversarial
// cross-tenant attempt, keyset pagination, and the input guards.
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
import { AnalyticsModule } from '../../src/analytics/analytics.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
const RANGE = { from: '2025-03-01T00:00:00.000Z', to: '2025-04-01T00:00:00.000Z' };
const DAY1 = '2025-03-10T10:00:00.000Z';
const DAY1B = '2025-03-10T11:30:00.000Z';
const DAY2 = '2025-03-11T09:00:00.000Z';

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

interface LogSeed {
  agentId?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  tier?: string | null;
  cost: number | null;
  tin?: number;
  tout?: number;
  status?: string;
  escalated?: boolean;
  estimated?: boolean;
  at: string;
}

describe('analytics API (#17)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let A: string;
  let B: string;
  let provA: string;
  let modelA: string;
  let agentA: string;
  let bLogId: string;
  let bAgent: string;

  const mkUser = async (): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'u', $1, false) RETURNING id`,
        [`an-${randomUUID()}@t.test`],
      )
    ).rows[0]!.id;

  const mkAgent = async (owner: string, name: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
         VALUES (gen_random_uuid(), $1, $2, 'h', $3, 'curl') RETURNING id`,
        [owner, name, `poly_${randomUUID().slice(0, 4)}`],
      )
    ).rows[0]!.id;

  async function seedLog(owner: string, s: LogSeed): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO request_log
        (id, owner_user_id, agent_id, provider_id, model_id, tier_assigned, decision_layer,
         routing_reason, input_tokens, output_tokens, usage_estimated, cost, duration_ms, status,
         escalated, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'default','test',$7,$8,$9,$10,1,$11,$12,$13)`,
      [
        id,
        owner,
        s.agentId ?? null,
        s.providerId ?? null,
        s.modelId ?? null,
        s.tier ?? null,
        s.tin ?? 0,
        s.tout ?? 0,
        s.estimated ?? false,
        s.cost,
        s.status ?? 'success',
        s.escalated ?? false,
        s.at,
      ],
    );
    return id;
  }
  async function seedAttempt(
    logId: string,
    owner: string,
    s: { cost: number; modelId?: string; providerId?: string; tierKey?: string; at: string },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO request_attempt
        (id, request_log_id, owner_user_id, attempt_index, tier_key, provider_id, model_id,
         input_tokens, output_tokens, cost, status, created_at)
       VALUES ($1,$2,$3,0,$4,$5,$6,20,5,$7,'success',$8)`,
      [
        randomUUID(),
        logId,
        owner,
        s.tierKey ?? null,
        s.providerId ?? null,
        s.modelId ?? null,
        s.cost,
        s.at,
      ],
    );
  }

  const q = (path: string, user: string, query: Record<string, string | number | boolean>) =>
    request(server).get(`/api/analytics/${path}`).set('x-test-user', user).query(query);

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AnalyticsModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);

    A = await mkUser();
    B = await mkUser();
    const pa = userPrincipal(A);
    provA = (
      await port.providers.insert(pa, {
        name: 'ProvA',
        kind: 'custom',
        protocol: 'openai_compatible',
        baseUrl: 'https://1.1.1.1/v1',
      })
    ).id;
    modelA = (await port.models.createForProvider(pa, provA, { externalModelId: 'gpt-x' }))!.id;
    agentA = await mkAgent(A, 'AgentA');

    // A: two priced agent requests (one escalated with an attempt), a free row, an unpriced row.
    await seedLog(A, {
      agentId: agentA,
      providerId: provA,
      modelId: modelA,
      tier: 'default',
      cost: 1,
      tin: 100,
      tout: 50,
      at: DAY1,
    });
    const log2 = await seedLog(A, {
      agentId: agentA,
      providerId: provA,
      modelId: modelA,
      tier: 'fast',
      cost: 2,
      tin: 200,
      tout: 80,
      status: 'fallback',
      escalated: true,
      at: DAY2,
    });
    await seedAttempt(log2, A, {
      cost: 0.5,
      providerId: provA,
      modelId: modelA,
      tierKey: 'cheap',
      at: DAY2,
    });
    await seedLog(A, {
      agentId: null,
      providerId: provA,
      modelId: modelA,
      tier: 'default',
      cost: 0,
      tin: 10,
      tout: 5,
      at: DAY1B,
    });
    await seedLog(A, {
      agentId: null,
      providerId: provA,
      modelId: modelA,
      tier: 'default',
      cost: null,
      tin: 20,
      tout: 0,
      status: 'error',
      estimated: true,
      at: DAY1B,
    });

    // B: an unrelated request (isolation) + an A-owned attempt pointing at B's log (adversarial).
    bAgent = await mkAgent(B, 'AgentB');
    bLogId = await seedLog(B, {
      agentId: bAgent,
      tier: 'default',
      cost: 99,
      tin: 1,
      tout: 1,
      at: DAY1,
    });
    // An A-owned attempt on a B-owned parent (an invalid state the recorder never
    // produces). Cost 0 so it can't skew A's spend — its only purpose is to prove
    // the agent-breakdown join scopes the LOG side, so B's agent_id never surfaces.
    await seedAttempt(bLogId, A, { cost: 0, at: DAY1 });
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[A, B]]);
    await app.close();
    await pool.end();
  });

  it('summary: totals + both-ledger µ$ spend (served row + its attempt)', async () => {
    const res = await q('summary', A, RANGE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      requests: 4,
      inputTokens: 330,
      outputTokens: 135,
      successCount: 2,
      fallbackCount: 1,
      errorCount: 1,
      escalatedCount: 1,
      estimatedCount: 1,
      freeRequests: 1,
      paidRequests: 2,
      unpricedRequests: 1,
    });
    expect(res.body.spend).toBeCloseTo(3.5, 9); // 1 + 2 + 0 + null→0 + 0.5 attempt
  });

  it('timeseries: UTC day buckets carry per-bucket requests + both-ledger spend', async () => {
    const res = await q('timeseries', A, { ...RANGE, bucket: 'day' });
    expect(res.status).toBe(200);
    const byDay = new Map(res.body.map((p: { bucket: string }) => [p.bucket.slice(0, 10), p]));
    expect((byDay.get('2025-03-10') as { requests: number; spend: number }).requests).toBe(3);
    expect((byDay.get('2025-03-10') as { spend: number }).spend).toBeCloseTo(1, 9);
    expect((byDay.get('2025-03-11') as { requests: number }).requests).toBe(1);
    expect((byDay.get('2025-03-11') as { spend: number }).spend).toBeCloseTo(2.5, 9); // 2 + 0.5 attempt
  });

  it('breakdown: labels, agent-attempt-via-parent, null key, attempt-only tier', async () => {
    const model = (await q('breakdown', A, { ...RANGE, dimension: 'model' })).body;
    expect(model[0]).toMatchObject({ key: modelA, label: 'gpt-x', requests: 4 });
    expect(model[0].spend).toBeCloseTo(3.5, 9);

    const agent = (await q('breakdown', A, { ...RANGE, dimension: 'agent' })).body;
    const agARow = agent.find((r: { key: string }) => r.key === agentA);
    expect(agARow).toMatchObject({ label: 'AgentA', requests: 2 });
    expect(agARow.spend).toBeCloseTo(3.5, 9); // 1 + 2 + 0.5 attempt attributed via parent
    expect(agent.find((r: { key: string }) => r.key === '')).toMatchObject({ label: null }); // null agent

    const tier = (await q('breakdown', A, { ...RANGE, dimension: 'tier' })).body;
    const cheap = tier.find((r: { key: string }) => r.key === 'cheap');
    expect(cheap).toMatchObject({ label: 'cheap', requests: 0 }); // attempt-only tier
    expect(cheap.spend).toBeCloseTo(0.5, 9);
  });

  it('listRequests: keyset pagination walks every row once, with labels + attempt cost, no owner cols', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let attemptRowMicros = -1;
    for (;;) {
      const query: Record<string, string | number> = { ...RANGE, limit: 2 };
      if (cursor) query['cursor'] = cursor;
      const res = await q('requests', A, query);
      expect(res.status).toBe(200);
      for (const row of res.body.rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
        expect(row).not.toHaveProperty('ownerUserId');
        expect(row).not.toHaveProperty('orgId');
        if (row.attemptCostMicros > 0) attemptRowMicros = row.attemptCostMicros;
      }
      cursor = res.body.nextCursor;
      if (++pages > 10) throw new Error('pagination did not terminate');
      if (!cursor) break;
    }
    expect(seen.size).toBe(4); // every A row exactly once
    expect(attemptRowMicros).toBe(500_000); // the escalated row carries its attempt cost
    // a served-priced row carries resolved labels
    const first = (await q('requests', A, { ...RANGE, limit: 1 })).body.rows[0];
    expect(first).toMatchObject({ modelLabel: 'gpt-x', providerLabel: 'ProvA' });
  });

  it('listRequests: status / escalated filters narrow correctly', async () => {
    const errs = (await q('requests', A, { ...RANGE, status: 'error' })).body.rows;
    expect(errs).toHaveLength(1);
    expect(errs[0].status).toBe('error');
    const esc = (await q('requests', A, { ...RANGE, escalated: true })).body.rows;
    expect(esc).toHaveLength(1);
    expect(esc[0].escalated).toBe(true);
  });

  it('is tenant-isolated, including an A-owned attempt on a B-owned parent', async () => {
    const summary = (await q('summary', A, RANGE)).body;
    expect(summary.spend).toBeCloseTo(3.5, 9); // never B's $99, nor the A-attempt-on-B-parent $7
    const reqs = (await q('requests', A, { ...RANGE, limit: 100 })).body.rows;
    expect(reqs.some((r: { id: string }) => r.id === bLogId)).toBe(false);
    // the adversarial attempt's parent is B's, so A's agent breakdown never surfaces B's agent
    const agent = (await q('breakdown', A, { ...RANGE, dimension: 'agent' })).body;
    expect(agent.some((r: { key: string }) => r.key === bAgent)).toBe(false);
    // B sees only its own row
    const bSummary = (await q('summary', B, RANGE)).body;
    expect(bSummary.requests).toBe(1);
    expect(bSummary.spend).toBeCloseTo(99, 9);
  });

  it('guards: bad enum/ISO → 400 (DTO); from>=to / over-range / bad cursor → 422 (service)', async () => {
    expect((await q('summary', A, { from: 'nope', to: RANGE.to })).status).toBe(400);
    expect((await q('timeseries', A, { ...RANGE, bucket: 'year' })).status).toBe(400);
    expect((await q('summary', A, { from: RANGE.to, to: RANGE.from })).status).toBe(422); // from >= to
    expect(
      (await q('summary', A, { from: '2000-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z' })).status,
    ).toBe(422); // > 400 days
    expect((await q('requests', A, { ...RANGE, cursor: 'not-a-valid-cursor' })).status).toBe(422);
  });

  it('the (owner, created_at) index the queries rely on exists', async () => {
    const idx = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'request_log_owner_created_idx'`,
    );
    expect(idx.rowCount).toBe(1);
  });
});
