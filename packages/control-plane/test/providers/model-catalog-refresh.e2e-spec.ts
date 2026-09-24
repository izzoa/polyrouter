// add-live-subscription-models (task 6.2): the daily model-catalog refresh over the
// REAL maintenance listing, Postgres, Redis, ProvidersService and credential
// resolution, with a stub adapter factory (records every model-API call) and a stub
// identity provider. The scheduler is constructed by hand and never bootstrapped, so
// no background tick runs; each test drives `catalogOnce` directly.
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_MAINTENANCE,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  encryptSecret,
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
import {
  MODEL_CATALOG_OPTIONS,
  ModelCatalogScheduler,
} from '../../src/providers/model-catalog.scheduler';
import { ProvidersModule } from '../../src/providers/providers.module';
import { PROVIDER_ADAPTER_FACTORY, ProvidersService } from '../../src/providers/providers.service';
import { RedisModule } from '../../src/redis/redis.module';
import { SubscriptionOauthModule } from '../../src/subscription-oauth/subscription-oauth.module';
import {
  OAUTH_PRESET_LOOKUP,
  OAUTH_TOKEN_FETCH,
} from '../../src/subscription-oauth/subscription-oauth.service';
import { TokenEndpointError, type TokenSet } from '../../src/subscription-oauth/oauth-client';
import type { OauthPreset } from '../../src/subscription-oauth/presets';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/providers/providers.config';
import '../../src/redis/redis.config';

const KEY = 'f'.repeat(64);
const MIN = 60_000;
const HOURS_240 = 240 * 60 * MIN;
const FAST = { ...MODEL_CATALOG_OPTIONS, jitterMaxMs: 0 };

