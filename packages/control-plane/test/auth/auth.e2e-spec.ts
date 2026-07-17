// One file (single Jest environment) so better-auth's native ESM import isn't
// re-bound across file teardowns. Each describe applies the env its app needs
// before building it — config is read fresh at construction.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import {
  applyAuthEnv,
  clearRateLimits,
  createAuthApp,
  resetAuthState,
  uniqueEmail,
} from './auth-harness';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;

interface SignedUp {
  cookie: string[];
  email: string;
}
async function signUp(
  server: App,
  email = uniqueEmail('user'),
  password = 'password12345',
): Promise<SignedUp> {
  const res = await request(server)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Test', email, password });
  expect([200, 201]).toContain(res.status);
  const setCookie = res.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return { cookie, email };
}

// Documented flake (TODOS/memory): under the FULL e2e run this suite's harness
// intermittently dies in jest-runtime module loading ("Cannot read properties of
// undefined (reading 'identifier')") and passes clean on retry / standalone. One
// retry keeps CI signal-preserving (errors still logged) without masking a real
// regression, which would fail both attempts.
jest.retryTimes(1, { logErrorsBeforeRetry: true });

// ────────────────────────────────────────────────────────────── cloud plane
describe('auth flow, planes & agent keys (session-auth / agent-keys)', () => {
  let app: NestExpressApplication;
  let server: App;

  beforeAll(async () => {
    applyAuthEnv({ MODE: 'cloud', realSecrets: true });
    app = await createAuthApp();
    server = app.getHttpServer();
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAuthState(databaseUrl);
    await clearRateLimits();
  });

  it('signup issues a session that authenticates /api; no session → 401', async () => {
    const { cookie } = await signUp(server);
    const authed = await request(server).get('/api/probe').set('Cookie', cookie);
    expect(authed.status).toBe(200);
    expect(authed.body.principal.kind).toBe('user');
    expect((await request(server).get('/api/probe')).status).toBe(401);
  });

  it('an UPPER-CASE /API path is still session-guarded (E9.2 — no case bypass)', async () => {
    const { cookie } = await signUp(server);
    // Express routes case-insensitively; the guard must scope /API like /api.
    expect((await request(server).get('/API/probe')).status).toBe(401); // no session → 401, not 500/SPA
    const authed = await request(server).get('/API/probe').set('Cookie', cookie);
    expect(authed.status).toBe(200); // a valid session still authenticates the upper-case path
    expect(authed.body.principal.kind).toBe('user');
  });

  it('health is @Public under the real session guard (no session needed)', async () => {
    const res = await request(server).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('stores a salted scrypt password — not plaintext, not a fast digest', async () => {
    const { email } = await signUp(server, uniqueEmail('scrypt'), 'super-secret-pw-9');
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const rows = await pool.query<{ password: string | null }>(
        `SELECT a.password FROM account a JOIN "user" u ON u.id = a.user_id WHERE u.email = $1`,
        [email],
      );
      const stored = rows.rows[0]?.password ?? '';
      expect(stored.length).toBeGreaterThan(20);
      expect(stored).not.toContain('super-secret-pw-9');
      expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/i);
    } finally {
      await pool.end();
    }
  });

  it('a session cookie is inert on /v1 and a bearer key is inert on /api', async () => {
    const { cookie } = await signUp(server);
    expect((await request(server).get('/v1/probe').set('Cookie', cookie)).status).toBe(401);
    const created = await request(server)
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({ name: 'a', harness: 'curl' });
    const key: string = created.body.key;
    expect(
      (await request(server).get('/api/probe').set('Authorization', `Bearer ${key}`)).status,
    ).toBe(401);
  });

  it('role cannot be mass-assigned at signup', async () => {
    await signUp(server, uniqueEmail('first'));
    const victim = uniqueEmail('escalate');
    await request(server)
      .post('/api/auth/sign-up/email')
      .send({ name: 'x', email: victim, password: 'password12345', role: 'admin' });
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const rows = await pool.query<{ role: string | null }>(
        `SELECT role FROM "user" WHERE email = $1`,
        [victim],
      );
      expect(rows.rows[0]?.role ?? null).not.toBe('admin');
    } finally {
      await pool.end();
    }
  });

  it('concurrent first signups yield exactly one admin and one default tier each', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        request(server)
          .post('/api/auth/sign-up/email')
          .send({ name: 'race', email: uniqueEmail('race'), password: 'password12345' }),
      ),
    );
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      expect(
        (await pool.query(`SELECT count(*)::int n FROM "user" WHERE role='admin'`)).rows[0].n,
      ).toBe(1);
      const users = await pool.query<{ id: string }>(`SELECT id FROM "user"`);
      expect(users.rows.length).toBe(5);
      for (const u of users.rows) {
        const t = await pool.query(
          `SELECT count(*)::int n FROM tier WHERE owner_user_id=$1 AND key='default'`,
          [u.id],
        );
        expect(t.rows[0].n).toBe(1);
      }
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('minted key authenticates /v1; rotation kills the old key; no-store; no hash leak', async () => {
    const { cookie } = await signUp(server);
    const created = await request(server)
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({ name: 'openclaw', harness: 'openclaw' });
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toContain('no-store');
    expect(created.body.key).toMatch(/^poly_/);
    expect(created.body.snippet).toContain('poly_');
    expect(JSON.stringify(created.body)).not.toContain('api_key_hash');
    const key1: string = created.body.key;
    const id: string = created.body.id;
    expect(
      (await request(server).get('/v1/probe').set('Authorization', `Bearer ${key1}`)).status,
    ).toBe(200);
    const rotated = await request(server)
      .post(`/api/agents/${id}/rotate-key`)
      .set('Cookie', cookie)
      .send();
    const key2: string = rotated.body.key;
    expect(key2).not.toBe(key1);
    expect(
      (await request(server).get('/v1/probe').set('Authorization', `Bearer ${key1}`)).status,
    ).toBe(401);
    expect(
      (await request(server).get('/v1/probe').set('Authorization', `Bearer ${key2}`)).status,
    ).toBe(200);
  });

  it('rejects unknown prefix, wrong key, and malformed header uniformly', async () => {
    const { cookie } = await signUp(server);
    const created = await request(server)
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({ name: 'a', harness: 'curl' });
    const key: string = created.body.key;
    const wrong = `${key.slice(0, -3)}xyz`;
    for (const header of ['Bearer poly_unknownprefix000', `Bearer ${wrong}`, 'Basic foo', key]) {
      expect((await request(server).get('/v1/probe').set('Authorization', header)).status).toBe(
        401,
      );
    }
  });

  it('stamps last_used_at (coalesced) and never leaks the hash', async () => {
    const { cookie } = await signUp(server);
    const created = await request(server)
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({ name: 'a', harness: 'curl' });
    const key: string = created.body.key;
    const id: string = created.body.id;
    await request(server).get('/v1/probe').set('Authorization', `Bearer ${key}`);
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      let lastUsed: Date | null = null;
      for (let i = 0; i < 20 && lastUsed === null; i++) {
        const rows = await pool.query<{ last_used_at: Date | null }>(
          `SELECT last_used_at FROM agent WHERE id=$1`,
          [id],
        );
        lastUsed = rows.rows[0]?.last_used_at ?? null;
        if (!lastUsed) await new Promise((r) => setTimeout(r, 50));
      }
      expect(lastUsed).not.toBeNull();
      const listed = await request(server).get('/api/agents').set('Cookie', cookie);
      expect(JSON.stringify(listed.body)).not.toContain('api_key_hash');
    } finally {
      await pool.end();
    }
  });

  it('cross-tenant agent access fails closed', async () => {
    const a = await signUp(server, uniqueEmail('a'));
    const b = await signUp(server, uniqueEmail('b'));
    const bAgent = await request(server)
      .post('/api/agents')
      .set('Cookie', b.cookie)
      .send({ name: 'b-agent', harness: 'curl' });
    const bKey: string = bAgent.body.key;
    const bId: string = bAgent.body.id;
    expect(
      (await request(server).post(`/api/agents/${bId}/rotate-key`).set('Cookie', a.cookie).send())
        .status,
    ).toBe(404);
    expect(
      (await request(server).delete(`/api/agents/${bId}`).set('Cookie', a.cookie)).status,
    ).toBe(404);
    const aList = await request(server).get('/api/agents').set('Cookie', a.cookie);
    expect(JSON.stringify(aList.body)).not.toContain(bId);
    expect(
      (await request(server).get('/v1/probe').set('Authorization', `Bearer ${bKey}`)).status,
    ).toBe(200);
  });

  it('throttles the sign-in window (429 + Retry-After)', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: 'nobody@auth.test', password: 'x' });
      expect(r.status).not.toBe(429);
    }
    const limited = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: 'nobody@auth.test', password: 'x' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  }, 30_000);
});

