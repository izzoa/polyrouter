import { loadConfig } from '@polyrouter/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminModule } from '../../src/admin/admin.module';
import { AccountModule } from '../../src/account/account.module';
import {
  applyAuthEnv,
  clearRateLimits,
  createAuthApp,
  resetAuthState,
  setRegistrationMode,
  uniqueEmail,
} from './auth-harness';

/** user-administration e2e: registration gating, the invite lifecycle, admin
 * user management with the last-enabled-admin guard, and cross-plane disable
 * enforcement — against the real Better Auth stack + Postgres + Redis. */

jest.setTimeout(60_000);

const PASSWORD = 'password12345';

/** Invite links carry the raw token in the URL FRAGMENT (`#token=…`), which
 * browsers never send to the server — parse it the way the SPA does. */
const tokenFromLink = (link: string): string | null =>
  new URLSearchParams(new URL(link).hash.replace(/^#/, '')).get('token');

describe('user administration (user-administration)', () => {
  let app: NestExpressApplication;
  let server: App;
  let databaseUrl: string;

  const signUp = async (
    email: string,
  ): Promise<{ status: number; cookie: string[] }> => {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send({ name: 'u', email, password: PASSWORD });
    const setCookie = res.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    return { status: res.status, cookie };
  };

  const signIn = async (email: string): Promise<{ status: number; cookie: string[] }> => {
    const res = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email, password: PASSWORD });
    const setCookie = res.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    return { status: res.status, cookie };
  };

  const userIdByEmail = async (email: string): Promise<string> => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const r = await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email=$1`, [email]);
      const id = r.rows[0]?.id;
      if (!id) throw new Error(`no user for ${email}`);
      return id;
    } finally {
      await pool.end();
    }
  };

  beforeAll(() => {
    applyAuthEnv({ MODE: 'cloud', realSecrets: true });
    databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
  });

  beforeEach(async () => {
    await resetAuthState(databaseUrl);
    await clearRateLimits();
    app = await createAuthApp([AdminModule, AccountModule]);
    server = app.getHttpServer() as App;
  });

  afterEach(async () => {
    await app.close();
  });

  it('closes to invite_only: public signup refused post-bootstrap; admin can reopen', async () => {
    const admin = await signUp(uniqueEmail('admin'));
    expect(admin.status).toBe(200);
    await setRegistrationMode(databaseUrl, 'invite_only');

    const refused = await signUp(uniqueEmail('stranger'));
    expect(refused.status).toBe(403);

    // Admin reopens from the API; the change takes effect with no restart.
    const reopen = await request(server)
      .put('/api/admin/settings/registration')
      .set('Cookie', admin.cookie)
      .send({ mode: 'open' });
    expect(reopen.status).toBe(200);
    const allowed = await signUp(uniqueEmail('walkin'));
    expect(allowed.status).toBe(200);

    // login-config reflects the mode for the login gate.
    await setRegistrationMode(databaseUrl, 'invite_only');
    const cfg = await request(server).get('/api/login-config');
    expect(cfg.body).toMatchObject({ registration: 'invite_only' });
  });

  it('invite lifecycle: issue → accept lands signed in; single-use; uniform errors', async () => {
    const admin = await signUp(uniqueEmail('admin'));
    await setRegistrationMode(databaseUrl, 'invite_only');
    const inviteeEmail = uniqueEmail('invitee');

    const issued = await request(server)
      .post('/api/admin/invites')
      .set('Cookie', admin.cookie)
      .send({ email: inviteeEmail });
    expect(issued.status).toBe(201);
    expect(issued.body.emailSent).toBe(false); // SMTP unconfigured in tests
    const link: string = issued.body.link;
    // The raw token rides in the fragment — never in the query string.
    expect(link).toContain('/accept-invite#token=');
    expect(issued.headers['cache-control']).toContain('no-store');
    const token = tokenFromLink(link);
    expect(token).toBeTruthy();
    // The stored row holds only prefix + hash — never the raw token.
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const inv = await pool.query<{ token_prefix: string; token_hash: string }>(
        `SELECT token_prefix, token_hash FROM invite WHERE email=$1`,
        [inviteeEmail.toLowerCase()],
      );
      expect(inv.rows[0]?.token_prefix).toBe((token as string).slice(0, 12));
      expect(inv.rows[0]?.token_hash).not.toContain(token as string);
    } finally {
      await pool.end();
    }

    const accept = await request(server)
      .post('/api/invites/accept')
      .send({ token, name: 'Invited User', password: PASSWORD });
    expect(accept.status).toBe(201);
    expect(accept.headers['cache-control']).toContain('no-store');
    const setCookie = accept.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookie.length).toBeGreaterThan(0); // lands signed in
    const me = await request(server).get('/api/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(inviteeEmail.toLowerCase());
    expect(me.body.role).toBeNull(); // invited users are never admins

    // Single-use + uniform errors: replay and junk read identically.
    const replay = await request(server)
      .post('/api/invites/accept')
      .send({ token, name: 'x', password: PASSWORD });
    const junk = await request(server)
      .post('/api/invites/accept')
      .send({ token: 'A'.repeat(32), name: 'x', password: PASSWORD });
    expect(replay.status).toBe(400);
    expect(junk.status).toBe(400);
    expect(replay.body.message).toBe(junk.body.message);
  });

  it('expired invites are refused with the same uniform error', async () => {
    const admin = await signUp(uniqueEmail('admin'));
    const email = uniqueEmail('late');
    const issued = await request(server)
      .post('/api/admin/invites')
      .set('Cookie', admin.cookie)
      .send({ email });
    const token = tokenFromLink(issued.body.link as string);
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await pool.query(`UPDATE invite SET expires_at = now() - interval '1 hour' WHERE email=$1`, [
        email.toLowerCase(),
      ]);
    } finally {
      await pool.end();
    }
    const res = await request(server)
      .post('/api/invites/accept')
      .send({ token, name: 'x', password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('invalid or expired invite');
  });

  it('concurrent double-accept consumes the invite exactly once', async () => {
    const admin = await signUp(uniqueEmail('admin'));
    const email = uniqueEmail('race');
    const issued = await request(server)
      .post('/api/admin/invites')
      .set('Cookie', admin.cookie)
      .send({ email });
    const token = tokenFromLink(issued.body.link as string);
    const [a, b] = await Promise.all([
      request(server).post('/api/invites/accept').send({ token, name: 'a', password: PASSWORD }),
      request(server).post('/api/invites/accept').send({ token, name: 'b', password: PASSWORD }),
    ]);
    const ok = [a, b].filter((r) => r.status === 201).length;
    expect(ok).toBe(1);
  });

  it('admin endpoints are denied to non-admins; the user list is whitelisted records only', async () => {
    const admin = await signUp(uniqueEmail('admin'));
    const user = await signUp(uniqueEmail('plain'));

    for (const [method, path] of [
      ['get', '/api/admin/users'],
      ['get', '/api/admin/invites'],
      ['get', '/api/admin/settings/registration'],
    ] as const) {
      const res = await request(server)[method](path).set('Cookie', user.cookie);
      expect(res.status).toBe(403);
    }
    const mutate = await request(server)
      .patch('/api/admin/users/whatever/role')
      .set('Cookie', user.cookie)
      .send({ role: 'admin' });
    expect(mutate.status).toBe(403);

    // The admin list is records-only: identity fields, never credential
    // material or tenant resources (invariant 5 + whitelisted DTOs).
    const list = await request(server).get('/api/admin/users').set('Cookie', admin.cookie);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(2);
    for (const row of list.body as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(
        ['createdAt', 'disabled', 'email', 'id', 'name', 'role'].sort(),
      );
    }
  });

  it('last enabled admin cannot be demoted, disabled, or deleted', async () => {
    const admin = await signUp(uniqueEmail('admin'));
    const adminId = await userIdByEmail(
      (await request(server).get('/api/me').set('Cookie', admin.cookie)).body.email as string,
    );

    // Lazy thunks: supertest tears down its ephemeral listener per awaited
    // request, so eagerly-built requests would hit a closed port.
    for (const attempt of [
      () =>
        request(server)
          .patch(`/api/admin/users/${adminId}/role`)
          .set('Cookie', admin.cookie)
          .send({ role: null }),
      () =>
        request(server)
          .patch(`/api/admin/users/${adminId}/disabled`)
          .set('Cookie', admin.cookie)
          .send({ disabled: true }),
      () => request(server).delete(`/api/admin/users/${adminId}`).set('Cookie', admin.cookie),
    ]) {
      const res = await attempt();
      expect(res.status).toBe(409);
    }

    // Promote a second enabled admin → demoting the first now succeeds.
    const second = await signUp(uniqueEmail('second'));
    const secondId = await userIdByEmail(
      (await request(server).get('/api/me').set('Cookie', second.cookie)).body.email as string,
    );
    const promote = await request(server)
      .patch(`/api/admin/users/${secondId}/role`)
      .set('Cookie', admin.cookie)
      .send({ role: 'admin' });
    expect(promote.status).toBe(200);
    const demote = await request(server)
      .patch(`/api/admin/users/${adminId}/role`)
      .set('Cookie', admin.cookie)
      .send({ role: null });
    expect(demote.status).toBe(200);
  });

  it('disable hits both planes and sign-in; re-enable does not resurrect sessions', async () => {
    const admin = await signUp(uniqueEmail('admin'));
    const bEmail = uniqueEmail('bob');
    const bob = await signUp(bEmail);
    const bobId = await userIdByEmail(bEmail.toLowerCase());

    // Bob mints an agent key (his /v1 credential).
    const agent = await request(server)
      .post('/api/agents')
      .set('Cookie', bob.cookie)
      .send({ name: 'bots', harness: 'curl' });
    expect(agent.status).toBe(201);
    const key: string = agent.body.key;
    const v1Before = await request(server).get('/v1/probe').set('Authorization', `Bearer ${key}`);
    expect(v1Before.status).toBe(200);

    // Admin disables Bob → session plane, agent plane, and sign-in all close.
    const disable = await request(server)
      .patch(`/api/admin/users/${bobId}/disabled`)
      .set('Cookie', admin.cookie)
      .send({ disabled: true });
    expect(disable.status).toBe(200);

    expect((await request(server).get('/api/me').set('Cookie', bob.cookie)).status).toBe(401);
    expect(
      (await request(server).get('/v1/probe').set('Authorization', `Bearer ${key}`)).status,
    ).toBe(401);
    expect((await signIn(bEmail)).status).toBeGreaterThanOrEqual(400);

    // Re-enable: sign-in works again, but the OLD session stays dead (rows deleted).
    const enable = await request(server)
      .patch(`/api/admin/users/${bobId}/disabled`)
      .set('Cookie', admin.cookie)
      .send({ disabled: false });
    expect(enable.status).toBe(200);
    expect((await request(server).get('/api/me').set('Cookie', bob.cookie)).status).toBe(401);
    const fresh = await signIn(bEmail);
    expect(fresh.status).toBe(200);
    expect((await request(server).get('/api/me').set('Cookie', fresh.cookie)).status).toBe(200);
    expect(
      (await request(server).get('/v1/probe').set('Authorization', `Bearer ${key}`)).status,
    ).toBe(200);
  });

  it('deleting a user cascades their tenant', async () => {
    const admin = await signUp(uniqueEmail('admin'));
    const cEmail = uniqueEmail('carol');
    const carol = await signUp(cEmail);
    const carolId = await userIdByEmail(cEmail.toLowerCase());
    await request(server)
      .post('/api/agents')
      .set('Cookie', carol.cookie)
      .send({ name: 'doomed', harness: 'curl' });

    const del = await request(server)
      .delete(`/api/admin/users/${carolId}`)
      .set('Cookie', admin.cookie);
    expect(del.status).toBe(200);

    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const u = await pool.query(`SELECT count(*)::int n FROM "user" WHERE id=$1`, [carolId]);
      const a = await pool.query(`SELECT count(*)::int n FROM agent WHERE owner_user_id=$1`, [
        carolId,
      ]);
      const t = await pool.query(`SELECT count(*)::int n FROM tier WHERE owner_user_id=$1`, [
        carolId,
      ]);
      expect(u.rows[0].n).toBe(0);
      expect(a.rows[0].n).toBe(0);
      expect(t.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
