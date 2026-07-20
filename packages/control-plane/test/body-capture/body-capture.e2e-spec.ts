// Body-capture e2e (add-body-capture): capture modes + overrides through the
// REAL proxy, ciphertext at rest, decrypt-on-read endpoints, tenancy, purge
// races (deliberately overlapped transactions), and the retention sweep.
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  userPrincipal,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  createProviderAdapter,
} from '@polyrouter/data-plane';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { startStubUpstream } from '../proxy/stub-upstream';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import { mintAgentKey } from '../../src/agents/agent-keys';
import { ChatCompletionsController } from '../../src/proxy/chat-completions.controller';
import { ProxyExceptionFilter } from '../../src/proxy/proxy-exception.filter';
import {
  PROXY_ADAPTER_FACTORY,
  PROXY_BREAKER,
  PROXY_RUNTIME,
  loadProxyRuntime,
} from '../../src/proxy/proxy.config';
import { ROUTING_CONFIG, loadRoutingConfig } from '../../src/proxy/routing.config';
import {
  CALIBRATION_RAILS,
  loadCalibrationConfig,
  railsOf,
  type CalibrationRails,
} from '../../src/calibration/calibration.config';
import { ProxyService } from '../../src/proxy/proxy.service';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { BudgetService } from '../../src/budgets/budget-service';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { RecordingModule } from '../../src/recording/recording.module';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { LogWriter } from '../../src/recording/log-writer';
import { PricingModule } from '../../src/pricing/pricing.module';
import { DatabaseModule } from '../../src/database/database.module';
import { AnalyticsModule } from '../../src/analytics/analytics.module';
import { BodyCaptureModule } from '../../src/body-capture/body-capture.module';
import { BodyCaptureService } from '../../src/body-capture/body-capture.service';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import '../../src/pricing/pricing.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

const HMAC = 'a'.repeat(64);

/** `/api` uses `x-test-user`; `/v1` stays on the agent-key plane. */
@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.path.startsWith('/api')) return true;
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