// ─────────────────────────────────────────────────────── self-host plane
describe('self-host localhost auto-login (session-auth)', () => {
  let app: NestExpressApplication;
  let server: App;

  beforeAll(async () => {
    applyAuthEnv({ MODE: 'selfhosted', BIND_ADDRESS: '127.0.0.1' });
    app = await createAuthApp();
    server = app.getHttpServer();
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAuthState(databaseUrl);
    await clearRateLimits();
  });

  it('refuses auto-login before any admin exists', async () => {
    expect((await request(server).get('/api/probe')).status).toBe(401);
  });

  it('serves a loopback same-origin request as admin once an admin exists', async () => {
    await request(server)
      .post('/api/auth/sign-up/email')
      .send({ name: 'admin', email: uniqueEmail('admin'), password: 'password12345' });
    const res = await request(server).get('/api/probe');
    expect(res.status).toBe(200);
    expect(res.body.principal.kind).toBe('user');
  });

  it('refuses a forwarding header, a foreign Host, and a foreign Origin', async () => {
    await request(server)
      .post('/api/auth/sign-up/email')
      .send({ name: 'admin', email: uniqueEmail('admin'), password: 'password12345' });
    expect((await request(server).get('/api/probe').set('X-Forwarded-For', '9.9.9.9')).status).toBe(
      401,
    );
    expect((await request(server).get('/api/probe').set('Host', 'evil.example.com')).status).toBe(
      401,
    );
    expect(
      (await request(server).get('/api/probe').set('Origin', 'http://evil.example')).status,
    ).toBe(401);
  });
});

