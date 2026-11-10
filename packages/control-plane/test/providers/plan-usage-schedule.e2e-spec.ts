// add-subscription-usage-history (tasks 3.2, 4.2 and the schedule half of 5.1): the plan-usage
// schedule and the history read over the REAL Postgres, Redis, maintenance listing, providers
// service, credential resolution (the coalesced OAuth refresh) and BullMQ, with a FAKE usage reader
// (records every read; nothing is dialled), a stub identity provider and a fake adapter factory.
//
// The schedulers are constructed by hand over a maintenance listing NARROWED to this suite's own
// rows (the dev database may hold real ones, whose credentials must never be touched), on a queue
// name unique to the run (a dev stack may share this Redis).
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
import {
  PERSISTENCE_MAINTENANCE,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  decryptSecret,
  encryptSecret,
  parseCredentialEnvelope,
  serializeOauthCredential,
  serializePlainCredential,
  userPrincipal,
  type PersistenceMaintenance,
  type PersistencePort,
  type Principal,
  type ProviderInsertInput,
} from '@polyrouter/shared/server';
import type {
  PlanUsageObservation,
  PlanUsageProbe,
  PlanUsageReadResult,
  PlanUsageStore,
  ProviderConfig,
} from '@polyrouter/data-plane';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { DatabaseModule } from '../../src/database/database.module';
import { DatabaseMaintenanceModule } from '../../src/database/maintenance.module';
import { PLAN_USAGE_READER, PLAN_USAGE_STORE } from '../../src/plan-usage/plan-usage.module';
import {
  PLAN_USAGE_SCHEDULE_OPTIONS,
  PlanUsageScheduler,
} from '../../src/plan-usage/plan-usage.scheduler';
import { ProvidersModule } from '../../src/providers/providers.module';
import {
  PROVIDER_ADAPTER_FACTORY,
  ProvidersService,
  type ProviderAdapterFactory,
} from '../../src/providers/providers.service';
import { RedisModule } from '../../src/redis/redis.module';
import { TokenEndpointError, type TokenSet } from '../../src/subscription-oauth/oauth-client';
import { CHATGPT_PRESET, CLAUDE_PRESET } from '../../src/subscription-oauth/presets';
import {
  OAUTH_TOKEN_FETCH,
  SubscriptionOauthService,
} from '../../src/subscription-oauth/subscription-oauth.service';
import { KIMI_CODE_PRESET, OPENCODE_GO_PRESET } from '../../src/subscription-presets/key-presets';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/providers/providers.config';
import '../../src/redis/redis.config';

const KEY = 'e'.repeat(64);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FAST = { ...PLAN_USAGE_SCHEDULE_OPTIONS, jitterMaxMs: 0 };
const KIMI = KIMI_CODE_PRESET.regions[0]!;
const GO = OPENCODE_GO_PRESET.regions[0]!;

// ------------------------------------------------------------------ the fakes

interface ReadCall {
  readonly credential: string;
  readonly url: string;
  readonly accountId: string | undefined;
}
/** Every usage read, by the credential it carried (each row's is unique to it). */
let reads: ReadCall[] = [];
let readResult: (config: ProviderConfig, probe: PlanUsageProbe) => PlanUsageReadResult = (
  _c,
  probe,
) => ({ ok: true, observation: observationFor(probe) });
const recordingReader = (
  config: ProviderConfig,
  probe: PlanUsageProbe,
): Promise<PlanUsageReadResult> => {
  reads.push({ credential: config.credential, url: probe.url, accountId: config.oauthAccountId });
  return Promise.resolve(readResult(config, probe));
};

function observationFor(probe: PlanUsageProbe): PlanUsageObservation {
  const w = (key: string, span: '5h' | 'weekly', pct: number, inMs: number) => ({
    key,
    group: 'account' as const,
    span,
    minutes: span === '5h' ? 300 : 10_080,
    scope: null,
    usedPercent: pct,
    reset: { inMs },
  });
  return probe.parser === 'kimi_usages'
    ? { windows: [w('account:5h', '5h', 40, 2 * HOUR)], billing: null }
    : {
        windows: [w('account:5h', '5h', 20, 2 * HOUR), w('account:weekly', 'weekly', 50, 2 * DAY)],
        billing: null,
      };
}

