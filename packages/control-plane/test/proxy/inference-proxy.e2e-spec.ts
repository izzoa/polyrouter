// Inference-proxy e2e (real Postgres + a local stub upstream). Boots a slim
// module with the REAL AgentApiKeyGuard (which needs only IDENTITY_PORT, not
// better-auth) so agent-key auth is exercised end-to-end.
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
import { createProviderAdapter } from '@polyrouter/data-plane';
import request from 'supertest';
import type { App } from 'supertest/types';
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
  PROXY_RUNTIME,
  loadProxyRuntime,
} from '../../src/proxy/proxy.config';
import { ProxyService } from '../../src/proxy/proxy.service';
import { StreamDrainRegistry } from '../../src/proxy/stream-drain.registry';
import { DatabaseModule } from '../../src/database/database.module';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/database/database.config';
import '../../src/auth/auth.config';

const HMAC = 'a'.repeat(64);

interface Tenant {
  principal: Principal;
  userId: string;
  key: string;
  models: Record<string, string>; // externalId -> model id
}

async function seedTenant(
  port: PersistencePort,
  pool: Pool,
  label: string,
  stubUrl: string,
): Promise<Tenant> {
  const userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
      [label, `${label}-${Date.now()}@proxy.test`],
    )
  ).rows[0]!.id;
  const principal = userPrincipal(userId);
  const openai = await port.providers.insert(principal, {
    name: 'openai-stub',
    kind: 'local',
    protocol: 'openai_compatible',
    baseUrl: stubUrl,
  });
  const anthropic = await port.providers.insert(principal, {
    name: 'anthropic-stub',
    kind: 'local',
    protocol: 'anthropic_compatible',
    baseUrl: stubUrl,
  });
  const models: Record<string, string> = {};
  const add = async (providerId: string, ext: string): Promise<void> => {
    const m = await port.models.createForProvider(principal, providerId, { externalModelId: ext });
    models[ext] = m!.id;
  };
  await add(openai.id, 'gpt-4o');
  await add(openai.id, 'oai-miderror');
  await add(anthropic.id, 'claude-x');
  await add(anthropic.id, 'anthro-miderror');
  await add(anthropic.id, 'anthro-firsterror');
  await add(openai.id, `${label}-secret`);

  await port.ensureDefaultTier(principal);
  const tiers = await port.tiers.list(principal);
  const defaultTier = tiers.find((t) => t.key === 'default')!;
  await port.routingEntries.replaceForTier(principal, defaultTier.id, [models['gpt-4o']!]);
  const fast = await port.tiers.insert(principal, { key: 'fast' });
  await port.routingEntries.replaceForTier(principal, fast.id, [models['claude-x']!]);
  await port.tiers.insert(principal, { key: 'empty' }); // no entries

  const minted = mintAgentKey(HMAC);
  await pool.query(
    `INSERT INTO agent (id, owner_user_id, name, api_key_hash, api_key_prefix, harness_type)
     VALUES (gen_random_uuid(), $1, 'agent', $2, $3, 'curl')`,
    [userId, minted.hash, minted.prefix],
  );
  return { principal, userId, key: minted.key, models };
}

