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
  layer?: string;
  cost: number | null;
  tin?: number;
  tout?: number;
  status?: string;
  escalated?: boolean;
  estimated?: boolean;
  at: string;
  priceSource?: string;
  structuralBand?: string;
  structuralScore?: number;
  structuralBandSource?: string;
  qualitySignal?: number;
  errorKind?: string;
  errorStatus?: number;
  errorMessage?: string;
  errorRequestId?: string;
  routingHeaderName?: string;
  routingHeaderValue?: string;
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
         escalated, created_at, price_source, error_kind, error_status, error_message, error_request_id,
         structural_band, structural_score, structural_band_source, quality_signal,
         routing_header_name, routing_header_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'test',$8,$9,$10,$11,1,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        id,
        owner,
        s.agentId ?? null,
        s.providerId ?? null,
        s.modelId ?? null,
        s.tier ?? null,
        s.layer ?? 'default',
        s.tin ?? 0,
        s.tout ?? 0,
        s.estimated ?? false,
        s.cost,
        s.status ?? 'success',
        s.escalated ?? false,
        s.at,
        s.priceSource ?? null,
        s.errorKind ?? null,
        s.errorStatus ?? null,
        s.errorMessage ?? null,
        s.errorRequestId ?? null,
        s.structuralBand ?? null,
        s.structuralScore ?? null,
        s.structuralBandSource ?? null,
        s.qualitySignal ?? null,
        s.routingHeaderName ?? null,
        s.routingHeaderValue ?? null,
      ],
    );
    return id;
  }
  async function seedAttempt(
    logId: string,
    owner: string,
    s: {
      cost: number;
      modelId?: string;
      providerId?: string;
      tierKey?: string;
      at: string;
      priceSource?: string;
    },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO request_attempt
        (id, request_log_id, owner_user_id, attempt_index, tier_key, provider_id, model_id,
         input_tokens, output_tokens, cost, status, created_at, price_source)
       VALUES ($1,$2,$3,0,$4,$5,$6,20,5,$7,'success',$8,$9)`,
      [
        randomUUID(),
        logId,
        owner,
        s.tierKey ?? null,
        s.providerId ?? null,
        s.modelId ?? null,
        s.cost,
        s.at,
        s.priceSource ?? null,
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
      errorKind: 'rate_limit',
      errorStatus: 429,
      errorMessage: 'Rate limit exceeded: free-models-per-day',
      errorRequestId: 'req_e2e_1',
      structuralBand: 'ambiguous',
      structuralScore: 0.41,
      structuralBandSource: 'threshold',
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

  it('listRequests: error detail rides the safe view for failed rows only (add-request-error-detail)', async () => {
    const res = await q('requests', A, { ...RANGE, status: 'error' });
    expect(res.status).toBe(200);
    const errRow = res.body.rows.find((r: { errorKind: string | null }) => r.errorKind !== null);
    expect(errRow).toMatchObject({
      status: 'error',
      errorKind: 'rate_limit',
      errorStatus: 429,
      errorMessage: 'Rate limit exceeded: free-models-per-day',
      errorRequestId: 'req_e2e_1',
      structuralBand: 'ambiguous',
      structuralScore: 0.41,
      structuralBandSource: 'threshold',
    });
    expect(errRow).not.toHaveProperty('ownerUserId'); // safe view unchanged
    // Decision telemetry rides the same safe view (add-auto-decision-telemetry).
    expect(errRow).toMatchObject({
      structuralBand: 'ambiguous',
      structuralScore: 0.41,
      structuralBandSource: 'threshold',
    });
    const all = await q('requests', A, { ...RANGE });
    for (const row of all.body.rows) {
      if (row.status !== 'error') {
        // non-error rows carry all-null detail
        expect(row.errorKind).toBeNull();
        expect(row.errorMessage).toBeNull();
        // non-evaluated rows carry all-null telemetry
        expect(row.structuralBand).toBeNull();
        expect(row.structuralScore).toBeNull();
        expect(row.structuralBandSource).toBeNull();
      }
    }
  });

  it('listRequests: a microsecond-precision batch pages exactly once (E3)', async () => {
    // Production LogWriter flushes a batch in one INSERT, so every row shares one
    // µs-precision now(). Reproduce with a fresh owner + a shared µs timestamp;
    // walking one row per page must not drop the tie group (a ms-truncated cursor
    // would skip rows 2..N). Fails before the E3 fix, passes after.
    const owner = await mkUser();
    const SHARED_US = '2025-03-15T12:00:00.123456Z';
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      ids.add(await seedLog(owner, { layer: 'default', cost: 1, at: SHARED_US }));
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const query: Record<string, string | number> = { ...RANGE, limit: 1 };
      if (cursor) query['cursor'] = cursor;
      const res = await q('requests', owner, query);
      expect(res.status).toBe(200);
      for (const row of res.body.rows) {
        expect(seen.has(row.id)).toBe(false); // exactly once
        seen.add(row.id);
      }
      cursor = res.body.nextCursor;
      if (++pages > 10) throw new Error('pagination did not terminate');
      if (!cursor) break;
    }
    expect(seen).toEqual(ids); // all 3 rows — none skipped by a truncated cursor
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

  it('requests: a multi-value layer filter matches ANY listed layer (server-side); a bad segment is 400', async () => {
    const c = await mkUser();
    await seedLog(c, { layer: 'explicit', cost: 1, at: DAY1 });
    await seedLog(c, { layer: 'header', cost: 1, at: DAY1 });
    await seedLog(c, { layer: 'default', cost: 1, at: DAY1 });
    const res = await q('requests', c, { ...RANGE, layer: 'explicit,header', limit: 50 });
    expect(res.status).toBe(200);
    const layers = res.body.rows.map((r: { decisionLayer: string }) => r.decisionLayer).sort();
    expect(layers).toEqual(['explicit', 'header']); // the 'default' row is excluded
    // an empty / whitespace-only segment is rejected at the DTO (400)
    expect((await q('requests', c, { ...RANGE, layer: 'explicit,' })).status).toBe(400);
    expect((await q('requests', c, { ...RANGE, layer: ' , ' })).status).toBe(400);
    await pool.query('DELETE FROM "user" WHERE id = $1', [c]);
  });

  it('requests: the matched routing header rides the safe view (add-routing-header-visibility)', async () => {
    const c = await mkUser();
    await seedLog(c, {
      layer: 'header',
      cost: 1,
      at: DAY1,
      routingHeaderName: 'x-polyrouter-tier',
      routingHeaderValue: 'heavy',
    });
    await seedLog(c, { layer: 'header', cost: 1, at: DAY1, routingHeaderName: 'x-team' }); // custom rule: name only
    await seedLog(c, { layer: 'default', cost: 1, at: DAY1 }); // non-header / legacy shape
    const res = await q('requests', c, { ...RANGE, limit: 50 });
    expect(res.status).toBe(200);
    const rows = res.body.rows as {
      routingHeaderName: string | null;
      routingHeaderValue: string | null;
      decisionLayer: string;
    }[];
    expect(rows.find((r) => r.routingHeaderValue === 'heavy')).toMatchObject({
      routingHeaderName: 'x-polyrouter-tier',
    });
    expect(rows.find((r) => r.routingHeaderName === 'x-team')).toMatchObject({
      routingHeaderValue: null,
    });
    expect(rows.find((r) => r.decisionLayer === 'default')).toMatchObject({
      routingHeaderName: null,
      routingHeaderValue: null,
    });
    for (const row of rows) expect(row).not.toHaveProperty('ownerUserId'); // safe view unchanged
    // The DB CHECK rejects a value without a name (pair invariant).
    await expect(
      pool.query(
        `INSERT INTO request_log
          (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens,
           duration_ms, status, routing_header_value)
         VALUES ($1,$2,'header','test',0,0,1,'success','orphan-value')`,
        [randomUUID(), c],
      ),
    ).rejects.toThrow(/request_log_routing_header_pair/);
    await pool.query('DELETE FROM "user" WHERE id = $1', [c]);
  });

  it('native-family provenance rolls up: listing priceEstimated + summary nativeFamilySpend (add-native-price-fallback)', async () => {
    // A separate window so the shared corpus assertions stay untouched.
    const W = { from: '2025-05-01T00:00:00.000Z', to: '2025-05-02T00:00:00.000Z' };
    const AT = '2025-05-01T10:00:00.000Z';
    // $9 exact-priced served row + $1 native-priced superseded attempt (the pinned
    // mixed case), plus an all-exact row and a native-served row.
    const mixed = await seedLog(A, { cost: 9, priceSource: 'bundled', at: AT, layer: 'nf-mixed' });
    await seedAttempt(mixed, A, { cost: 1, priceSource: 'native_family', at: AT });
    await seedLog(A, { cost: 3, priceSource: 'refresh', at: AT, layer: 'nf-exact' });
    await seedLog(A, { cost: 0.5, priceSource: 'native_family', at: AT, layer: 'nf-native' });

    const summary = (await q('summary', A, W)).body;
    expect(summary.spend).toBeCloseTo(13.5, 9); // 9 + 1 + 3 + 0.5 — totals unchanged by provenance
    expect(summary.nativeFamilySpend).toBeCloseTo(1.5, 9); // COMPONENT-only: $1 attempt + $0.5 served

    const rows = (await q('requests', A, W)).body.rows as Array<{
      decisionLayer: string;
      priceSource: string | null;
      priceEstimated: boolean;
    }>;
    const byLayer = new Map(rows.map((r) => [r.decisionLayer, r]));
    // The mixed case: served source stays exact, the ATTEMPT estimate marks the roll-up.
    expect(byLayer.get('nf-mixed')).toMatchObject({ priceSource: 'bundled', priceEstimated: true });
    expect(byLayer.get('nf-exact')).toMatchObject({
      priceSource: 'refresh',
      priceEstimated: false,
    });
    expect(byLayer.get('nf-native')).toMatchObject({
      priceSource: 'native_family',
      priceEstimated: true,
    });
  });

  it('auto: the aggregation partitions exactly, savings is signed micro-dollar math with coverage, telemetrySince is range-independent (add-auto-performance-view)', async () => {
    const pa = userPrincipal(A);
    // Basis: auto_high → tier premium whose primary is modelA; kind=custom
    // honors model-own prices (E5.4), so the counterfactual is deterministic.
    await pool.query(
      `UPDATE model SET input_price_per_1m = 10, output_price_per_1m = 20 WHERE id = $1`,
      [modelA],
    );
    const premium = await port.tiers.insert(pa, { key: 'premium' });
    await port.routingEntries.replaceForTier(pa, premium.id, [modelA]);
    await port.routingRules.insert(pa, {
      matchType: 'auto_high',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:premium',
      priority: 0,
    });

    const AT = '2025-03-16T10:00:00.000Z'; // inside RANGE
    const banded = (over: Partial<Parameters<typeof seedLog>[1]>) =>
      seedLog(A, {
        agentId: agentA,
        providerId: provA,
        modelId: modelA,
        cost: 0.001,
        at: AT,
        ...over,
      });
    // Confident + declared + unroutable highs, a low:
    await banded({
      structuralBand: 'high',
      structuralScore: 0.7,
      structuralBandSource: 'threshold',
      layer: 'structural',
    });
    await banded({
      structuralBand: 'high',
      structuralScore: 0.2,
      structuralBandSource: 'declared',
      layer: 'structural',
    });
    await banded({
      structuralBand: 'high',
      structuralScore: 0.7,
      structuralBandSource: 'threshold',
      layer: 'default',
    }); // unroutable
    await banded({
      structuralBand: 'low',
      structuralScore: 0.1,
      structuralBandSource: 'threshold',
      layer: 'structural',
    });
    // The cascade partition — qualityPassed ×2 (one NEGATIVE delta), unknown, failed, escalated, escalated-CANCELLED:
    await banded({
      structuralBand: 'ambiguous',
      structuralScore: 0.4,
      structuralBandSource: 'threshold',
      layer: 'cascade',
      qualitySignal: 1,
      tin: 1000,
      tout: 500,
      cost: 0.001,
    });
    await banded({
      structuralBand: 'ambiguous',
      structuralScore: 0.4,
      structuralBandSource: 'threshold',
      layer: 'cascade',
      qualitySignal: 1,
      tin: 100,
      tout: 50,
      cost: 1.0,
    }); // cheap cost MORE
    await banded({
      structuralBand: 'ambiguous',
      structuralScore: 0.4,
      structuralBandSource: 'threshold',
      layer: 'cascade',
      qualitySignal: 1,
      tin: 10,
      tout: 5,
      cost: null,
    }); // uncosted
    await banded({
      structuralBand: 'ambiguous',
      structuralScore: 0.4,
      structuralBandSource: 'threshold',
      layer: 'cascade',
    }); // qualityUnknown (null signal, success)
    await banded({
      structuralBand: 'ambiguous',
      structuralScore: 0.4,
      structuralBandSource: 'threshold',
      layer: 'cascade',
      status: 'cancelled',
    }); // failedOrCancelled
    await banded({
      structuralBand: 'ambiguous',
      structuralScore: 0.4,
      structuralBandSource: 'threshold',
      layer: 'cascade',
      escalated: true,
      qualitySignal: 0.2,
    });
    await banded({
      structuralBand: 'ambiguous',
      structuralScore: 0.4,
      structuralBandSource: 'threshold',
      layer: 'cascade',
      escalated: true,
      status: 'cancelled',
    }); // counts ONLY as escalated
    await banded({
      structuralBand: 'ambiguous',
      structuralScore: 0.4,
      structuralBandSource: 'threshold',
      layer: 'default',
    }); // fallthrough
    // B: isolation — a banded row that must not leak into A's aggregates.
    await seedLog(B, {
      agentId: null,
      providerId: null,
      modelId: null,
      cost: 0.001,
      at: AT,
      structuralBand: 'high',
      structuralScore: 0.9,
      structuralBandSource: 'threshold',
      layer: 'structural',
    });

    const res = await q('auto', A, { ...RANGE, bucket: 'day' });
    expect(res.status).toBe(200);
    const body = res.body;
    // 12 rows seeded here + the suite's earlier error-detail row (ambiguous,
    // default layer, in range) = 13 evaluated, 9 ambiguous, 2 fallthrough.
    expect(body.evaluated).toBe(13);
    expect(body.bands.high).toEqual({ requests: 3, declared: 1, unroutable: 1 });
    expect(body.bands.low).toEqual({ requests: 1, declared: 0, unroutable: 0 });
    expect(body.bands.ambiguous.requests).toBe(9);
    // The DISJOINT partition sums exactly; the escalated cancellation counted once.
    expect(body.cascade).toEqual({
      requests: 7,
      qualityPassed: 3,
      qualityUnknown: 1,
      failedOrCancelled: 1,
      escalated: 2,
    });
    expect(body.fallthrough).toBe(2);
    // Savings: rows P1 (cf 20000µ − 1000µ = +19000µ) and P2 (cf 2000µ − 1000000µ = −998000µ);
    // the null-cost row excluded + disclosed. net = gross − excess EXACTLY.
    expect(body.savings).toMatchObject({
      rows: 2,
      uncostedRows: 1,
      netUsd: -0.979,
      grossUsd: 0.019,
      excessUsd: 0.998,
      basis: { kind: 'tier', label: 'premium', model: 'gpt-x' },
    });
    // telemetrySince is RANGE-INDEPENDENT: a range wholly before the rows still reports it.
    const before = await q('auto', A, {
      from: '2025-02-01T00:00:00.000Z',
      to: '2025-02-02T00:00:00.000Z',
    });
    expect(before.status).toBe(200);
    expect(before.body.evaluated).toBe(0);
    // The earliest banded row EVER is the suite's earlier error-detail seed
    // (DAY1B) — range-independence is exactly the point.
    expect(before.body.telemetrySince).toBe('2025-03-10T11:30:00.000Z');
    // Isolation: B sees only its own row.
    const bRes = await q('auto', B, { ...RANGE });
    expect(bRes.body.evaluated).toBe(1);
    expect(bRes.body.savings).toBeNull(); // B has no auto_high rule — basis unresolvable
  });

  it('auto: wholly-uncostable savings are null-money with coverage, cache-rate exclusion works, model basis resolves, guards fire (r3 folds)', async () => {
    // A fresh window so the big test's seeds stay out of these aggregates.
    const RANGE5 = { from: '2025-05-01T00:00:00.000Z', to: '2025-06-01T00:00:00.000Z' };
    const AT5 = '2025-05-10T10:00:00.000Z';
    const passed = (over: Partial<Parameters<typeof seedLog>[1]> = {}) =>
      seedLog(A, {
        agentId: agentA,
        providerId: provA,
        modelId: modelA,
        at: AT5,
        structuralBand: 'ambiguous',
        structuralScore: 0.4,
        structuralBandSource: 'threshold',
        layer: 'cascade',
        qualitySignal: 1,
        tin: 100,
        tout: 50,
        cost: 0.001,
        ...over,
      });
    // Two qualityPassed rows, BOTH uncostable: one by null recorded cost, one by
    // non-zero cache tokens against a basis with NO cache rate (modelA is a
    // custom model — resolveForModel yields null cache rates).
    await passed({ cost: null });
    const cacheRow = await passed(); // costable on its face…
    await pool.query(`UPDATE request_log SET cache_read_tokens = 500 WHERE id = $1`, [cacheRow]);

    const res = await q('auto', A, { ...RANGE5, bucket: 'day' });
    expect(res.status).toBe(200);
    // Unknown-not-zero (r3-High-2): zero costable rows → the THREE monetary
    // fields are null, never $0 — coverage and basis are retained.
    expect(res.body.cascade.qualityPassed).toBe(2);
    expect(res.body.savings).toEqual({
      rows: 0,
      uncostedRows: 2,
      netUsd: null,
      grossUsd: null,
      excessUsd: null,
      basis: { kind: 'tier', label: 'premium', model: 'gpt-x' },
    });

    // Model-target basis (r3-Medium-3): swap the auto_high rule to a direct
    // model target — the basis discriminates as kind:'model' labeled by the
    // external model id; the null-money contract is unchanged.
    await pool.query(
      `UPDATE routing_rule SET target = $1 WHERE owner_user_id = $2 AND match_type = 'auto_high'`,
      [`model:${modelA}`, A],
    );
    const modelRes = await q('auto', A, { ...RANGE5 });
    expect(modelRes.status).toBe(200);
    expect(modelRes.body.savings.basis).toEqual({ kind: 'model', label: 'gpt-x', model: 'gpt-x' });
    expect(modelRes.body.savings.netUsd).toBeNull();

    // Endpoint guards, auto-specific: bad bucket enum → 400 (DTO); inverted
    // range → 422 (service) — same contract as the sibling reads.
    expect((await q('auto', A, { ...RANGE5, bucket: 'bogus' })).status).toBe(400);
    expect((await q('auto', A, { from: RANGE5.to, to: RANGE5.from })).status).toBe(422);
  });

  it('the (owner, created_at) index the queries rely on exists', async () => {
    const idx = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'request_log_owner_created_idx'`,
    );
    expect(idx.rowCount).toBe(1);
  });
});
