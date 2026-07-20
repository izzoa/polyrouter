// Stream lifecycle e2e — invariant 12 (ci-pipeline spec: "Stream drain,
// disconnect, and backpressure have automated coverage"). Drives a REAL
// listening HTTP server with raw node:http clients: supertest buffers whole
// responses, so mid-stream disconnects, write backpressure, and shutdown
// draining are only observable here.
//
// Determinism rules (design.md): every case latches on "first frame received"
// before acting; stub teardown is an awaitable promise; every wait is bounded;
// clients use dedicated agents destroyed in cleanup. Two apps are booted
// because draining is terminal: app1 (long deadline) runs backpressure →
// disconnect → drain-refusal in order; app2 (short deadline) runs the
// deadline-abort case.
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
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
  type Admission,
  type BreakerCompletion,
  type BreakerConfig,
  type BreakerOutcome,
  type BreakerStore,
} from '@polyrouter/data-plane';
import { BIG_FRAME_COUNT, startStubUpstream, type StubUpstream } from './stub-upstream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import { AgentApiKeyGuard } from '../../src/auth/agent-key.guard';
import { mintAgentKey } from '../../src/agents/agent-keys';
import { ChatCompletionsController } from '../../src/proxy/chat-completions.controller';
import { MessagesController } from '../../src/proxy/messages.controller';
import { ModelsController } from '../../src/proxy/models.controller';
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
import { RequestRecorder } from '../../src/recording/request-recorder';
import { ObservabilityModule } from '../../src/observability/observability.module';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { StructuralRouter } from '../../src/proxy/structural/structural-router';
import { CascadeRouter } from '../../src/proxy/cascade/cascade-router';
import { DatabaseModule } from '../../src/database/database.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';
import { SubscriptionOauthService } from '../../src/subscription-oauth/subscription-oauth.service';

const HMAC = 'a'.repeat(64);

/** Threshold-1 recording breaker store: any wrongly-recorded `trip` opens the
 * breaker immediately, so "a follow-up request serves" genuinely discriminates
 * neutral from trip (a threshold-5 default would mask one bad outcome). */
class RecordingBreakerStore implements BreakerStore {
  readonly outcomes: BreakerOutcome[] = [];
  private readonly inner = new InMemoryBreakerStore();

  decide(providerId: string, now: number, cfg: BreakerConfig): Promise<Admission> {
    return this.inner.decide(providerId, now, cfg);
  }

  complete(
    providerId: string,
    generation: number,
    outcome: BreakerOutcome,
    now: number,
    cfg: BreakerConfig,
  ): Promise<BreakerCompletion> {
    this.outcomes.push(outcome);
    return this.inner.complete(providerId, generation, outcome, now, cfg);
  }

  renew(providerId: string, generation: number, now: number, cfg: BreakerConfig): Promise<void> {
    return this.inner.renew(providerId, generation, now, cfg);
  }

  reset(providerId: string): Promise<void> {
    return this.inner.reset(providerId);
  }
}

const THRESHOLD_1: BreakerConfig = {
  threshold: 1,
  cooldownMs: 60_000,
  probeLeaseMs: 200,
  stateTtlMs: 60_000,
};

interface BootedApp {
  app: INestApplication;
  port: number;
  registry: StreamDrainRegistry;
  store: RecordingBreakerStore;
  providerDown: jest.Mock;
  recorded: jest.Mock;
  onRequestFailed: jest.Mock;
}

