// add-provider-health-signals (task 7.3): the OAuth proactive-refresh sweep over the
// REAL maintenance listing, Postgres, Redis, and SubscriptionOauthService, with a stub
// identity provider. The scheduler is constructed by hand and never bootstrapped, so
// no background tick runs; each test drives `sweepOnce` directly.
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_MAINTENANCE,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  decryptSecret,
  encryptSecret,
  parseCredentialEnvelope,
  serializeOauthCredential,
  userPrincipal,
  type PersistenceMaintenance,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { Pool } from 'pg';
import { DatabaseModule } from '../../src/database/database.module';
import { DatabaseMaintenanceModule } from '../../src/database/maintenance.module';
import { RedisModule } from '../../src/redis/redis.module';
import { SubscriptionOauthModule } from '../../src/subscription-oauth/subscription-oauth.module';
import {
  OAUTH_PRESET_LOOKUP,
  OAUTH_TOKEN_FETCH,
  SubscriptionOauthService,
} from '../../src/subscription-oauth/subscription-oauth.service';
import {
  OAUTH_SWEEP_OPTIONS,
  OauthRefreshScheduler,
} from '../../src/subscription-oauth/oauth-refresh.scheduler';
import { TokenEndpointError, type TokenSet } from '../../src/subscription-oauth/oauth-client';
import type { OauthPreset } from '../../src/subscription-oauth/presets';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/providers/providers.config';
import '../../src/redis/redis.config';

const KEY = 'f'.repeat(64);
const MIN = 60_000;
const HOURS_240 = 240 * 60 * MIN;

const PRESET: OauthPreset = {
  id: 'stub-sweep',
  displayName: 'Stub Sweep',
  baseUrl: 'https://1.1.1.1/v1',
  protocol: 'anthropic_compatible',
  authorizeUrl: 'https://idp.example/authorize',
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'client-e2e',
  scopes: 'user:inference',
  redirectUri: 'https://idp.example/oauth/code/callback',
  tokenRequestEncoding: 'json',
  includeStateInExchange: true,
  enabled: true,
};

// Stub IdP, keyed by refresh token: every exchange is recorded; behavior per token.
let exchanged: string[] = [];
const revoked = new Set<string>();
const flaky = new Set<string>();

const FAST = { ...OAUTH_SWEEP_OPTIONS, jitterMaxMs: 0 };

