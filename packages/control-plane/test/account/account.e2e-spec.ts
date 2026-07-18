// Dashboard identity/login-bootstrap e2e (#18). Boots the REAL SessionGuard +
// the REAL mountAuth ordering with a FAKE AuthInstance (getSession → null) and a
// no-op rate limiter — so we exercise localhost auto-login and the `/api/auth*`
// prefix interception WITHOUT importing the ESM better-auth package.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import { AccountController } from '../../src/account/account.controller';
import { SessionGuard } from '../../src/auth/session.guard';
import { AUTH_INSTANCE } from '../../src/auth/auth.tokens';
import { AuthRateLimitMiddleware } from '../../src/auth/rate-limit.middleware';
import { mountAuth } from '../../src/auth/mount';
import { DatabaseModule } from '../../src/database/database.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

/** A fake Better Auth instance: no session, and a raw handler that 404s every
 * `/api/auth/*` — proving the mount intercepts that prefix before Nest. */
const fakeAuth = {
  handler: (
    _req: unknown,
    res: {
      statusCode: number;
      setHeader: (k: string, v: string) => void;
      end: (b?: string) => void;
    },
  ) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end('{"fake":"better-auth"}');
  },
  getSession: () => Promise.resolve(null),
  signUpEmail: () => Promise.resolve({}),
};

describe('account bootstrap endpoints (#18)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let adminId: string;

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
    adminId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified, role)
         VALUES (gen_random_uuid(), 'Admin', $1, true, 'admin') RETURNING id`,
        [`admin-${randomUUID()}@acct.test`],
      )
    ).rows[0]!.id;
    // Users exist, so login-config reflects the stored registration mode — pin
    // it so the assertion below is deterministic across suite orderings.
    await pool.query(
      `INSERT INTO "instance_settings" ("id", "registration_mode") VALUES ('singleton', 'open')
       ON CONFLICT ("id") DO UPDATE SET "registration_mode" = 'open'`,
    );

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
      controllers: [AccountController],
      providers: [
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: AUTH_INSTANCE, useValue: fakeAuth },
        // mountAuth resolves this by class token; a no-op keeps Redis out of the test.
        {
          provide: AuthRateLimitMiddleware,
          useValue: { use: (_req: unknown, _res: unknown, next: () => void) => next() },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    mountAuth(app as NestExpressApplication); // rate limiter → fake auth handler → parsers
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = $1', [adminId]);
    await app.close();
    await pool.end();
  });

  it('GET /api/login-config is public, reachable (not swallowed by the /api/auth mount), and lists no configured OAuth providers by default', async () => {
    const res = await request(server).get('/api/login-config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: 'selfhosted',
      emailPassword: true,
      oauthProviders: [],
      registration: 'open',
    });
    expect(JSON.stringify(res.body)).not.toContain('fake'); // reached Nest, not the auth handler
  });

  it('the /api/auth* prefix is intercepted by the (fake) Better Auth handler before Nest', async () => {
    const res = await request(server).get('/api/auth/anything');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ fake: 'better-auth' }); // proves why login-config lives OUTSIDE /api/auth
  });

  it('GET /api/me returns the admin identity via localhost auto-login (no cookie)', async () => {
    // Auto-login resolves the instance's admin; assert the identity shape (the
    // shared dev DB may already hold an admin, so the id isn't pinned to our seed).
    const res = await request(server).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'admin', mode: 'selfhosted' });
    expect(typeof res.body.userId).toBe('string');
    expect(typeof res.body.email).toBe('string');
    // the returned principal is a real admin row
    const check = await pool.query<{ role: string }>('SELECT role FROM "user" WHERE id = $1', [
      res.body.userId,
    ]);
    expect(check.rows[0]?.role).toBe('admin');
  });

  it('GET /api/me is 401 when auto-login is ineligible (a forwarding header ⇒ not loopback-only)', async () => {
    const res = await request(server).get('/api/me').set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(401);
  });
});