async function bootApp(streamDrainDeadlineMs: number): Promise<BootedApp> {
  const store = new RecordingBreakerStore();
  const providerDown = jest.fn();
  // Observable recorder + failure-spike producer so A-3 can assert a client disconnect
  // records `cancelled` and never fires the spike notify.
  const recorded = jest.fn<string, [unknown, { status: string }]>(() => 'rec-id');
  const onRequestFailed = jest.fn(() => Promise.resolve());
  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule, ObservabilityModule],
    controllers: [ChatCompletionsController, MessagesController, ModelsController],
    providers: [
      AgentApiKeyGuard,
      ProxyService,
      {
        // add-subscription-oauth: ProxyService's credential seam — these suites mint
        // no OAuth envelopes, so a call here is a wiring bug worth failing loudly.
        provide: SubscriptionOauthService,
        useValue: {
          resolveCredential: () => Promise.reject(new Error('oauth seam not stubbed')),
        },
      },
      StreamDrainRegistry,
      { provide: RequestRecorder, useValue: { record: recorded } },
      {
        provide: StructuralRouter,
        useValue: { enabled: false, evaluate: () => Promise.resolve({ kind: 'skip' }) },
      },
      { provide: CascadeRouter, useValue: { enabled: false, plan: () => null } },
      {
        provide: NotificationProducers,
        useValue: { providerDown, onRequestFailed },
      },
      {
        provide: BudgetService,
        useValue: { checkBlocked: () => Promise.resolve(null), notifyBlocked: () => undefined },
      },
      { provide: PROXY_RUNTIME, useValue: { ...loadProxyRuntime(), streamDrainDeadlineMs } },
      { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
      { provide: PROXY_BREAKER, useValue: new CircuitBreaker(store, { config: THRESHOLD_1 }) },
      { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
      { provide: CALIBRATION_RAILS, useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()) },
      { provide: APP_FILTER, useClass: ProxyExceptionFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    port,
    registry: app.get(StreamDrainRegistry),
    store,
    providerDown,
    recorded,
    onRequestFailed,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e as Error)),
    );
  });
}

interface StreamClient {
  res: http.IncomingMessage;
  firstFrame: Promise<void>;
  /** Resolves with the full collected body once the response ends or errors. */
  done: Promise<string>;
  text(): string;
  destroy(): void;
}

