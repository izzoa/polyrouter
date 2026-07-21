// Auto-layers endpoint e2e (#20, real Postgres). Stub principal guard (no
// better-auth). `ROUTING_AUTO_LAYERS=cascade` so both layers are available
// instance-wide; the endpoint reports effective + capability, `PUT` is a full
// replacement that normalizes `cascade → structural`, and the preference is
// owner-scoped.
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

describe('auto-layers endpoint e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let aUserId: string;
  let bUserId: string;

  async function seedUser(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${Date.now()}@autolayers.test`],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['ROUTING_AUTO_LAYERS'] = 'cascade'; // ⇒ structural + cascade available
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
    aUserId = await seedUser('alA');
    bUserId = await seedUser('alB');
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[aUserId, bUserId]]);
    await app.close();
    await pool.end();
  });

  const asA = (m: 'get' | 'put', path: string) =>
    request(server)[m](path).set('x-test-user', aUserId);
  const asB = (m: 'get' | 'put', path: string) =>
    request(server)[m](path).set('x-test-user', bUserId);

  const URL = '/api/routing/auto-layers';
  /** The calibration state block for an uncalibrated tenant on instance
   * defaults (add-auto-threshold-calibration) — appended to every view. */
  const CAL = {
    enabled: false,
    calibratedHigh: null,
    calibratedLow: null,
    instanceHigh: 0.6,
    instanceLow: 0.25,
    effectiveHigh: 0.6,
    effectiveLow: 0.25,
  };

  it('requires a session (401 without a principal)', async () => {
    expect((await request(server).get(URL)).status).toBe(401);
  });

  it('GET with no stored preference inherits-on (effective = capability), no-store', async () => {
    const res = await asA('get', URL);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      structural: true,
      cascade: true,
      structuralAvailable: true,
      cascadeAvailable: true,
      semanticAvailable: false,
      calibration: CAL,
    });
  });

  it('PUT is a full replacement that normalizes cascade → structural, and persists', async () => {
    const put = await asA('put', URL).send({ structural: false, cascade: true });
    expect(put.status).toBe(200);
    expect(put.headers['cache-control']).toBe('no-store');
    // structural forced on by the cascade request; both available → both effective.
    expect(put.body).toEqual({
      structural: true,
      cascade: true,
      structuralAvailable: true,
      cascadeAvailable: true,
      semanticAvailable: false,
      calibration: CAL,
    });
    // Persisted — a later GET returns the same.
    expect((await asA('get', URL)).body).toEqual(put.body);
  });

  it('PUT can opt out of both layers and back to structural-only', async () => {
    expect((await asA('put', URL).send({ structural: false, cascade: false })).body).toEqual({
      structural: false,
      cascade: false,
      structuralAvailable: true,
      cascadeAvailable: true,
      semanticAvailable: false,
      calibration: CAL,
    });
    expect((await asA('put', URL).send({ structural: true, cascade: false })).body).toEqual({
      structural: true,
      cascade: false,
      structuralAvailable: true,
      cascadeAvailable: true,
      semanticAvailable: false,
      calibration: CAL,
    });
  });

  it('rejects a partial or malformed body (both booleans required)', async () => {
    expect((await asA('put', URL).send({ structural: true })).status).toBe(400); // missing cascade
    expect((await asA('put', URL).send({})).status).toBe(400);
    expect((await asA('put', URL).send({ structural: 'yes', cascade: true })).status).toBe(400);
    // forbidNonWhitelisted rejects unknown keys.
    expect(
      (await asA('put', URL).send({ structural: true, cascade: true, sneaky: 1 })).status,
    ).toBe(400);
  });

  it('owner-scopes the preference across the upsert conflict path (independent rows)', async () => {
    // Both tenants have distinct rows; re-PUT exercises onConflictDoUpdate.
    await asA('put', URL).send({ structural: true, cascade: false });
    await asB('put', URL).send({ structural: false, cascade: false });
    await asA('put', URL).send({ structural: false, cascade: false }); // A upsert-updates
    expect((await asA('get', URL)).body).toMatchObject({ structural: false, cascade: false });
    expect((await asB('get', URL)).body).toMatchObject({ structural: false, cascade: false });
    // Flip B through its own conflict path — A must be untouched.
    await asB('put', URL).send({ structural: true, cascade: true });
    expect((await asB('get', URL)).body).toMatchObject({ structural: true, cascade: true });
    expect((await asA('get', URL)).body).toMatchObject({ structural: false, cascade: false });
  });

  it('the DB CHECK rejects a stored cascade-on / structural-off row (migration backstop)', async () => {
    const u = await seedUser('alChk'); // a fresh owner (no unique-index collision)
    try {
      await expect(
        pool.query(
          `INSERT INTO routing_settings (id, owner_user_id, structural_enabled, cascade_enabled)
           VALUES (gen_random_uuid()::text, $1, false, true)`,
          [u],
        ),
      ).rejects.toThrow(/cascade_implies_structural/);
    } finally {
      await pool.query('DELETE FROM "user" WHERE id = $1', [u]);
    }
  });
});
