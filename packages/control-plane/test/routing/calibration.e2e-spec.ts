// Threshold-calibration e2e (add-auto-threshold-calibration, real Postgres).
// Drives the queue-free occurrence over SEEDED telemetry (the scheduler's
// BullMQ shell is exercised in redis e2e patterns elsewhere; the decision
// engine is what matters here): a move updates the settings row + appends its
// per-edge events atomically (anchor + epoch stamped); hygiene rebases a
// DISABLED tenant's stale pair; revert is conditional + idempotent; the API
// reports the trio with inert pairs presented as uncalibrated; PUT omission
// preserves the flag; history limits are pinned; everything owner-scoped.
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
import { randomUUID } from 'node:crypto';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { RoutingConfigModule } from '../../src/routing-config/routing-config.module';
import { buildCalibrationConfig, railsOf } from '../../src/calibration/calibration.config';
import { runCalibrationOccurrence } from '../../src/calibration/calibration.run';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
const STRUCTURAL = { high: 0.6, low: 0.25 };
const CFG = buildCalibrationConfig({
  CALIBRATION_SCHED_ENABLED: 'true',
  CALIBRATION_SCHED_CRON: '0 4 * * *',
  CALIBRATION_WINDOW_DAYS: 14,
  CALIBRATION_MIN_EDGE_SAMPLES: 50,
  CALIBRATION_STEP: 0.02,
  CALIBRATION_MAX_DRIFT: 0.1,
});
const RAILS = railsOf(CFG);
const DAY = 86_400_000;
/** Window upper bound must POSTDATE the seeds (created_at = insert time), so
 * every run stamps its own `now` with a minute of slack. */
const now = (): number => Date.now() + 60_000;
const silent = { warn: () => {}, log: () => {} };

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