/** Raw streaming client on a dedicated non-keep-alive agent. */
function openStream(port: number, key: string, model: string): Promise<StreamClient> {
  const agent = new http.Agent({ keepAlive: false });
  const payload = JSON.stringify({
    model,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        agent,
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let collected = '';
        let firstResolve: () => void;
        const firstFrame = new Promise<void>((r) => (firstResolve = r));
        const done = new Promise<string>((doneResolve) => {
          res.on('data', (c: Buffer) => {
            collected += c.toString();
            firstResolve();
          });
          res.on('end', () => doneResolve(collected));
          res.on('error', () => doneResolve(collected)); // teardown counts as done
        });
        resolve({
          res,
          firstFrame,
          done,
          text: () => collected,
          destroy: () => {
            req.destroy();
            agent.destroy();
          },
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Raw non-streaming POST returning status + parsed JSON body. */
function postChat(
  port: number,
  key: string,
  model: string,
): Promise<{ status: number; body: { error?: { message?: string; type?: string } } }> {
  const agent = new http.Agent({ keepAlive: false });
  const payload = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        agent,
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () => {
          agent.destroy();
          resolve({
            status: res.statusCode ?? 0,
            body: (data ? JSON.parse(data) : {}) as {
              error?: { message?: string; type?: string };
            },
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `read` until it stops changing across two consecutive samples (the
 * value has settled) within `windowMs`, then return the settled value. Replaces
 * fixed sleeps so a loaded CI runner that fills buffers slowly still observes a
 * genuine stall rather than sampling mid-fill. */
async function settle(read: () => number, sampleMs: number, windowMs: number): Promise<number> {
  const deadline = Date.now() + windowMs;
  let prev = read();
  await sleep(sampleMs);
  while (Date.now() < deadline) {
    const cur = read();
    if (cur === prev) return cur;
    prev = cur;
    await sleep(sampleMs);
  }
  return read();
}

describe('stream lifecycle e2e (drain / disconnect / backpressure)', () => {
  let pool: Pool;
  let stub: StubUpstream;
  let a1: BootedApp; // long deadline: backpressure, disconnect, drain-refusal
  let a2: BootedApp; // short deadline: straggler abort
  let key: string;
  let userId: string;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    stub = await startStubUpstream();

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    a1 = await bootApp(5_000);
    a2 = await bootApp(500);

    // One tenant shared by both apps (same database).
    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
        ['lifecycle', `lifecycle-${Date.now()}@proxy.test`],
      )
    ).rows[0]!.id;
    const principal: Principal = userPrincipal(userId);
    const port = a1.app.get<PersistencePort>(PERSISTENCE_PORT);
    const provider = await port.providers.insert(principal, {
      name: 'openai-stub',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: stub.url,
    });
    const models: Record<string, string> = {};
    for (const ext of ['gpt-4o', 'oai-bigframes', 'oai-slowtail', 'oai-neverend']) {
      const m = await port.models.createForProvider(principal, provider.id, {
        externalModelId: ext,
      });
      models[ext] = m!.id;
    }
    await port.ensureDefaultTier(principal);
    const tiers = await port.tiers.list(principal);
    const defaultTier = tiers.find((t) => t.key === 'default')!;
    await port.routingEntries.replaceForTier(principal, defaultTier.id, [models['gpt-4o']!]);

    const minted = mintAgentKey(HMAC);
    await pool.query(
      `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
       VALUES (gen_random_uuid(), $1, 'agent', $2, $3, 'curl')`,
      [userId, minted.hash, minted.prefix],
    );
    key = minted.key;
  }, 60_000);

  // Every stream client opened in a test is destroyed here, so a failed
  // assertion can never leave a socket alive to delay process exit (forceExit
  // is gone — a leak would otherwise hang until the CI job timeout).
  const openClients: StreamClient[] = [];
  function openStreamTracked(p: number, k: string, model: string): Promise<StreamClient> {
    return openStream(p, k, model).then((c) => {
      openClients.push(c);
      return c;
    });
  }
  afterEach(() => {
    for (const c of openClients.splice(0)) c.destroy();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await a1.app.close();
    await a2.app.close();
    await pool.end();
    await stub.close();
  });

  it(
    'a slow client stalls upstream consumption instead of buffering unboundedly, and loses nothing',
    async () => {
      const c = await withTimeout(
        openStreamTracked(a1.port, key, 'oai-bigframes'),
        10_000,
        'open big-frame stream',
      );
      await withTimeout(c.firstFrame, 10_000, 'first frame');
      c.res.pause();

      // Every buffer in the chain (stub socket → undici → proxy → client socket)
      // fills, then the drain-aware counter settles. Poll until it stops moving
      // rather than sampling at a fixed instant (loaded-runner safe).
      const stalled = await settle(() => stub.framesSent(), 200, 5_000);
      await sleep(300);
      expect(stub.framesSent()).toBe(stalled); // still no progress while paused
      expect(stalled).toBeLessThan(BIG_FRAME_COUNT); // the stall happened mid-stream

      c.res.resume();
      const body = await withTimeout(c.done, 20_000, 'stream completion after resume');
      expect(stub.framesSent()).toBe(BIG_FRAME_COUNT); // progress resumed to completion

      // End-state integrity: every emitted frame arrived, in order.
      const indices = [...body.matchAll(/"content":"(\d+):/g)].map((m) => Number(m[1]));
      expect(indices).toEqual([...Array(BIG_FRAME_COUNT).keys()]);
      expect(body).toContain('[DONE]');
    },
    30_000,
  );

  it(
    'a mid-stream client disconnect tears down the upstream and stays breaker-neutral',
    async () => {
      const before = stub.requests.length;
      const outcomesBefore = a1.store.outcomes.length;
      const recordedBefore = a1.recorded.mock.calls.length;
      const notifiedBefore = a1.onRequestFailed.mock.calls.length;
      const client = await openStreamTracked(a1.port, key, 'oai-slowtail');
      await withTimeout(client.firstFrame, 10_000, 'first frame');

      client.destroy(); // client goes away mid-stream (tail arrives at +400ms)

      const record = stub.requests[before]!;
      await withTimeout(record.closed, 5_000, 'upstream teardown after client disconnect');

      // The breaker outcome for this attempt settles when the stream winds down.
      const deadline = Date.now() + 5_000;
      while (a1.store.outcomes.length <= outcomesBefore && Date.now() < deadline) {
        await sleep(25);
      }
      expect(a1.store.outcomes.length).toBeGreaterThan(outcomesBefore);
      expect(a1.store.outcomes[a1.store.outcomes.length - 1]).toBe('neutral');
      expect(a1.providerDown).not.toHaveBeenCalled();

      // A-3: the disconnect is recorded as `cancelled` (not a provider `error`) and
      // the failure-spike producer is never notified — a client hang-up can't inflate
      // the error rate or trip a false spike. The record lands in the outcome microtask.
      const recDeadline = Date.now() + 5_000;
      while (a1.recorded.mock.calls.length <= recordedBefore && Date.now() < recDeadline) {
        await sleep(25);
      }
      const call = a1.recorded.mock.calls[a1.recorded.mock.calls.length - 1]!;
      expect(call[1].status).toBe('cancelled');
      expect(a1.onRequestFailed.mock.calls.length).toBe(notifiedBefore); // no spike notify

      // Threshold-1 breaker: any mis-recorded trip would have opened it.
      const followUp = await postChat(a1.port, key, 'gpt-4o');
      expect(followUp.status).toBe(200);
    },
    30_000,
  );

  it(
    'drain refuses new work with a protocol-shaped 503 and lets the in-flight stream finish',
    async () => {
      const client = await openStreamTracked(a1.port, key, 'oai-slowtail');
      await withTimeout(client.firstFrame, 10_000, 'first frame');

      const drain = a1.registry.beforeApplicationShutdown(); // not awaited yet
      expect(a1.registry.isDraining()).toBe(true);

      const refused = await postChat(a1.port, key, 'gpt-4o');
      expect(refused.status).toBe(503);
      expect(refused.body.error?.message).toContain('shutting down'); // OpenAI error envelope
      expect(typeof refused.body.error?.type).toBe('string');

      const body = await withTimeout(client.done, 10_000, 'in-flight stream completion');
      expect(body).toContain(' tail'); // the delayed tail was delivered, not severed
      expect(body).toContain('[DONE]');

      await withTimeout(drain, 5_000, 'drain resolution after deregistration');
    },
    30_000,
  );

  it(
    'a straggler stream is aborted at the drain deadline and the upstream call is torn down',
    async () => {
      const before = stub.requests.length;
      const client = await openStreamTracked(a2.port, key, 'oai-neverend');
      await withTimeout(client.firstFrame, 10_000, 'first frame');

      const started = Date.now();
      await withTimeout(a2.registry.beforeApplicationShutdown(), 5_000, 'deadline drain');
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(495); // waited the configured 500ms deadline

      const record = stub.requests[before]!;
      await withTimeout(record.closed, 5_000, 'upstream teardown after deadline abort');
      await withTimeout(client.done, 5_000, 'client stream end after deadline abort');
      expect(client.text()).not.toContain('[DONE]'); // truncated, not fabricated-complete
      client.destroy();
    },
    30_000,
  );

  it(
    'app.close() completes even when a client has stopped reading a write-blocked stream (E1.2)',
    async () => {
      // A dedicated short-deadline app so closing it does not disturb a1/a2.
      const app = await bootApp(500);
      let client: StreamClient | undefined;
      try {
        // Fill the whole buffer chain with large frames, then stop reading so the
        // proxy pump parks in `await drain(res)` with the socket open. Before the
        // fix, the drain deadline aborts only the upstream and drain() never
        // resolves → httpServer.close() hangs forever. After the fix, drain()
        // resolves on the abort signal and the finally destroys the socket.
        client = await openStream(app.port, key, 'oai-bigframes');
        await withTimeout(client.firstFrame, 10_000, 'first frame');
        client.res.pause();
        await settle(() => stub.framesSent(), 200, 5_000); // let the pump reach backpressure

        const started = Date.now();
        await withTimeout(app.app.close(), 5_000, 'app.close() during write-blocked drain');
        const took = Date.now() - started;
        // Resolves within the drain deadline (500ms) + the registry poll interval
        // (50ms) + a generous fixed tolerance — NOT hanging to the 5s timeout.
        expect(took).toBeLessThan(3_000);
      } finally {
        client?.destroy();
      }
    },
    30_000,
  );
});