const PRESET: OauthPreset = {
  id: 'stub-catalog',
  displayName: 'Stub Catalog',
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

// Every model-API call any adapter makes, by kind and by the credential it carried
// (each provider below gets a unique one, so every call is attributable).
let modelCalls: Array<{ op: 'list' | 'test' | 'chat'; credential: string }> = [];
let listing: (credential: string) => Promise<Array<{ id: string }>> = () =>
  Promise.resolve([{ id: 'm-new' }]);
let exchanged: string[] = [];
const revoked = new Set<string>();

describe('model-catalog refresh (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let port: PersistencePort;
  let redis: Redis;
  let scheduler: ModelCatalogScheduler;
  let alice: Principal;
  let bob: Principal;
  const users: string[] = [];
  let n = 0;

  const mkUser = async (): Promise<Principal> => {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'c', $1, false) RETURNING id`,
        [`catalog-${Date.now()}-${++n}@t.test`],
      )
    ).rows[0]!.id;
    users.push(id);
    return userPrincipal(id);
  };

  /** A plain-credential provider of `kind` whose key is unique to it. */
  async function keyedRow(
    who: Principal,
    kind: 'api_key' | 'custom' | 'subscription' = 'api_key',
  ): Promise<{ id: string; credential: string }> {
    const credential = `sk-${Date.now()}-${++n}`;
    const p = await port.providers.insert(who, {
      name: `catalog-${kind}`,
      kind,
      protocol: 'openai_compatible',
      baseUrl: 'https://1.1.1.1/v1',
      encryptedCredentials: encryptSecret(credential, KEY),
    });
    return { id: p.id, credential };
  }

  /** An OAuth provider whose refresh token is unique (the stub IdP keys on it). */
  async function oauthRow(
    who: Principal,
    expiresInMs: number,
  ): Promise<{ id: string; rt: string; credential: string }> {
    const rt = `rt-${Date.now()}-${++n}`;
    const expiresAt = Date.now() + expiresInMs;
    const p = await port.providers.insert(who, {
      name: 'catalog-oauth',
      kind: 'subscription',
      protocol: 'anthropic_compatible',
      baseUrl: PRESET.baseUrl,
      oauthPreset: PRESET.id,
      encryptedCredentials: encryptSecret(
        serializeOauthCredential({
          preset: PRESET.id,
          accessToken: `at-${rt}`,
          refreshToken: rt,
          expiresAt,
        }),
        KEY,
      ),
      credentialExpiresAt: new Date(expiresAt),
    });
    return { id: p.id, rt, credential: `at-${rt}` };
  }

  const stored = async (id: string): Promise<Record<string, unknown>> =>
    (
      await pool.query<Record<string, unknown>>(
        `SELECT credential_error, status, last_error_kind, status_source FROM provider WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  const modelRows = async (providerId: string): Promise<Array<Record<string, unknown>>> =>
    (
      await pool.query<Record<string, unknown>>(
        `SELECT external_model_id, unlisted_since FROM model WHERE provider_id = $1
          ORDER BY external_model_id`,
        [providerId],
      )
    ).rows;

  const callsFor = (credential: string): string[] =>
    modelCalls.filter((c) => c.credential === credential).map((c) => c.op);

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
      imports: [
        DatabaseModule,
        DatabaseMaintenanceModule,
        RedisModule,
        SubscriptionOauthModule,
        ProvidersModule,
      ],
    })
      .overrideProvider(PROVIDER_ADAPTER_FACTORY)
      .useValue((cfg: { credential: string }) => ({
        protocol: 'openai_compatible',
        chat: () => {
          modelCalls.push({ op: 'chat', credential: cfg.credential });
          return Promise.reject(new Error('no chat in a scheduled job'));
        },
        chatStream: async function* () {
          /* n/a */
        },
        testConnection: () => {
          modelCalls.push({ op: 'test', credential: cfg.credential });
          return Promise.resolve({ ok: true, models: 0 });
        },
        listModels: () => {
          modelCalls.push({ op: 'list', credential: cfg.credential });
          return listing(cfg.credential);
        },
      }))
      .overrideProvider(OAUTH_TOKEN_FETCH)
      .useValue((input: { body: Record<string, string> }): Promise<TokenSet> => {
        const rt = input.body['refresh_token']!;
        exchanged.push(rt);
        if (revoked.has(rt)) return Promise.reject(new TokenEndpointError('invalid_grant'));
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
    scheduler = new ModelCatalogScheduler(
      redis,
      app.get<PersistenceMaintenance>(PERSISTENCE_MAINTENANCE),
      app.get(ProvidersService),
    );
    alice = await mkUser();
    bob = await mkUser();
  }, 60_000);

  beforeEach(async () => {
    modelCalls = [];
    exchanged = [];
    revoked.clear();
    listing = () => Promise.resolve([{ id: 'm-new' }]);
    // Isolate from rows other suites or earlier tests left: mark everything that exists
    // fresh, so only a test's own rows are due.
    const existing = await pool.query<{ id: string }>(`SELECT id FROM provider`);
    for (const { id } of existing.rows) {
      await redis.set(`model-catalog:${id}`, '1', 'PX', 3_600_000);
    }
  });

  afterAll(async () => {
    await scheduler.onApplicationShutdown();
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [users]);
    await app.close();
    await pool.end();
  });

  it('lists EVERY kind of provider, each under its own owner, and nothing else', async () => {
    const key = await keyedRow(alice, 'api_key');
    const custom = await keyedRow(bob, 'custom');
    const pasted = await keyedRow(alice, 'subscription'); // a pasted (non-OAuth) token
    const oauth = await oauthRow(bob, HOURS_240);
    const local = await port.providers.insert(alice, {
      name: 'catalog-local',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1', // loopback: selfhosted only
    });
    // A model polyrouter synced before, which the upstream no longer lists.
    await port.models.upsertForProvider(alice, key.id, { externalModelId: 'm-old' });
    await pool.query(
      `UPDATE provider SET status='error', last_error_kind='auth', status_source='test',
         status_rev=1, health_rev=1 WHERE id=$1`,
      [key.id],
    );

    const r = await scheduler.catalogOnce(FAST);
    expect(r.refreshed).toBeGreaterThanOrEqual(5);
    // Exactly one LISTING per provider — no chat, no Test, no token exchange.
    for (const c of [key.credential, custom.credential, pasted.credential, oauth.credential]) {
      expect(callsFor(c)).toEqual(['list']);
    }
    expect(callsFor('')).toEqual(['list']); // the local provider (no credential)
    expect(modelCalls.every((c) => c.op === 'list')).toBe(true);
    expect(exchanged).toEqual([]);
    // Upserted + reconciled under each owner.
    const rows = await modelRows(key.id);
    expect(rows.map((m) => m['external_model_id'])).toEqual(['m-new', 'm-old']);
    expect(rows.find((m) => m['external_model_id'] === 'm-old')!['unlisted_since']).not.toBeNull();
    expect(rows.find((m) => m['external_model_id'] === 'm-new')!['unlisted_since']).toBeNull();
    for (const id of [custom.id, oauth.id, local.id]) {
      expect((await modelRows(id)).map((m) => m['external_model_id'])).toEqual(['m-new']);
    }
    // No health record written.
    expect(await stored(key.id)).toMatchObject({
      status: 'error',
      last_error_kind: 'auth',
      status_source: 'test',
    });
    // Fresh for ~a day: the next tick lists none of them again.
    modelCalls = [];
    await scheduler.catalogOnce(FAST);
    expect(modelCalls).toEqual([]);
    expect(await redis.pttl(`model-catalog:${key.id}`)).toBeGreaterThan(23 * 60 * MIN);
  });

  it('skips a provider that cannot list: no credential, or awaiting reconnect', async () => {
    const bare = await port.providers.insert(alice, {
      name: 'catalog-bare',
      kind: 'api_key',
      protocol: 'openai_compatible',
      baseUrl: 'https://1.1.1.1/v1',
    });
    const dead = await oauthRow(alice, HOURS_240);
    await pool.query(`UPDATE provider SET credential_error='reauthorize_required' WHERE id=$1`, [
      dead.id,
    ]);
    const r = await scheduler.catalogOnce(FAST);
    expect(r.due).toBe(0);
    expect(modelCalls).toEqual([]);
    expect(await modelRows(bare.id)).toEqual([]);
    const listed = await app
      .get<PersistenceMaintenance>(PERSISTENCE_MAINTENANCE)
      .providers.listCatalogRefreshable({ afterId: null, limit: 10_000, includeLocal: true });
    expect(listed.map((x) => x.id)).not.toEqual(expect.arrayContaining([bare.id]));
    expect(listed.map((x) => x.id)).not.toEqual(expect.arrayContaining([dead.id]));
    // Identifying fields only — never the credential.
    expect(Object.keys(listed[0] ?? { id: '', ownerUserId: '' }).sort()).toEqual([
      'id',
      'ownerUserId',
    ]);
  });

  it('a local provider is listed only where loopback is allowed (never in cloud mode)', async () => {
    const local = await port.providers.insert(alice, {
      name: 'catalog-local-2',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    const keyed = await keyedRow(alice); // a credentialed row is listed either way
    const m = app.get<PersistenceMaintenance>(PERSISTENCE_MAINTENANCE).providers;
    const all = async (includeLocal: boolean): Promise<string[]> =>
      (await m.listCatalogRefreshable({ afterId: null, limit: 10_000, includeLocal })).map(
        (r) => r.id,
      );
    expect(await all(true)).toEqual(expect.arrayContaining([local.id, keyed.id]));
    const cloud = await all(false);
    expect(cloud).toContain(keyed.id);
    expect(cloud).not.toContain(local.id);
  });

  it('a failed listing flags nothing, writes no health, and is retried after the retry window', async () => {
    const p = await keyedRow(alice);
    await port.models.upsertForProvider(alice, p.id, { externalModelId: 'm-kept' });
    listing = () => Promise.reject(new Error('upstream down'));
    const r = await scheduler.catalogOnce(FAST);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect((await modelRows(p.id))[0]!['unlisted_since']).toBeNull();
    expect(await stored(p.id)).toMatchObject({ status: 'unknown' });
    const ttl = await redis.pttl(`model-catalog:${p.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(MODEL_CATALOG_OPTIONS.retryTtlMs);
  });

  it('an empty listing never flags the catalog', async () => {
    const p = await keyedRow(alice);
    await port.models.upsertForProvider(alice, p.id, { externalModelId: 'm-kept' });
    listing = () => Promise.resolve([]);
    await scheduler.catalogOnce(FAST);
    expect((await modelRows(p.id))[0]!['unlisted_since']).toBeNull();
  });

  it('a revoked grant found while resolving the credential is still durably recorded', async () => {
    // Expiring now, so resolving the credential refreshes — and the IdP revoked it.
    const p = await oauthRow(alice, 30_000);
    revoked.add(p.rt);
    const r = await scheduler.catalogOnce(FAST);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(exchanged).toContain(p.rt);
    expect(callsFor(p.credential)).toEqual([]); // never listed
    expect(await stored(p.id)).toMatchObject({
      credential_error: 'reauthorize_required',
      status: 'error',
      last_error_kind: 'credential',
      status_source: 'refresh',
    });
  });
});