// ──────────────────────────────────────────── boot reconciliation
describe('boot reconciliation of crashed hooks (session-auth)', () => {
  it('heals a zero-admin state and a later user missing a default tier at next boot', async () => {
    applyAuthEnv({ MODE: 'cloud', realSecrets: true });
    await resetAuthState(databaseUrl);
    await clearRateLimits();

    // Simulate committed-but-unpromoted users (as if two post-commit hooks
    // crashed): two users, neither admin, neither with a default tier.
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    let firstId = '';
    try {
      const mk = async (email: string, createdAt: string): Promise<string> => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
           VALUES ($1, 'x', $2, true, $3, $3)`,
          [id, email, createdAt],
        );
        return id;
      };
      firstId = await mk(uniqueEmail('recon-first'), '2020-01-01T00:00:00Z');
      await mk(uniqueEmail('recon-second'), '2020-06-01T00:00:00Z');
      const admins = await pool.query(`SELECT count(*)::int n FROM "user" WHERE role='admin'`);
      expect(admins.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }

    // Boot: reconciliation runs before serving.
    const app = await createAuthApp();
    try {
      const p = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const admins = await p.query<{ id: string }>(`SELECT id FROM "user" WHERE role='admin'`);
        expect(admins.rows.length).toBe(1);
        expect(admins.rows[0]!.id).toBe(firstId); // earliest promoted
        const tiers = await p.query(
          `SELECT count(DISTINCT owner_user_id)::int n FROM tier WHERE key='default'`,
        );
        expect(tiers.rows[0].n).toBe(2); // BOTH users healed, not just the admin
      } finally {
        await p.end();
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────── dev seed
describe('dev-admin seed (session-auth)', () => {
  it('creates an admin at bootstrap and never logs the password', async () => {
    applyAuthEnv({ MODE: 'selfhosted', BIND_ADDRESS: '127.0.0.1', SEED_DATA: true });
    await resetAuthState(databaseUrl);
    await clearRateLimits();
    // Capture every log sink (console.* and the raw fds Nest's Logger uses).
    let output = '';
    const cap = (chunk: unknown): boolean => {
      output += String(chunk);
      return true;
    };
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const origLog = console.log;
    const origWarn = console.warn;
    process.stdout.write = cap;
    process.stderr.write = cap;
    console.log = (...a: unknown[]) => cap(a.join(' '));
    console.warn = (...a: unknown[]) => cap(a.join(' '));
    let app: NestExpressApplication | undefined;
    try {
      app = await createAuthApp();
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      console.log = origLog;
      console.warn = origWarn;
    }
    try {
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const admins = await pool.query(
          `SELECT count(*)::int n FROM "user" WHERE role='admin' AND email='admin@polyrouter.local'`,
        );
        expect(admins.rows[0].n).toBe(1); // the seed ran
      } finally {
        await pool.end();
      }
      // capture sanity: the dev-fallback console.warn was produced at build.
      expect(output).toContain('DEV fallback secrets');
      // the load-bearing invariant: the seed password never appears anywhere.
      expect(output).not.toContain('changeme-dev-admin');
    } finally {
      await app?.close();
    }
  }, 60_000);
});