/** Every refresh-token exchange the stub identity provider served. */
let exchanged: string[] = [];
const revoked = new Set<string>();
const tokenFetch = (input: { body: Record<string, string> }): Promise<TokenSet> => {
  const rt = input.body['refresh_token']!;
  exchanged.push(rt);
  if (revoked.has(rt)) return Promise.reject(new TokenEndpointError('invalid_grant'));
  return Promise.resolve({
    accessToken: `at-renewed-${rt}`,
    refreshToken: `${rt}-next`,
    expiresAt: Date.now() + 10 * HOUR,
  });
};

/** Every model-API call (none is expected from the schedule or the history). */
let modelCalls = 0;
const fakeFactory = (() => {
  modelCalls += 1;
  return {
    protocol: 'openai_compatible',
    chat: () => Promise.reject(new Error('n/a')),
    chatStream: async function* () {
      /* n/a */
    },
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
    listModels: () => Promise.resolve([]),
  };
}) as unknown as ProviderAdapterFactory;

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

describe('plan-usage schedule and history (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let maintenance: PersistenceMaintenance;
  let redis: Redis;
  let store: PlanUsageStore;
  let providers: ProvidersService;
  let oauth: SubscriptionOauthService;
  let alice: Principal;
  let bob: Principal;
  const users: string[] = [];
  /** This test's own provider rows: the narrowed listing returns only these. */
  const scope = new Set<string>();
  const queueName = `plan-usage-schedule-e2e-${randomUUID()}`;
  let n = 0;

  const mkUser = async (): Promise<Principal> => {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'pus', $1, false) RETURNING id`,
        [`pus-${Date.now()}-${++n}@t.test`],
      )
    ).rows[0]!.id;
    users.push(id);
    return userPrincipal(id);
  };

  /** The maintenance surface with its schedule listing narrowed to `scope`. */
  const narrowed = (): PersistenceMaintenance => ({
    ...maintenance,
    providers: {
      ...maintenance.providers,
      listPlanUsageScheduled: async ({ afterId, limit }) =>
        (await maintenance.providers.listPlanUsageScheduled({ afterId, limit: 100_000 }))
          .filter((r) => scope.has(r.id))
          .slice(0, limit),
    },
  });
  const scheduler = (): PlanUsageScheduler =>
    new PlanUsageScheduler(redis, narrowed(), providers, store, queueName);

  async function insert(who: Principal, values: ProviderInsertInput): Promise<string> {
    const id = (await port.providers.insert(who, values)).id;
    scope.add(id);
    return id;
  }
  const keyRow = async (
    who: Principal,
    over: Partial<ProviderInsertInput> = {},
  ): Promise<{ id: string; credential: string }> => {
    const credential = `kimi-${++n}-${Date.now()}`;
    const id = await insert(who, {
      name: 'pus-kimi',
      kind: 'subscription',
      protocol: KIMI.protocol,
      baseUrl: KIMI.baseUrl,
      keyPreset: KIMI_CODE_PRESET.id,
      encryptedCredentials: encryptSecret(serializePlainCredential(credential), KEY),
      ...over,
    });
    return { id, credential };
  };
  const goRow = async (who: Principal): Promise<{ id: string; credential: string }> => {
    const credential = `go-${++n}-${Date.now()}`;
    const id = await insert(who, {
      name: 'pus-go',
      kind: 'subscription',
      protocol: GO.protocol,
      baseUrl: GO.baseUrl,
      keyPreset: OPENCODE_GO_PRESET.id,
      encryptedCredentials: encryptSecret(serializePlainCredential(credential), KEY),
    });
    return { id, credential };
  };
  const oauthRow = async (
    who: Principal,
    preset: typeof CLAUDE_PRESET,
    expiresInMs: number,
    over: Partial<ProviderInsertInput> = {},
  ): Promise<{ id: string; rt: string; credential: string }> => {
    const rt = `rt-${preset.id}-${++n}-${Date.now()}`;
    const expiresAt = Date.now() + expiresInMs;
    const id = await insert(who, {
      name: `pus-${preset.id}`,
      kind: 'subscription',
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      oauthPreset: preset.id,
      encryptedCredentials: encryptSecret(
        serializeOauthCredential({
          preset: preset.id,
          accessToken: `at-${rt}`,
          refreshToken: rt,
          expiresAt,
          ...(preset.id === CHATGPT_PRESET.id ? { accountId: `acct-${n}` } : {}),
        }),
        KEY,
      ),
      credentialExpiresAt: new Date(expiresAt),
      ...over,
    });
    return { id, rt, credential: `at-${rt}` };
  };

  const readsWith = (credential: string): ReadCall[] =>
    reads.filter((r) => r.credential === credential);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond: () => boolean, ms = 20_000): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return;
      await sleep(50);
    }
    throw new Error('waitFor timed out');
  };
  const healthOf = async (id: string): Promise<Record<string, unknown>> =>
    (
      await pool.query(
        `SELECT status, last_error_kind, status_source, status_changed_at, status_rev,
                traffic_state, traffic_error_kind, traffic_at, health_rev, credential_error
           FROM provider WHERE id = $1`,
        [id],
      )
    ).rows[0] as Record<string, unknown>;
  const samplesOf = async (id: string): Promise<Array<Record<string, unknown>>> =>
    (
      await pool.query(
        `SELECT window_key, used_percent, observed_at FROM plan_usage_sample
          WHERE provider_id = $1 ORDER BY observed_at, window_key`,
        [id],
      )
    ).rows as Array<Record<string, unknown>>;
  const history = (id: string, as: Principal = alice): request.Test =>
    request(server)
      .get(`/api/providers/${id}/plan-usage/history`)
      .set('x-test-user', as.kind === 'user' ? as.userId : '');
  const refresh = (id: string, as: Principal = alice): request.Test =>
    request(server)
      .post(`/api/providers/${id}/plan-usage/refresh`)
      .set('x-test-user', as.kind === 'user' ? as.userId : '');
  const patch = (id: string, body: Record<string, unknown>): request.Test =>
    request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice.kind === 'user' ? alice.userId : '')
      .send(body);

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
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
      imports: [DatabaseModule, DatabaseMaintenanceModule, RedisModule, ProvidersModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    })
      .overrideProvider(PROVIDER_ADAPTER_FACTORY)
      .useValue(fakeFactory)
      .overrideProvider(PLAN_USAGE_READER)
      .useValue(recordingReader)
      .overrideProvider(OAUTH_TOKEN_FETCH)
      .useValue(tokenFetch)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init(); // migrations; no scheduler lives in this module graph
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    maintenance = app.get<PersistenceMaintenance>(PERSISTENCE_MAINTENANCE);
    redis = app.get<Redis>(REDIS_CLIENT);
    store = app.get<PlanUsageStore>(PLAN_USAGE_STORE);
    providers = app.get(ProvidersService);
    oauth = app.get(SubscriptionOauthService);
    alice = await mkUser();
    bob = await mkUser();
  }, 60_000);

  beforeEach(async () => {
    for (const id of scope) {
      await redis.del(`pu:${id}`, `pur:${id}`, `pug:${id}`, `plan-usage-sched:${id}`);
    }
    scope.clear();
    reads = [];
    exchanged = [];
    revoked.clear();
    modelCalls = 0;
    readResult = (_c, probe) => ({ ok: true, observation: observationFor(probe) });
  });

  afterAll(async () => {
    for (const id of scope) {
      await redis.del(`pu:${id}`, `pur:${id}`, `pug:${id}`, `plan-usage-sched:${id}`);
    }
    // The schedule's own provider rows go with their owners (samples cascade).
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [users]);
    // BullMQ never closes a connection it was handed, so this one is disconnected here.
    const conn = redis.duplicate();
    const q = new Queue(queueName, { connection: conn });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
    conn.disconnect();
    await app.close();
    await pool.end();
  });

  // ------------------------------------------------------------------ the schedule (3.2)

  describe('the usage schedule (task 3.2)', () => {
    it('three instances on one Redis run one tick once, reading each eligible provider once', async () => {
      const claude = await oauthRow(alice, CLAUDE_PRESET, 10 * HOUR);
      const chatgpt = await oauthRow(alice, CHATGPT_PRESET, 10 * HOUR);
      const kimi = await keyRow(alice);
      const bobsGo = await goRow(bob); // another owner: read under its own owner
      const off = await keyRow(alice, { checkPlanUsage: false });
      const reconnect = await oauthRow(alice, CLAUDE_PRESET, 10 * HOUR, {
        credentialError: 'reauthorize_required',
      });
      const apiKey = await insert(alice, {
        name: 'pus-api',
        kind: 'api_key',
        protocol: 'openai_compatible',
        baseUrl: 'https://api.example.test/v1',
        encryptedCredentials: encryptSecret(serializePlainCredential('sk-api'), KEY),
      });
      const pasted = await insert(alice, {
        name: 'pus-pasted',
        kind: 'subscription',
        protocol: KIMI.protocol,
        baseUrl: KIMI.baseUrl,
        encryptedCredentials: encryptSecret(serializePlainCredential('sk-pasted'), KEY),
      });
      expect(apiKey).toBeDefined();
      expect(pasted).toBeDefined();

      const instances = [scheduler(), scheduler(), scheduler()];
      const ticks = instances.map((s) => jest.spyOn(s, 'usageOnce'));
      try {
        for (const s of instances) s.onApplicationBootstrap();
        // A repeatable job with `every` runs its first occurrence at once.
        await waitFor(() => reads.length >= 4);
        await sleep(2_500); // room for a second occurrence, were there one
        expect(ticks.reduce((sum, t) => sum + t.mock.calls.length, 0)).toBe(1);
        for (const credential of [claude.credential, chatgpt.credential, kimi.credential]) {
          expect(readsWith(credential)).toHaveLength(1);
        }
        expect(readsWith(bobsGo.credential)).toHaveLength(1);
        expect(reads).toHaveLength(4); // nothing for the switched-off, reconnect, API-key or pasted rows
        expect(readsWith(off.credential)).toHaveLength(0);
        expect(readsWith(reconnect.credential)).toHaveLength(0);
        // Each read hit its preset's own endpoint; ChatGPT's carried the row's account id.
        expect(readsWith(claude.credential)[0]!.url).toBe(CLAUDE_PRESET.usageProbe!.url);
        expect(readsWith(chatgpt.credential)[0]).toMatchObject({
          url: CHATGPT_PRESET.usageProbe!.url,
          accountId: expect.stringMatching(/^acct-/),
        });
        // An idle ChatGPT provider now has readings with source `refresh`.
        const view = await request(server)
          .get(`/api/providers/${chatgpt.id}`)
          .set('x-test-user', alice.kind === 'user' ? alice.userId : '');
        expect(view.body.planUsage.windows.map((w: { source: string }) => w.source)).toEqual([
          'refresh',
          'refresh',
        ]);
        // The tick sampled what it read: one row per window at the observation instant.
        expect((await samplesOf(chatgpt.id)).map((s) => s['window_key'])).toEqual([
          'account:5h',
          'account:weekly',
        ]);

        // A click within the cooldown after the tick is refused, and sends nothing.
        const click = await refresh(kimi.id);
        expect(click.status).toBe(429);
        expect(Number(click.headers['retry-after'])).toBeGreaterThan(0);
        expect(readsWith(kimi.credential)).toHaveLength(1);
      } finally {
        for (const s of instances) await s.onApplicationShutdown();
      }
    }, 60_000);

    it('an expired OAuth token is refreshed once through the shared path, and the read uses the new token', async () => {
      const claude = await oauthRow(alice, CLAUDE_PRESET, -MIN); // already expired
      const s = scheduler();
      try {
        const r = await s.usageOnce(FAST);
        expect(r.read).toBe(1);
        expect(exchanged.filter((rt) => rt === claude.rt)).toHaveLength(1);
        expect(reads).toEqual([
          {
            credential: `at-renewed-${claude.rt}`,
            url: CLAUDE_PRESET.usageProbe!.url,
            accountId: undefined,
          },
        ]);
        // The refreshed envelope was persisted through the shared path.
        const stored = await pool.query<{ encrypted_credentials: string }>(
          'SELECT encrypted_credentials FROM provider WHERE id = $1',
          [claude.id],
        );
        const env = parseCredentialEnvelope(
          decryptSecret(stored.rows[0]!.encrypted_credentials, KEY),
        );
        expect(env.kind === 'oauth' && env.cred.accessToken).toBe(`at-renewed-${claude.rt}`);
        // The next tick finds it fresh: no read, no exchange.
        await s.usageOnce(FAST);
        expect(reads).toHaveLength(1);
        expect(exchanged).toHaveLength(1);
      } finally {
        await s.onApplicationShutdown();
      }
    });

    it('a refresh that fails as reauthorize_required stops further scheduled reads', async () => {
      const claude = await oauthRow(alice, CLAUDE_PRESET, -MIN);
      revoked.add(claude.rt);
      const s = scheduler();
      try {
        await s.usageOnce(FAST);
        expect(exchanged).toEqual([claude.rt]);
        expect(reads).toHaveLength(0);
        expect((await healthOf(claude.id))['credential_error']).toBe('reauthorize_required');
        // Later ticks (freshness and cooldown long gone) neither exchange nor read.
        await redis.del(`plan-usage-sched:${claude.id}`, `pur:${claude.id}`);
        await s.usageOnce(FAST);
        expect(exchanged).toHaveLength(1);
        expect(reads).toHaveLength(0);
      } finally {
        await s.onApplicationShutdown();
      }
    });

    it('a failing read changes no snapshot and no health, and the tick goes on', async () => {
      const bad = await keyRow(alice);
      const good = await keyRow(alice);
      readResult = (config, probe) =>
        config.credential === bad.credential
          ? {
              ok: false,
              kind: 'auth',
              message: 'The provider rejected the credential for its usage endpoint.',
            }
          : { ok: true, observation: observationFor(probe) };
      const healthBefore = await healthOf(bad.id);
      const s = scheduler();
      try {
        const r = await s.usageOnce(FAST);
        expect(r).toMatchObject({ read: 1, failed: 1 });
      } finally {
        await s.onApplicationShutdown();
      }
      expect(await redis.exists(`pu:${bad.id}`)).toBe(0);
      expect(await healthOf(bad.id)).toEqual(healthBefore);
      expect(await redis.exists(`cb:${bad.id}`, `pcd:${bad.id}`)).toBe(0);
      expect(await redis.exists(`pu:${good.id}`)).toBe(1);
      expect(modelCalls).toBe(0);
    });

    it('the switch off stops scheduled reads but keeps Refresh usage; back on resumes at the next tick', async () => {
      const kimi = await keyRow(alice);
      expect((await patch(kimi.id, { checkPlanUsage: false })).status).toBe(200);
      const s = scheduler();
      try {
        await s.usageOnce(FAST);
        expect(reads).toHaveLength(0);
        expect(await samplesOf(kimi.id)).toEqual([]);
        // Refresh usage still reads on a click.
        const click = await refresh(kimi.id);
        expect(click.status).toBe(200);
        expect(click.body.ok).toBe(true);
        expect(reads).toHaveLength(1);
        // History stops growing while the switch is off, even with a snapshot to sample.
        await s.usageOnce(FAST);
        expect(await samplesOf(kimi.id)).toEqual([]);
        // Back on: the next tick reads (once the click's cooldown has passed).
        expect((await patch(kimi.id, { checkPlanUsage: true })).status).toBe(200);
        await redis.del(`pur:${kimi.id}`);
        await s.usageOnce(FAST);
        expect(reads).toHaveLength(2);
        expect((await samplesOf(kimi.id)).length).toBeGreaterThan(0);
      } finally {
        await s.onApplicationShutdown();
      }
    });

    it('the OAuth sweep and the catalog refresh call no usage endpoint', async () => {
      const claude = await oauthRow(alice, CLAUDE_PRESET, 2 * MIN); // near expiry
      const kimi = await keyRow(alice);
      const envelope = (
        await pool.query<{ encrypted_credentials: string }>(
          'SELECT encrypted_credentials FROM provider WHERE id = $1',
          [claude.id],
        )
      ).rows[0]!.encrypted_credentials;
      // The sweep's per-row work, and the catalog refresh's.
      await expect(oauth.forceRefresh(alice, claude.id, envelope, 'scheduled')).resolves.toBe(
        'refreshed',
      );
      await providers.refreshCatalog(alice, kimi.id);
      await providers.refreshCatalog(alice, claude.id);
      expect(reads).toHaveLength(0);
      expect(await redis.exists(`pur:${claude.id}`, `pur:${kimi.id}`)).toBe(0);
    });
  });

  // ------------------------------------------------------------------ the history (4.2)

  describe('the history read (task 4.2)', () => {
    it('returns each window over its own span, oldest first, with an unknown percent kept as null', async () => {
      const chatgpt = await oauthRow(alice, CHATGPT_PRESET, 10 * HOUR);
      // The current snapshot: a 5-hour window resetting in 2 hours, a weekly one in 2 days.
      await store.merge(chatgpt.id, observationFor(CHATGPT_PRESET.usageProbe!), 0, 'refresh');
      const snap = (await store.readMany([chatgpt.id])).get(chatgpt.id)!.snapshot!;
      const weeklyReset = snap.windows.find((w) => w.key === 'account:weekly')!.resetMs!;
      const fiveReset = snap.windows.find((w) => w.key === 'account:5h')!.resetMs!;
      // Samples every 15 minutes over the last 6 days (the weekly span is the last 5 days).
      const now = Date.now();
      const samples = [];
      for (let t = now - 6 * DAY; t <= now - 15 * MIN; t += 15 * MIN) {
        samples.push({
          providerId: chatgpt.id,
          windowKey: 'account:weekly',
          usedPercent: 10,
          resetAt: new Date(weeklyReset),
          observedAt: new Date(t),
        });
      }
      samples.push(
        {
          providerId: chatgpt.id,
          windowKey: 'account:5h',
          usedPercent: null, // unknown
          resetAt: new Date(fiveReset),
          observedAt: new Date(now - 30 * MIN),
        },
        {
          providerId: chatgpt.id,
          windowKey: 'account:5h',
          usedPercent: 15,
          resetAt: new Date(fiveReset),
          observedAt: new Date(now - 2 * HOUR),
        },
        {
          providerId: chatgpt.id,
          windowKey: 'account:5h',
          usedPercent: 90, // the previous 5-hour window
          resetAt: null,
          observedAt: new Date(now - 4 * HOUR),
        },
      );
      await maintenance.planUsageSamples.insertPlanUsageSamples(samples);

      const res = await history(chatgpt.id);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as {
        windows: Array<{
          key: string;
          label: string;
          span: string;
          from: string;
          resetAt: string;
          samples: Array<{ at: string; usedPercent: number | null }>;
        }>;
      };
      expect(body.windows.map((w) => [w.key, w.label, w.span])).toEqual([
        ['account:5h', '5h', '5h'],
        ['account:weekly', 'weekly', 'weekly'],
      ]);
      const [five, weekly] = body.windows;
      expect(five!.from).toBe(new Date(fiveReset - 5 * HOUR).toISOString());
      expect(five!.samples.map((s) => s.usedPercent)).toEqual([15, null]);
      expect(weekly!.from).toBe(new Date(weeklyReset - 7 * DAY).toISOString());
      expect(weekly!.resetAt).toBe(new Date(weeklyReset).toISOString());
      // About 5 days of 15-minute samples, oldest first, none before the span.
      const ats = weekly!.samples.map((s) => Date.parse(s.at));
      expect(ats).toEqual([...ats].sort((a, b) => a - b));
      expect(ats[0]!).toBeGreaterThanOrEqual(weeklyReset - 7 * DAY);
      expect(weekly!.samples.length).toBeGreaterThan(4 * 96);
      expect(weekly!.samples.length).toBeLessThanOrEqual(5 * 96 + 1);
      // Numbers and instants only.
      expect(JSON.stringify(body)).not.toMatch(/acct-|at-rt|credential|email/);
    });

    it('another tenant reads a 404 and none of the samples', async () => {
      const kimi = await keyRow(alice);
      await maintenance.planUsageSamples.insertPlanUsageSamples([
        {
          providerId: kimi.id,
          windowKey: 'account:5h',
          usedPercent: 33,
          resetAt: null,
          observedAt: new Date(Date.now() - MIN),
        },
      ]);
      expect((await history(kimi.id)).body.windows).toHaveLength(1);
      const res = await history(kimi.id, bob);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/samples|usedPercent|account:5h/);
    });

    it('reading history calls nothing upstream and claims no cooldown, however often', async () => {
      const claude = await oauthRow(alice, CLAUDE_PRESET, -MIN); // expired: a read would refresh
      for (let i = 0; i < 3; i += 1) expect((await history(claude.id)).status).toBe(200);
      expect(reads).toHaveLength(0);
      expect(exchanged).toHaveLength(0);
      expect(modelCalls).toBe(0);
      expect(await redis.exists(`pur:${claude.id}`)).toBe(0);
    });

    it('an empty list without samples, for a preset row and an API-key row alike', async () => {
      const kimi = await keyRow(alice);
      await store.merge(kimi.id, observationFor(KIMI.usageProbe!), 0, 'refresh');
      const apiKey = await insert(alice, {
        name: 'pus-api',
        kind: 'api_key',
        protocol: 'openai_compatible',
        baseUrl: 'https://api.example.test/v1',
      });
      expect((await history(kimi.id)).body).toEqual({ windows: [] });
      expect((await history(apiKey)).body).toEqual({ windows: [] });
      expect((await history(randomUUID())).status).toBe(404);
    });
  });
});