describe('body-capture e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let port: PersistencePort;
  let writer: LogWriter;
  let stub: import('../proxy/stub-upstream').StubUpstream;
  let userId: string;
  let otherUserId: string;
  let principal: Principal;
  let key: string;
  let agentId: string;

  const chat = (body: object, tier?: string) => {
    let r = request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`);
    if (tier !== undefined) r = r.set('x-polyrouter-tier', tier);
    return r.send(body);
  };
  const api = (user: string) => ({
    get: (p: string) => request(server).get(p).set('x-test-user', user),
    patch: (p: string, b: object) => request(server).patch(p).set('x-test-user', user).send(b),
    post: (p: string, b: object = {}) => request(server).post(p).set('x-test-user', user).send(b),
    del: (p: string) => request(server).delete(p).set('x-test-user', user),
  });
  const bodiesInDb = async (owner: string) =>
    (
      await pool.query<{ direction: string; content_encrypted: string }>(
        'SELECT direction, content_encrypted FROM request_body WHERE owner_user_id = $1',
        [owner],
      )
    ).rows;
  const newestLogId = async () =>
    (await port.requestLogs.list(principal))[0]!.id;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    stub = await startStubUpstream();

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        PricingModule,
        RecordingModule,
        ObservabilityModule,
        AnalyticsModule,
        BodyCaptureModule,
      ],
      controllers: [ChatCompletionsController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        {
          provide: SubscriptionOauthService,
          useValue: {
            resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')),
          },
        },
        StreamDrainRegistry,
        {
          provide: StructuralRouter,
          useValue: { enabled: false, evaluate: () => Promise.resolve({ kind: 'skip' }) },
        },
        { provide: CascadeRouter, useValue: { enabled: false, plan: () => null } },
        {
          provide: NotificationProducers,
          useValue: { providerDown: () => undefined, onRequestFailed: () => Promise.resolve() },
        },
        {
          provide: BudgetService,
          useValue: { checkBlocked: () => Promise.resolve(null), notifyBlocked: () => undefined },
        },
        { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
        { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
        { provide: PROXY_BREAKER, useValue: new CircuitBreaker(new InMemoryBreakerStore()) },
        { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
        { provide: CALIBRATION_RAILS, useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()) },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
        { provide: APP_GUARD, useClass: TestPrincipalGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    port = app.get<PersistencePort>(PERSISTENCE_PORT);
    writer = app.get(LogWriter);

    const mk = async (email: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'bc', $1, true) RETURNING id`,
          [email],
        )
      ).rows[0]!.id;
    userId = await mk(`bc-${Date.now()}@t.test`);
    otherUserId = await mk(`bc-other-${Date.now()}@t.test`);
    principal = userPrincipal(userId);
    const provider = await port.providers.insert(principal, {
      name: 'stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    const model = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'gpt-4o',
    });
    const srvfail = await port.models.createForProvider(principal, provider.id, {
      externalModelId: 'oai-srvfail',
    });
    await port.ensureDefaultTier(principal);
    const tier = (await port.tiers.list(principal)).find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, tier.id, [model!.id]);
    const failing = await port.tiers.insert(principal, { key: 'failing' });
    await port.routingEntries.replaceForTier(principal, failing.id, [srvfail!.id]);
    const minted = mintAgentKey(HMAC);
    agentId = (
      await pool.query<{ id: string }>(
        `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
         VALUES (gen_random_uuid(), $1, 'a', $2, $3, 'curl') RETURNING id`,
        [userId, minted.hash, minted.prefix],
      )
    ).rows[0]!.id;
    key = minted.key;
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[userId, otherUserId]]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  it('fresh install (no settings row) captures nothing', async () => {
    expect((await chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200);
    await writer.flush();
    expect(await bodiesInDb(userId)).toHaveLength(0);
  });

  it('mode=all captures the exchange — ciphertext at rest, plaintext only via the endpoint', async () => {
    await api(userId).patch('/api/body-capture', { mode: 'all' }).expect(200);
    const secretish = 'the launch code is swordfish-9';
    expect(
      (await chat({ model: 'gpt-4o', messages: [{ role: 'user', content: secretish }] })).status,
    ).toBe(200);
    await writer.flush();
    const rows = await bodiesInDb(userId);
    expect(rows.map((r) => r.direction).sort()).toEqual(['request', 'response']);
    for (const r of rows) {
      expect(r.content_encrypted.startsWith('poly-enc:')).toBe(true); // ciphertext only
      expect(r.content_encrypted).not.toContain('swordfish');
    }
    const id = await newestLogId();
    const got = await api(userId).get(`/api/analytics/requests/${id}/bodies`).expect(200);
    const req = (got.body as { direction: string; content: string }[]).find(
      (b) => b.direction === 'request',
    )!;
    expect(req.content).toContain(secretish); // decrypt-on-read
    // The listing exposes only the flag, never content.
    const now = Date.now();
    const list = await api(userId)
      .get('/api/analytics/requests')
      .query({
        from: new Date(now - 3_600_000).toISOString(),
        to: new Date(now + 3_600_000).toISOString(),
        limit: 50,
      })
      .expect(200);
    const row = (list.body.rows as { id: string; hasBodies: boolean }[]).find((r) => r.id === id)!;
    expect(row.hasBodies).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain('swordfish');
  });

  it('per-request delete tombstones; cross-tenant access is 404', async () => {
    const id = await newestLogId();
    await api(otherUserId).get(`/api/analytics/requests/${id}/bodies`).expect(404);
    await api(otherUserId).del(`/api/analytics/requests/${id}/bodies`).expect(404);
    await api(userId).del(`/api/analytics/requests/${id}/bodies`).expect(200);
    await api(userId).get(`/api/analytics/requests/${id}/bodies`).expect(404);
    const ts = await pool.query('SELECT 1 FROM request_body_tombstone WHERE request_log_id = $1', [id]);
    expect(ts.rowCount).toBe(1);
    // A late queued draft for the deleted request can never resurrect it.
    const r = await port.bodyCapture.insertBodies(principal, [
      {
        requestLogId: id,
        direction: 'request',
        contentEncrypted: 'poly-enc:v1:x:x:x',
        bytes: 1,
        truncated: false,
        partial: false,
        epoch: (await port.bodyCapture.getSettings(principal))!.captureEpoch,
        capturedAt: new Date(),
      },
    ]);
    expect(r).toEqual({ inserted: 0, discarded: 1 });
  });

  it('errors_only stores exactly the debugging set; agent overrides refine it', async () => {
    await api(userId).post('/api/body-capture/purge').expect(200);
    await api(userId).patch('/api/body-capture', { mode: 'errors_only' }).expect(200);
    expect((await chat({ model: 'gpt-4o', messages: [] })).status).toBe(200); // success → nothing
    expect((await chat({ model: 'auto', messages: [] }, 'failing')).status).toBeGreaterThanOrEqual(500); // whole-chain error → captured
    await writer.flush();
    let rows = await bodiesInDb(userId);
    expect(rows).toHaveLength(1); // the error's REQUEST direction only (no response assembled)
    expect(rows[0]!.direction).toBe('request');

    await api(userId).post('/api/body-capture/purge').expect(200);
    await api(userId)
      .patch(`/api/body-capture/agents/${agentId}/override`, { override: 'always' })
      .expect(200);
    expect((await chat({ model: 'gpt-4o', messages: [] })).status).toBe(200); // success now captured
    await writer.flush();
    rows = await bodiesInDb(userId);
    expect(rows.map((r) => r.direction).sort()).toEqual(['request', 'response']);

    await api(userId).post('/api/body-capture/purge').expect(200);
    await api(userId)
      .patch(`/api/body-capture/agents/${agentId}/override`, { override: 'never' })
      .expect(200);
    expect((await chat({ model: 'auto', messages: [] }, 'failing')).status).toBeGreaterThanOrEqual(500);
    await writer.flush();
    expect(await bodiesInDb(userId)).toHaveLength(0); // never suppresses even errors
    await api(userId)
      .patch(`/api/body-capture/agents/${agentId}/override`, { override: null })
      .expect(200);
  });

  it('global off is a master kill: agent-always captures nothing', async () => {
    await api(userId)
      .patch(`/api/body-capture/agents/${agentId}/override`, { override: 'always' })
      .expect(200);
    await api(userId).patch('/api/body-capture', { mode: 'off' }).expect(200);
    expect((await chat({ model: 'gpt-4o', messages: [] })).status).toBe(200);
    await writer.flush();
    expect(await bodiesInDb(userId)).toHaveLength(0);
    await api(userId)
      .patch(`/api/body-capture/agents/${agentId}/override`, { override: null })
      .expect(200);
  });

  it('infinite retention demands the explicit keepForever choice', async () => {
    await api(userId)
      .patch('/api/body-capture', { mode: 'all', retentionDays: null })
      .expect(400); // blank infinite → rejected
    await api(userId)
      .patch('/api/body-capture', { mode: 'all', retentionDays: null, keepForever: true })
      .expect(200);
    const s = await api(userId).get('/api/body-capture').expect(200);
    expect(s.body.retentionDays).toBeNull();
    await api(userId).patch('/api/body-capture', { retentionDays: 30 }).expect(200);
  });

  it('purge-all wins a DELIBERATELY OVERLAPPED race with a guarded insert', async () => {
    await api(userId).patch('/api/body-capture', { mode: 'all' }).expect(200);
    expect((await chat({ model: 'gpt-4o', messages: [] })).status).toBe(200);
    await writer.flush();
    const id = await newestLogId();
    const settings = (await port.bodyCapture.getSettings(principal))!;
    // Conn A simulates an in-flight guarded insert: it takes the SAME owner
    // lock, inserts, and commits — while purge-all is already waiting on the
    // lock. Lock-ordering must leave the store EMPTY either way (D9).
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query('SELECT capture_epoch FROM body_capture_settings WHERE owner_user_id = $1 FOR UPDATE', [userId]);
      const purge = api(userId).post('/api/body-capture/purge').then((r) => r.body as { purged: number });
      await new Promise((r) => setTimeout(r, 150)); // purge is now blocked on the lock
      await conn.query(
        `INSERT INTO request_body (id, owner_user_id, request_log_id, direction, content_encrypted, bytes)
         VALUES (gen_random_uuid(), $1, $2, 'response', 'poly-enc:v1:a:a:a', 1)
         ON CONFLICT DO NOTHING`,
        [userId, id],
      );
      await conn.query('COMMIT'); // releases the lock → purge proceeds and must see the row
      await purge;
    } finally {
      conn.release();
    }
    expect(await bodiesInDb(userId)).toHaveLength(0);
    // And a stale-epoch draft (captured pre-purge) discards on the guarded path.
    const late = await port.bodyCapture.insertBodies(principal, [
      {
        requestLogId: id,
        direction: 'request',
        contentEncrypted: 'poly-enc:v1:b:b:b',
        bytes: 1,
        truncated: false,
        partial: false,
        epoch: settings.captureEpoch, // pre-purge epoch
        capturedAt: new Date(),
      },
    ]);
    expect(late).toEqual({ inserted: 0, discarded: 1 });
  });

  it('per-request delete also wins an overlapped race with a guarded insert', async () => {
    await api(userId).patch('/api/body-capture', { mode: 'all' }).expect(200);
    expect((await chat({ model: 'gpt-4o', messages: [] })).status).toBe(200);
    await writer.flush();
    const id = await newestLogId();
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(
        'SELECT capture_epoch FROM body_capture_settings WHERE owner_user_id = $1 FOR UPDATE',
        [userId],
      );
      const del = api(userId).del(`/api/analytics/requests/${id}/bodies`).then((r) => r.status);
      await new Promise((r) => setTimeout(r, 150)); // delete now blocked on the owner lock
      await conn.query(
        `INSERT INTO request_body (id, owner_user_id, request_log_id, direction, content_encrypted, bytes)
         VALUES (gen_random_uuid(), $1, $2, 'response', 'poly-enc:v1:d:d:d', 1)
         ON CONFLICT DO NOTHING`,
        [userId, id],
      );
      await conn.query('COMMIT'); // delete proceeds and must remove BOTH directions
      expect(await del).toBe(200);
    } finally {
      conn.release();
    }
    const left = await pool.query('SELECT 1 FROM request_body WHERE request_log_id = $1', [id]);
    expect(left.rowCount).toBe(0);
    await api(userId).patch('/api/body-capture', { mode: 'off' }).expect(200);
  });

  it('the retention sweep purges expired rows, skips infinite owners, and rejects pre-expired drafts', async () => {
    await api(userId).patch('/api/body-capture', { mode: 'all', retentionDays: 30 }).expect(200);
    expect((await chat({ model: 'gpt-4o', messages: [] })).status).toBe(200);
    await writer.flush();
    const id = await newestLogId();
    await pool.query(
      `UPDATE request_body SET created_at = now() - interval '31 days' WHERE owner_user_id = $1`,
      [userId],
    );
    const swept = await port.bodyCapture.purgeExpiredAllOwners();
    expect(swept.purged).toBeGreaterThanOrEqual(1);
    expect(await bodiesInDb(userId)).toHaveLength(0);
    const stamped = (await port.bodyCapture.getSettings(principal))!;
    expect(stamped.lastPurgeAt).not.toBeNull();
    // A delayed draft captured beyond the window can never land pre-expired.
    const lateDraft = await port.bodyCapture.insertBodies(principal, [
      {
        requestLogId: id,
        direction: 'request',
        contentEncrypted: 'poly-enc:v1:c:c:c',
        bytes: 1,
        truncated: false,
        partial: false,
        epoch: stamped.captureEpoch,
        capturedAt: new Date(Date.now() - 31 * 86_400_000),
      },
    ]);
    expect(lateDraft).toEqual({ inserted: 0, discarded: 1 });
    await api(userId).patch('/api/body-capture', { mode: 'off' }).expect(200);
  });

  it('tenant isolation: settings, overrides, and purge are invisible across owners', async () => {
    await api(otherUserId).patch(`/api/body-capture/agents/${agentId}/override`, { override: 'always' }).expect(404);
    const other = await api(otherUserId).get('/api/body-capture').expect(200);
    expect(other.body.mode).toBe('off'); // B's own (absent) settings, never A's
  });

  it('a non-selfhosted service never captures and rejects enables (smuggled row included)', async () => {
    const svc = new BodyCaptureService(port, {
      selfhosted: false,
      maxBytes: 262_144,
      queueBudgetBytes: 1,
      batchBudgetBytes: 1,
      credentialKey: 'c'.repeat(64),
    });
    // Smuggle an enabled row directly, then verify the seam still reads OFF.
    await port.bodyCapture.upsertSettings(principal, { mode: 'all' });
    expect((await svc.contextFor(principal, agentId)).mode).toBe('off');
    await expect(svc.update(principal, { mode: 'all' })).rejects.toThrow(/selfhosted/);
    await api(userId).patch('/api/body-capture', { mode: 'off' }).expect(200);
  });
});