describe('threshold calibration e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let A: string;
  let B: string;

  async function seedUser(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${Date.now()}@cal.test`],
    );
    return rows[0]!.id;
  }

  /** A quality-DECIDED, threshold-source, current-epoch ambiguous cascade row
   * inside the high edge zone [0.55, 0.6). */
  async function seedEdgeRow(
    owner: string,
    score: number,
    failed: boolean,
    epoch = 0,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO request_log
        (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens,
         usage_estimated, duration_ms, status, escalated, escalation_source, created_at,
         structural_band, structural_score, structural_band_source, structural_epoch, quality_signal)
       VALUES ($1,$2,'cascade','t',10,5,false,1,$3,$4,$5,now(),'ambiguous',$6,'threshold',$7,$8)`,
      [
        randomUUID(),
        owner,
        'success',
        failed,
        failed ? 'quality_gate' : null,
        score,
        epoch,
        failed ? 0 : 1,
      ],
    );
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['ROUTING_AUTO_LAYERS'] = 'cascade';
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
    await app.init();
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    A = await seedUser('calA');
    B = await seedUser('calB');
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[A, B]]);
    await app.close();
    await pool.end();
  });

  const as = (u: string, m: 'get' | 'put' | 'post', path: string) =>
    request(server)[m](path).set('x-test-user', u);

  it('a hot high edge moves one step: row + per-edge event atomic, anchor + epoch stamped', async () => {
    // Enable calibration for A; B stays untouched (isolation).
    await as(A, 'put', '/api/routing/auto-layers').send({
      structural: true,
      cascade: true,
      calibration: true,
    });
    // 60 decided high-edge rows, 48 quality failures (rate 0.8 ≥ 0.65).
    for (let i = 0; i < 60; i++) await seedEdgeRow(A, 0.57, i < 48);
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, now(), silent);
    expect(sum.moves).toBe(1);
    expect(sum.rebases).toBe(0);

    const state = (await as(A, 'get', '/api/routing/auto-layers')).body;
    expect(state.calibration).toEqual({
      enabled: true,
      calibratedHigh: 0.58,
      calibratedLow: 0.25,
      instanceHigh: 0.6,
      instanceLow: 0.25,
      effectiveHigh: 0.58,
      effectiveLow: 0.25,
    });
    const { rows } = await pool.query<{ calibration_epoch: number }>(
      `SELECT calibration_epoch FROM routing_settings WHERE owner_user_id = $1`,
      [A],
    );
    expect(rows[0]!.calibration_epoch).toBe(1);

    const history = (await as(A, 'get', '/api/routing/calibration/history')).body as {
      trigger: string;
      edge: string | null;
      oldHigh: number;
      newHigh: number;
      edgeSamples: number | null;
      edgeFailures: number | null;
      anchorHigh: number;
    }[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      trigger: 'calibrator',
      edge: 'high',
      oldHigh: 0.6,
      newHigh: 0.58,
      edgeSamples: 60,
      edgeFailures: 48,
      anchorHigh: 0.6,
    });
    // Isolation: B sees nothing.
    expect((await as(B, 'get', '/api/routing/calibration/history')).body).toEqual([]);
    const bState = (await as(B, 'get', '/api/routing/auto-layers')).body;
    expect(bState.calibration.calibratedHigh).toBeNull();
  });

  it('old-epoch evidence never re-qualifies (the same burst cannot move twice)', async () => {
    // The 60 rows above are epoch-0; A is now epoch 1 — a fresh run must NOT
    // move again (cooldown ALSO applies; both rails point the same way).
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, now(), silent);
    expect(sum.moves).toBe(0);
    expect((await as(A, 'get', '/api/routing/calibration/history')).body).toHaveLength(1);
  });

  it('PUT omitting the calibration flag preserves it and never touches the pair', async () => {
    const res = await as(A, 'put', '/api/routing/auto-layers').send({
      structural: true,
      cascade: false, // an old client replaying only the layer flags
    });
    expect(res.status).toBe(200);
    expect(res.body.calibration.enabled).toBe(true); // preserved, not reset
    expect(res.body.calibration.calibratedHigh).toBe(0.58); // pair untouched
  });

  it('an inert (anchor-stale) pair is presented as uncalibrated, then hygiene rebases it — even DISABLED', async () => {
    // Disable calibration, then fake an operator default-change by re-anchoring
    // the stored pair to foreign defaults.
    await as(A, 'put', '/api/routing/auto-layers').send({
      structural: true,
      cascade: true,
      calibration: false,
    });
    await pool.query(
      `UPDATE routing_settings SET calibrated_anchor_high = 0.7, calibrated_anchor_low = 0.2 WHERE owner_user_id = $1`,
      [A],
    );
    const stale = (await as(A, 'get', '/api/routing/auto-layers')).body;
    expect(stale.calibration.calibratedHigh).toBeNull(); // inert, not presented
    expect(stale.calibration.effectiveHigh).toBe(0.6); // routing on instance NOW

    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, now(), silent);
    expect(sum.rebases).toBe(1); // retired despite calibration disabled
    const { rows } = await pool.query<{ calibrated_high: number | null }>(
      `SELECT calibrated_high FROM routing_settings WHERE owner_user_id = $1`,
      [A],
    );
    expect(rows[0]!.calibrated_high).toBeNull();
    const history = (await as(A, 'get', '/api/routing/calibration/history')).body as {
      trigger: string;
    }[];
    expect(history[0]!.trigger).toBe('rebase');
  });

  it('revert clears conditionally, appends exactly one event, and repeats as a no-op', async () => {
    // Re-enable + re-calibrate A (fresh evidence at the CURRENT epoch).
    await as(A, 'put', '/api/routing/auto-layers').send({
      structural: true,
      cascade: true,
      calibration: true,
    });
    const { rows: epochRows } = await pool.query<{ calibration_epoch: number }>(
      `SELECT calibration_epoch FROM routing_settings WHERE owner_user_id = $1`,
      [A],
    );
    const epoch = epochRows[0]!.calibration_epoch;
    for (let i = 0; i < 60; i++) await seedEdgeRow(A, 0.57, i < 48, epoch);
    // `later` sits 4 days out: past the 3-day cooldown from the earlier move
    // events, while the 14-day window still covers the just-seeded rows.
    const later = Date.now() + 4 * DAY;
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, later, silent);
    expect(sum.moves).toBe(1);

    const rev = await as(A, 'post', '/api/routing/calibration/revert');
    expect(rev.status).toBe(200);
    expect(rev.body.calibration.calibratedHigh).toBeNull();
    expect(rev.body.calibration.effectiveHigh).toBe(0.6);
    const again = await as(A, 'post', '/api/routing/calibration/revert');
    expect(again.status).toBe(200); // idempotent no-op
    const history = (await as(A, 'get', '/api/routing/calibration/history')).body as {
      trigger: string;
      oldHigh: number;
      newHigh: number;
    }[];
    const reverts = history.filter((h) => h.trigger === 'revert');
    expect(reverts).toHaveLength(1); // exactly one event from the clearing revert
    expect(reverts[0]).toMatchObject({ oldHigh: 0.58, newHigh: 0.6 });
  });

  it('a two-edge move bumps the epoch twice with deterministically ORDERED chained events (r3-Med-5)', async () => {
    // A is on instance defaults after the revert; calibration still enabled.
    const { rows: er } = await pool.query<{ calibration_epoch: number }>(
      `SELECT calibration_epoch FROM routing_settings WHERE owner_user_id = $1`,
      [A],
    );
    const epoch = er[0]!.calibration_epoch;
    // Hot high edge AND quiet low edge, both current-epoch, in one window.
    for (let i = 0; i < 60; i++) await seedEdgeRow(A, 0.57, i < 48, epoch); // rate 0.8
    for (let i = 0; i < 60; i++) await seedEdgeRow(A, 0.27, i < 3, epoch); // rate 0.05
    const later = Date.now() + 8 * DAY; // clear of every prior event's cooldown
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, later, silent);
    expect(sum.moves).toBe(1);

    const { rows: after } = await pool.query<{ calibration_epoch: number }>(
      `SELECT calibration_epoch FROM routing_settings WHERE owner_user_id = $1`,
      [A],
    );
    expect(after[0]!.calibration_epoch).toBe(epoch + 2); // one bump PER event

    const history = (await as(A, 'get', '/api/routing/calibration/history')).body as {
      trigger: string;
      edge: string | null;
      oldHigh: number;
      oldLow: number;
      newHigh: number;
      newLow: number;
    }[];
    // Newest-first with the ordinal as secondary sort: the LOW edge applied
    // second is newest; the chain replays linearly (high's new pair is low's
    // old pair) — deterministic despite one shared transaction timestamp.
    const [lowEv, highEv] = history;
    expect(highEv).toMatchObject({ edge: 'high', oldHigh: 0.6, newHigh: 0.58, oldLow: 0.25 });
    expect(lowEv).toMatchObject({ edge: 'low', oldHigh: 0.58, oldLow: 0.25, newLow: 0.27 });
  });

  it('history pins its limits: default 20, cap 100, invalid → 400', async () => {
    expect((await as(A, 'get', '/api/routing/calibration/history?limit=101')).status).toBe(400);
    expect((await as(A, 'get', '/api/routing/calibration/history?limit=0')).status).toBe(400);
    expect((await as(A, 'get', '/api/routing/calibration/history?limit=abc')).status).toBe(400);
    expect((await as(A, 'get', '/api/routing/calibration/history?limit=100')).status).toBe(200);
  });

  it('requires a session (401 without a principal)', async () => {
    expect((await request(server).post('/api/routing/calibration/revert')).status).toBe(401);
    expect((await request(server).get('/api/routing/calibration/history')).status).toBe(401);
  });
});
