import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import { decryptSecret, userPrincipal, type Principal } from '@polyrouter/shared/server';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { NotificationsModule } from '../../src/notifications/notifications.module';
import { ChannelsService, type SafeChannel } from '../../src/notifications/channels.service';
import { NotificationService } from '../../src/notifications/notification.service';
import { NotifyQueue, withDeadline } from '../../src/notifications/notify.queue';
import { resolveNotifyRuntime } from '../../src/notifications/notify.config';
import type { NotificationEvent } from '../../src/notifications/notification.types';
import { startAppriseStub, startSmtpStub, waitFor, type AppriseStub, type SmtpStub } from './stubs';

const SENTINEL = 'S3NT1NEL-smtp-pass-do-not-leak';
const APPRISE_TOKEN = 'T0KEN-webhook-secret';
const NOTIFY_SECRET = 'b'.repeat(64);
const COMPOSE_HINT =
  'Dev Postgres/Redis unreachable — start them with: docker compose -f docker-compose.dev.yml up -d';

/** Snapshot + set the env keys the notify runtime reads, so nothing leaks to
 * other e2e files under --runInBand. */
function saveEnv(keys: string[]): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  return prev;
}
function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = [
  'MODE',
  'APPRISE_API_URL',
  'NOTIFY_CREDENTIALS_SECRET',
  'NOTIFY_APPRISE_EGRESS_CONFIRMED',
  'NOTIFY_ALLOWED_ENDPOINTS',
];

async function makeUser(
  pool: Pool,
  label: string,
): Promise<{ principal: Principal; userId: string }> {
  const userId = randomUUID();
  await pool.query(
    'INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, false)',
    [userId, label, `${label}-${userId}@notify.test`],
  );
  return { principal: userPrincipal(userId), userId };
}