describe('OAuth proactive-refresh sweep (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let port: PersistencePort;
  let redis: Redis;
  let scheduler: OauthRefreshScheduler;
  let alice: Principal;
  let bob: Principal;
  const users: string[] = [];
  let n = 0;

  const mkUser = async (): Promise<Principal> => {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 's', $1, false) RETURNING id`,
        [`sweep-${Date.now()}-${++n}@t.test`],
      )
    ).rows[0]!.id;
    users.push(id);
    return userPrincipal(id);
  };

  /** An OAuth provider whose refresh token is unique (the stub keys on it). */
  async function oauthRow(
    who: Principal,
    expiresInMs: number | null,
  ): Promise<{ id: string; rt: string; envelope: string }> {
    const rt = `rt-${Date.now()}-${++n}`;
    const expiresAt = Date.now() + (expiresInMs ?? HOURS_240);
    const envelope = encryptSecret(
      serializeOauthCredential({
        preset: PRESET.id,
        accessToken: `at-${rt}`,
        refreshToken: rt,
        expiresAt,
      }),
      KEY,
    );
    const p = await port.providers.insert(who, {
      name: 'sweep',
      kind: 'subscription',
      protocol: 'anthropic_compatible',
      baseUrl: PRESET.baseUrl,
      oauthPreset: PRESET.id,
      encryptedCredentials: envelope,
      credentialExpiresAt: expiresInMs === null ? null : new Date(expiresAt),
    });
    return { id: p.id, rt, envelope };
  }

  const stored = async (id: string): Promise<Record<string, unknown>> =>
    (
      await pool.query<Record<string, unknown>>(
        `SELECT owner_user_id, encrypted_credentials, credential_error, status, last_error_kind,
                status_source, credential_expires_at FROM provider WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['PROVIDER_CREDENTIAL_KEY'] = KEY;
    pool = new Pool({
      connectionString: loadConfig<{ DATABASE_URL: string }>().DATABASE_URL,
      max: 2,
    });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, DatabaseMaintenanceModule, RedisModule, SubscriptionOauthModule],
    })
      .overrideProvider(OAUTH_TOKEN_FETCH)
      .useValue((input: { body: Record<string, string> }): Promise<TokenSet> => {
        const rt = input.body['refresh_token']!;
        exchanged.push(rt);
        if (revoked.has(rt)) return Promise.reject(new TokenEndpointError('invalid_grant'));
        if (flaky.has(rt)) return Promise.reject(new TokenEndpointError('transient'));
        return Promise.resolve({
          accessToken: `at-renewed-${rt}`,
          refreshToken: `${rt}-next`,
          expiresAt: Date.now() + HOURS_240,
        });
      })
      .overrideProvider(OAUTH_PRESET_LOOKUP)
      .useValue({
        find: (id: string) => (id === PRESET.id ? PRESET : undefined),
        list: () => [PRESET],
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // migrations; no scheduler lives in this module graph
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    redis = app.get<Redis>(REDIS_CLIENT);
    scheduler = new OauthRefreshScheduler(
      redis,
      port,
      app.get<PersistenceMaintenance>(PERSISTENCE_MAINTENANCE),
      app.get(SubscriptionOauthService),
    );
    alice = await mkUser();
    bob = await mkUser();
  }, 60_000);

  beforeEach(async () => {
    exchanged = [];
    revoked.clear();
    flaky.clear();
    // Isolate from rows other suites or earlier tests left: verify everything that
    // exists, so only a test's own rows are due.
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM provider WHERE oauth_preset IS NOT NULL`,
    );
    for (const { id } of existing.rows)
      await redis.set(`oauth:verified:${id}`, '1', 'PX', 3_600_000);
    await pool.query(
      `UPDATE provider SET credential_expires_at = now() + interval '10 days'
        WHERE oauth_preset IS NOT NULL AND credential_expires_at < now() + interval '2 hours'`,
    );
    const backoff = await redis.keys('oauth:backoff:*');
    if (backoff.length > 0) await redis.del(...backoff);
  });

  afterAll(async () => {
    await scheduler.onApplicationShutdown();
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [users]);
    await app.close();
    await pool.end();
  });

  it('an idle provider near expiry is renewed with exactly one exchange, under its own owner', async () => {
    const p = await oauthRow(alice, 30 * MIN);
    await scheduler.sweepOnce(FAST);
    expect(exchanged.filter((rt) => rt === p.rt)).toHaveLength(1);
    const row = await stored(p.id);
    expect(row['encrypted_credentials']).not.toBe(p.envelope);
    const parsed = parseCredentialEnvelope(
      decryptSecret(row['encrypted_credentials'] as string, KEY),
    );
    expect(parsed.kind === 'oauth' && parsed.cred.accessToken).toBe(`at-renewed-${p.rt}`);
    expect(await redis.pttl(`oauth:verified:${p.id}`)).toBeGreaterThan(23 * 60 * MIN);
  });

  it('a revoked 240h grant becomes reauthorize_required with no request ever made', async () => {
    const p = await oauthRow(alice, HOURS_240);
    await redis.del(`oauth:verified:${p.id}`); // liveness-due
    revoked.add(p.rt);
    await scheduler.sweepOnce(FAST);
    expect(exchanged).toContain(p.rt);
    expect(await stored(p.id)).toMatchObject({
      credential_error: 'reauthorize_required',
      status: 'error',
      last_error_kind: 'credential',
      status_source: 'refresh',
    });
  });

  it('a transient failure changes nothing durable and only earns the short retry window', async () => {
    const p = await oauthRow(alice, HOURS_240);
    await redis.del(`oauth:verified:${p.id}`);
    flaky.add(p.rt);
    await scheduler.sweepOnce(FAST);
    expect(exchanged).toContain(p.rt);
    const row = await stored(p.id);
    expect(row).toMatchObject({ credential_error: null, status: 'unknown', status_source: null });
    expect(row['encrypted_credentials']).toBe(p.envelope);
    const ttl = await redis.pttl(`oauth:verified:${p.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60 * MIN); // the 1h retry — not a 24h verification
    expect(await redis.get(`oauth:backoff:${p.id}`)).toBe('1');
  });

  it('a credential changed between the sweep’s read and its lock is adopted — zero exchanges', async () => {
    const p = await oauthRow(alice, 30 * MIN);
    const replacement = encryptSecret(
      serializeOauthCredential({
        preset: PRESET.id,
        accessToken: 'at-reconnected',
        refreshToken: 'rt-reconnected',
        expiresAt: Date.now() + 30 * MIN,
      }),
      KEY,
    );
    const original = port.providers.findById.bind(port.providers);
    const spy = jest.spyOn(port.providers, 'findById').mockImplementation(async (who, id) => {
      const row = await original(who, id);
      if (id === p.id) {
        // A reconnect lands right after the sweep read the row.
        await pool.query('UPDATE provider SET encrypted_credentials = $1 WHERE id = $2', [
          replacement,
          p.id,
        ]);
      }
      return row;
    });
    try {
      const r = await scheduler.sweepOnce(FAST);
      expect(r.outcomes.adopted).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
    expect(exchanged.filter((rt) => rt === p.rt || rt === 'rt-reconnected')).toHaveLength(0);
    expect((await stored(p.id))['encrypted_credentials']).toBe(replacement);
  });

  it('near-expiry overload carries over to the next tick instead of failing', async () => {
    const rows = await Promise.all(Array.from({ length: 6 }, () => oauthRow(alice, 20 * MIN)));
    const first = await scheduler.sweepOnce({ ...FAST, tickBudgetMs: 0 }); // no time this tick
    expect(first.carriedOver).toBeGreaterThanOrEqual(6);
    expect(exchanged).toHaveLength(0);
    await scheduler.sweepOnce(FAST);
    for (const r of rows) expect(exchanged.filter((rt) => rt === r.rt)).toHaveLength(1);
  });

  it('an empty verification cache is spread across ticks by the liveness budget', async () => {
    const rows = await Promise.all(Array.from({ length: 30 }, () => oauthRow(alice, HOURS_240)));
    for (const r of rows) await redis.del(`oauth:verified:${r.id}`);
    const mine = new Set(rows.map((r) => r.rt));
    await scheduler.sweepOnce(FAST);
    expect(exchanged.filter((rt) => mine.has(rt))).toHaveLength(FAST.livenessBudget);
    await scheduler.sweepOnce(FAST);
    expect(exchanged.filter((rt) => mine.has(rt))).toHaveLength(30);
  });

  it('never calls a model API — only the token endpoint', async () => {
    // The sweep holds no adapter factory at all: its only outbound path is the
    // (stubbed) token endpoint. A near-expiry and a liveness row both go through it.
    const a = await oauthRow(alice, 10 * MIN);
    const b = await oauthRow(alice, HOURS_240);
    await redis.del(`oauth:verified:${b.id}`);
    await scheduler.sweepOnce(FAST);
    expect(exchanged).toEqual(expect.arrayContaining([a.rt, b.rt]));
  });

  it('two tenants are each refreshed under their own owner, neither observing the other', async () => {
    const pa = await oauthRow(alice, 15 * MIN);
    const pb = await oauthRow(bob, 15 * MIN);
    await scheduler.sweepOnce(FAST);
    expect(exchanged).toEqual(expect.arrayContaining([pa.rt, pb.rt]));
    const [ra, rb] = [await stored(pa.id), await stored(pb.id)];
    expect(ra['owner_user_id']).toBe((alice as { userId: string }).userId);
    expect(rb['owner_user_id']).toBe((bob as { userId: string }).userId);
    // Owner-scoped reads still hold: bob cannot see alice's provider, and vice versa.
    expect(await port.providers.findById(bob, pa.id)).toBeNull();
    expect(await port.providers.findById(alice, pb.id)).toBeNull();
  });
});