describe('inference proxy e2e', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let stub: import('./stub-upstream').StubUpstream;
  let A: Tenant;
  let B: Tenant;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = 'c'.repeat(64);
    process.env['API_KEY_HMAC_SECRET'] = HMAC;
    const { startStubUpstream } = await import('./stub-upstream');
    stub = await startStubUpstream();

    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
      controllers: [ChatCompletionsController, MessagesController, ModelsController],
      providers: [
        AgentApiKeyGuard,
        ProxyService,
        StreamDrainRegistry,
        { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
        { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
        { provide: APP_FILTER, useClass: ProxyExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    const port = app.get<PersistencePort>(PERSISTENCE_PORT);
    A = await seedTenant(port, pool, 'proxyA', stub.url);
    B = await seedTenant(port, pool, 'proxyB', stub.url);
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[A.userId, B.userId]]);
    await app.close();
    await pool.end();
    await stub.close();
  });

  const chat = (key: string | null, body: unknown) => {
    let r = request(server).post('/v1/chat/completions');
    if (key) r = r.set('Authorization', `Bearer ${key}`);
    return r.send(body as object);
  };

  // --- auth ---

  it('authenticates via Bearer and x-api-key; rejects invalid with a protocol error', async () => {
    expect((await chat(A.key, { model: 'auto', messages: [] })).status).toBe(200);
    const viaXApiKey = await request(server)
      .post('/v1/messages')
      .set('x-api-key', A.key)
      .send({ model: 'auto', messages: [], max_tokens: 16 });
    expect(viaXApiKey.status).toBe(200);
    const bad = await chat('poly_notarealkey000', { model: 'auto', messages: [] });
    expect(bad.status).toBe(401);
    expect(bad.body.error.type).toBe('authentication_error'); // OpenAI-shaped
    // Two credential headers that disagree → 401 (one identity per request).
    const conflict = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${A.key}`)
      .set('x-api-key', `${A.key}x`)
      .send({ model: 'auto', messages: [] });
    expect(conflict.status).toBe(401);
  });

  // --- routing ---

  it('routes auto/explicit/tier-key/header and errors on unknown', async () => {
    expect((await chat(A.key, { model: 'auto', messages: [] })).body.model).toBeDefined();
    expect((await chat(A.key, { model: 'gpt-4o', messages: [] })).status).toBe(200);
    // tier key in the model field → the fast tier (Anthropic provider, cross-protocol)
    const viaTier = await chat(A.key, { model: 'fast', messages: [] });
    expect(viaTier.status).toBe(200);
    expect(viaTier.body.object).toBe('chat.completion'); // OpenAI-shaped back to the client
    // header forces the tier
    const viaHeader = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${A.key}`)
      .set('x-polyrouter-tier', 'fast')
      .send({ model: 'auto', messages: [] });
    expect(viaHeader.status).toBe(200);
    // unknown model → 404, not a silent default
    const unknown = await chat(A.key, { model: 'no-such-model', messages: [] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('model_not_found');
  });

  it('routes an empty tier to a clear 4xx', async () => {
    const res = await chat(A.key, { model: 'empty', messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('empty_tier');
  });

  it('shapes a malformed JSON body as a protocol 4xx', async () => {
    const res = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${A.key}`)
      .set('Content-Type', 'application/json')
      .send('{ "model": "auto" ,,, }');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error).toBeDefined(); // OpenAI-shaped, not Nest's default
  });

  // --- cross-protocol ---

  it('OpenAI client ⟷ Anthropic upstream round-trips (non-streaming)', async () => {
    const res = await chat(A.key, {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toContain('Hello from stub');
  });

  // --- streaming ---

  it('streams SSE and terminates with [DONE]', async () => {
    const res = await chat(A.key, { model: 'gpt-4o', stream: true, messages: [] });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data: [DONE]');
    expect(res.text).toContain('"content":"Hello"');
  });

  it('emits a sanitized terminal error on a mid-stream upstream failure (no swap, no leak)', async () => {
    const res = await chat(A.key, { model: 'anthro-miderror', stream: true, messages: [] });
    expect(res.status).toBe(200); // committed before the failure
    expect(res.text).toContain('"upstream_error"');
    expect(res.text).not.toContain('SECRET');
  });

  it('a first-event upstream error stays pre-commit (clean HTTP error, no stream)', async () => {
    const res = await chat(A.key, { model: 'anthro-firsterror', stream: true, messages: [] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers['content-type']).toContain('application/json');
  });

  // --- /v1/models & isolation ---

  it('lists routable ids and isolates tenants', async () => {
    const models = await request(server).get('/v1/models').set('Authorization', `Bearer ${A.key}`);
    const ids = models.body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('auto');
    expect(ids).toContain('default');
    expect(ids).toContain('gpt-4o');
    expect(ids).not.toContain('proxyB-secret'); // never another tenant's model

    // A's key cannot reach B's model id — it isn't in A's config → unknown_model.
    const cross = await chat(A.key, { model: 'proxyB-secret', messages: [] });
    expect(cross.status).toBe(404);
  });
});