describe('notification channels — delivery core (#15a)', () => {
  let app: INestApplication;
  let svc: ChannelsService;
  let notifications: NotificationService;
  let pool: Pool;
  let inspect: Queue;
  let inspectConn: Redis;
  let smtpAccept: SmtpStub;
  let smtpReject: SmtpStub;
  let apprise: AppriseStub;
  let envPrev: Record<string, string | undefined>;
  const capturedLogs: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    // Spy on every Logger level → silence + capture for the secret canary.
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => capturedLogs.push(JSON.stringify(args)));
    }

    smtpAccept = await startSmtpStub();
    smtpReject = await startSmtpStub({ rejectRcpt: true });
    apprise = await startAppriseStub();

    envPrev = saveEnv(ENV_KEYS);
    process.env.MODE = 'selfhosted';
    process.env.APPRISE_API_URL = apprise.url; // loopback sidecar → allowed in self-host
    process.env.NOTIFY_CREDENTIALS_SECRET = NOTIFY_SECRET;
    delete process.env.NOTIFY_APPRISE_EGRESS_CONFIRMED;
    delete process.env.NOTIFY_ALLOWED_ENDPOINTS;

    const databaseUrl = loadConfig<{ DATABASE_URL: string; REDIS_URL: string }>().DATABASE_URL;
    const redisUrl = loadConfig<{ REDIS_URL: string }>().REDIS_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      await pool.end();
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    inspectConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    inspect = new Queue('notify', { connection: inspectConn });
    // Clear stale jobs from prior runs BEFORE the worker exists, so it doesn't
    // flood the DB replaying hundreds of dead deliveries (which starves the pool).
    await inspect.obliterate({ force: true });

    const moduleRef = await Test.createTestingModule({ imports: [NotificationsModule] }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init(); // runs migrations + resolves NOTIFY_RUNTIME (SSRF-gated)
    svc = app.get(ChannelsService);
    notifications = app.get(NotificationService);

    // Gate on producer+worker readiness, then warm up end-to-end so the first
    // real emit test doesn't race startup (a 'test' event has no dedup window).
    await app.get(NotifyQueue).whenReady();
    const warm = await makeUser(pool, 'warmup');
    userIds.push(warm.userId);
    await svc.create(warm.principal, {
      name: 'warmup',
      kind: 'apprise',
      eventsSubscribed: ['test'],
      config: { urls: ['discord://warm/warm'] },
    });
    const wBefore = apprise.requests.length;
    await notifications.emit({ type: 'test', scope: { ownerUserId: warm.userId }, fields: {} });
    const warmed = await waitFor(() => apprise.requests.length > wBefore, { timeoutMs: 15_000 });
    if (!warmed) throw new Error('notify worker did not deliver warmup event within 15s');
  }, 90_000);

  afterAll(async () => {
    // Drain the queue THEN stop the worker, so no in-flight/delayed delivery
    // survives teardown (a straggler would "import after teardown" and corrupt
    // the next suite).
    await inspect?.obliterate({ force: true }).catch(() => {});
    await app?.close();
    if (userIds.length > 0) {
      await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [userIds]);
    }
    await inspect?.close().catch(() => {});
    inspectConn?.disconnect();
    await pool?.end();
    await smtpAccept?.close();
    await smtpReject?.close();
    await apprise?.close();
    restoreEnv(envPrev);
    jest.restoreAllMocks();
  });

  async function newUser(label: string): Promise<Principal> {
    const { principal, userId } = await makeUser(pool, label);
    userIds.push(userId);
    return principal;
  }

  const smtpConfig = (port: number, extra: Record<string, unknown> = {}) => ({
    host: '127.0.0.1',
    port,
    secure: 'none' as const,
    from: 'alerts@polyrouter.test',
    to: ['ops@polyrouter.test'],
    ...extra,
  });

  async function encryptedConfigOf(id: string): Promise<string> {
    const r = await pool.query('SELECT encrypted_config FROM notification_channel WHERE id = $1', [
      id,
    ]);
    return r.rows[0].encrypted_config as string;
  }
  async function lastTestStatusOf(id: string): Promise<string | null> {
    const r = await pool.query('SELECT last_test_status FROM notification_channel WHERE id = $1', [
      id,
    ]);
    return r.rows[0].last_test_status as string | null;
  }

  it('stores channel config encrypted at rest (never plaintext) and round-trips under the key', async () => {
    const principal = await newUser('enc');
    const ch = await svc.create(principal, {
      name: 'ops smtp',
      kind: 'smtp',
      eventsSubscribed: ['test'],
      config: smtpConfig(smtpAccept.port, { user: 'mailer', pass: SENTINEL }),
    });
    const stored = await encryptedConfigOf(ch.id);
    expect(stored).not.toContain(SENTINEL); // ciphertext at rest
    expect(stored).not.toContain('mailer');
    expect(decryptSecret(stored, NOTIFY_SECRET)).toContain(SENTINEL); // decrypts under the key
    expect(JSON.stringify(ch)).not.toContain(SENTINEL); // safe view hides it
  });

  it('test-send to a reachable SMTP + Apprise stub succeeds and records last_test_status=success', async () => {
    const principal = await newUser('ok');
    const smtp = await svc.create(principal, {
      name: 'smtp ok',
      kind: 'smtp',
      eventsSubscribed: ['test'],
      config: smtpConfig(smtpAccept.port),
    });
    const before = smtpAccept.messages.length;
    const smtpRes = await svc.testSend(principal, smtp.id);
    expect(smtpRes.ok).toBe(true);
    expect(await lastTestStatusOf(smtp.id)).toBe('success');
    expect(smtpAccept.messages.length).toBe(before + 1);

    const appriseCh = await svc.create(principal, {
      name: 'apprise ok',
      kind: 'apprise',
      eventsSubscribed: ['provider_down'],
      config: { urls: [`discord://webhook_id/${APPRISE_TOKEN}`] },
    });
    const beforeA = apprise.requests.length;
    const appriseRes = await svc.testSend(principal, appriseCh.id);
    expect(appriseRes.ok).toBe(true);
    expect(await lastTestStatusOf(appriseCh.id)).toBe('success');
    expect(apprise.requests.length).toBe(beforeA + 1);
  });

  it('test-send to a refusing target records a sanitized failed:<code>', async () => {
    const principal = await newUser('dead');
    const ch = await svc.create(principal, {
      name: 'smtp dead',
      kind: 'smtp',
      eventsSubscribed: ['test'],
      config: smtpConfig(smtpReject.port, { user: 'u', pass: SENTINEL }),
    });
    const res = await svc.testSend(principal, ch.id);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('smtp_send_failed');
    const status = await lastTestStatusOf(ch.id);
    expect(status).toBe('failed:smtp_send_failed');
    expect(status).not.toContain(SENTINEL); // sanitized
  });

  it('rejects a metadata target (422) even in self-host mode', async () => {
    const principal = await newUser('meta');
    await expect(
      svc.create(principal, {
        name: 'metadata smtp',
        kind: 'smtp',
        eventsSubscribed: ['test'],
        config: smtpConfig(587, { host: '169.254.169.254' }),
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      svc.create(principal, {
        name: 'metadata apprise',
        kind: 'apprise',
        eventsSubscribed: ['provider_down'],
        config: { urls: ['ntfy://169.254.169.254/topic'] },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('deduplicates repeated emits for one scope+window to at most one delivery', async () => {
    const principal = await newUser('dedup');
    const ownerUserId = (principal as { userId: string }).userId;
    await svc.create(principal, {
      name: 'apprise dedup',
      kind: 'apprise',
      eventsSubscribed: ['provider_down'],
      config: { urls: [`discord://id/${APPRISE_TOKEN}`] },
    });
    const lifecycleId = randomUUID(); // fresh incident → not suppressed by an earlier window
    const event: NotificationEvent = {
      type: 'provider_down',
      scope: { ownerUserId, providerId: 'prov-1', lifecycleId },
      fields: { providerName: 'OpenAI' },
    };
    const before = apprise.requests.length;
    await notifications.emit(event);
    await notifications.emit(event); // duplicate within window → dropped
    const delivered = await waitFor(() => apprise.requests.length === before + 1);
    expect(delivered).toBe(true);
    // Give a spurious second delivery a chance to (not) arrive.
    await new Promise((r) => setTimeout(r, 500));
    expect(apprise.requests.length).toBe(before + 1);
  }, 20_000);

  it('isolates a failing channel: a healthy channel still delivers', async () => {
    const principal = await newUser('iso');
    const ownerUserId = (principal as { userId: string }).userId;
    await svc.create(principal, {
      name: 'iso good',
      kind: 'smtp',
      eventsSubscribed: ['weekly_spend_summary'],
      config: smtpConfig(smtpAccept.port),
    });
    await svc.create(principal, {
      name: 'iso dead',
      kind: 'smtp',
      eventsSubscribed: ['weekly_spend_summary'],
      config: smtpConfig(smtpReject.port, { user: 'u', pass: SENTINEL }),
    });
    const before = smtpAccept.messages.length;
    await notifications.emit({
      type: 'weekly_spend_summary',
      scope: { ownerUserId, lifecycleId: randomUUID() },
      fields: { total: '$12.34' },
    });
    const good = await waitFor(() => smtpAccept.messages.length === before + 1);
    expect(good).toBe(true); // healthy channel delivered despite the dead one failing
  }, 20_000);

  it('never lets a channel secret reach the job store, DB status, API view, or logs (canary)', async () => {
    const principal = await newUser('canary');
    const ownerUserId = (principal as { userId: string }).userId;
    const ch = await svc.create(principal, {
      name: 'canary smtp',
      kind: 'smtp',
      eventsSubscribed: ['request_failures_spike'],
      config: smtpConfig(smtpReject.port, { user: 'u', pass: SENTINEL }),
    });
    // Emit an event this channel is subscribed to → a deliver job is enqueued.
    await notifications.emit({
      type: 'request_failures_spike',
      scope: { ownerUserId, lifecycleId: randomUUID() },
      fields: { count: 42 },
    });
    const jobSeen = await waitFor(async () => {
      const jobs = await inspect.getJobs(
        ['waiting', 'active', 'delayed', 'completed', 'failed', 'paused'],
        0,
        200,
      );
      return jobs.some((j) => (j.data as { channelId?: string })?.channelId === ch.id);
    });
    expect(jobSeen).toBe(true);

    // 1) Redis job store: no channel secret in any job payload.
    const jobs = await inspect.getJobs(
      ['waiting', 'active', 'delayed', 'completed', 'failed', 'paused'],
      0,
      500,
    );
    const jobBlob = JSON.stringify(
      jobs.map((j) => ({ data: j.data, failedReason: j.failedReason })),
    );
    expect(jobBlob).not.toContain(SENTINEL);

    // 2) DB status (via a failing test-send) is a sanitized code.
    await svc.testSend(principal, ch.id);
    const status = await lastTestStatusOf(ch.id);
    expect(status).toBe('failed:smtp_send_failed');
    expect(status).not.toContain(SENTINEL);

    // 3) API view never carries the secret.
    const view: SafeChannel = await svc.get(principal, ch.id);
    expect(JSON.stringify(view)).not.toContain(SENTINEL);

    // 4) Captured logs never carry the secret.
    expect(capturedLogs.join('\n')).not.toContain(SENTINEL);
  }, 20_000);

  it('scopes channels per tenant: another user cannot read/mutate them', async () => {
    const a = await newUser('tenantA');
    const b = await newUser('tenantB');
    const chA = await svc.create(a, {
      name: 'A private',
      kind: 'apprise',
      eventsSubscribed: ['provider_down'],
      config: { urls: ['discord://a/secret'] },
    });
    await expect(svc.get(b, chA.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.update(b, chA.id, { name: 'hijacked' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.remove(b, chA.id)).rejects.toMatchObject({ status: 404 });
    // Owner still sees the untouched channel.
    expect((await svc.get(a, chA.id)).name).toBe('A private');
  });

  it('bounds emit latency when Redis is unreachable (never blocks the caller)', async () => {
    const principal = await newUser('blackhole');
    const ownerUserId = (principal as { userId: string }).userId;
    // 192.0.2.0/24 (TEST-NET-1) is guaranteed unroutable → a real BullMQ producer
    // add hangs; `withDeadline` (the exact bound `enqueueFanout` uses) caps it,
    // and NotificationService.emit swallows the reject. Producer-only (no Worker)
    // so nothing survives teardown. retryStrategy:null → the connection gives up.
    const blackhole = new Redis(6379, '192.0.2.1', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      retryStrategy: () => null,
    });
    blackhole.on('error', () => {});
    const bhq = new Queue('notify-blackhole-test', { connection: blackhole });
    bhq.on('error', () => {});
    const bhQueue = {
      enqueueFanout: (event: NotificationEvent) =>
        withDeadline(bhq.add('fanout', { event }, {}), 2_000, 'enqueue_timeout'),
    } as unknown as NotifyQueue;
    const bhSvc = new NotificationService(bhQueue);
    const start = Date.now();
    await bhSvc.emit({ type: 'test', scope: { ownerUserId }, fields: {} });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(6_000);
    blackhole.disconnect();
    await bhq.close().catch(() => {});
  }, 20_000);
});

describe('notification channels — cloud SSRF posture (#15a)', () => {
  let envPrev: Record<string, string | undefined>;

  beforeAll(() => {
    envPrev = saveEnv(ENV_KEYS);
  });
  afterAll(() => {
    restoreEnv(envPrev);
  });

  it('cloud mode rejects a private/loopback channel target (422) and refuses a private APPRISE_API_URL at boot', async () => {
    // A cloud instance with no APPRISE_API_URL boots; its channel guard blocks private/loopback.
    process.env.MODE = 'cloud';
    process.env.NOTIFY_CREDENTIALS_SECRET = NOTIFY_SECRET;
    delete process.env.APPRISE_API_URL;
    delete process.env.NOTIFY_ALLOWED_ENDPOINTS;

    const moduleRef = await Test.createTestingModule({ imports: [NotificationsModule] }).compile();
    const cloudApp = moduleRef.createNestApplication();
    await cloudApp.init();
    try {
      const cloudSvc = cloudApp.get(ChannelsService);
      const pool = new Pool({
        connectionString: loadConfig<{ DATABASE_URL: string }>().DATABASE_URL,
        max: 1,
      });
      const userId = randomUUID();
      await pool.query(
        'INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, false)',
        [userId, 'cloud', `cloud-${userId}@notify.test`],
      );
      const principal = userPrincipal(userId);
      try {
        await expect(
          cloudSvc.create(principal, {
            name: 'private relay',
            kind: 'smtp',
            eventsSubscribed: ['test'],
            config: { host: '10.0.0.5', port: 587, secure: 'none', from: 'a@b.c', to: ['x@y.z'] },
          }),
        ).rejects.toMatchObject({ status: 422 });
        await expect(
          cloudSvc.create(principal, {
            name: 'loopback relay',
            kind: 'smtp',
            eventsSubscribed: ['test'],
            config: { host: '127.0.0.1', port: 587, secure: 'none', from: 'a@b.c', to: ['x@y.z'] },
          }),
        ).rejects.toMatchObject({ status: 422 });
      } finally {
        await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
        await pool.end();
      }
    } finally {
      await cloudApp.close();
    }

    // A cloud instance pointed at a private APPRISE_API_URL must fail to boot.
    // The gate is the NOTIFY_RUNTIME factory (resolveNotifyRuntime), which boot
    // awaits. Assert its rejection DIRECTLY here rather than rejecting a full
    // module compile in-process: a failed compile() orphans already-constructed
    // providers with no owner to dispose them (NotifyQueue's eagerly-connected
    // Redis duplicates), leaking live sockets that keep the jest process alive
    // (ci-pipeline spec: the runner must exit without forceExit). The companion
    // spawned-boot test below proves this rejection actually aborts the REAL
    // application boot before it binds a port (OS reclaims the orphaned sockets).
    process.env.APPRISE_API_URL = 'http://10.0.0.9:9000';
    await expect(resolveNotifyRuntime()).rejects.toThrow(/SSRF/);
  }, 60_000);
});

// Process-isolated proof that the SSRF rejection above actually aborts a REAL
// application boot before it binds — the coverage the in-process compile test
// used to provide, relocated to a spawned process so orphaned Redis sockets are
// reclaimed by the OS instead of hanging the jest runner.
describe('notification channels — cloud APPRISE_API_URL boot gate (#15a)', () => {
  const builtMain = join(__dirname, '..', '..', 'dist', 'main.js');

  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
        srv.close(() => resolve(addr.port));
      });
    });

  it('a cloud instance with a private APPRISE_API_URL exits non-zero without binding the port', async () => {
    if (!existsSync(builtMain)) {
      throw new Error(`Built app missing at ${builtMain} — run \`npm run build\` first.`);
    }
    const port = await freePort();
    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      MODE: 'cloud',
      BIND_ADDRESS: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: 'a'.repeat(64),
      API_KEY_HMAC_SECRET: 'b'.repeat(64),
      PROVIDER_CREDENTIAL_KEY: 'c'.repeat(64),
      NOTIFY_CREDENTIALS_SECRET: NOTIFY_SECRET,
      APPRISE_API_URL: 'http://10.0.0.9:9000', // private → boot SSRF gate must reject
    };
    delete env['NOTIFY_ALLOWED_ENDPOINTS'];
    const child = spawn(process.execPath, [builtMain], { env });
    let bound = false;
    const exitCode: number = await new Promise((resolve) => {
      const probe = setInterval(() => {
        void fetch(`http://127.0.0.1:${String(port)}/api/health`, {
          signal: AbortSignal.timeout(300),
        })
          .then(() => (bound = true))
          .catch(() => undefined);
      }, 200);
      child.once('close', (code) => {
        clearInterval(probe);
        resolve(code ?? -1);
      });
      setTimeout(() => child.kill('SIGKILL'), 30_000);
    });
    expect(exitCode).not.toBe(0);
    expect(bound).toBe(false);
  }, 45_000);
});
