// add-subscription-oauth e2e: the connect/reauthorize flow over real HTTP + Postgres +
// Redis (stub IdP via OAUTH_TOKEN_FETCH; stub preset pinned to a LOCAL upstream so
// test-connection exercises the REAL http adapter and we can assert the wire headers:
// Authorization: Bearer + anthropic-beta, and NO x-api-key). Secret hygiene asserted
// throughout: no token or pasted artifact in any response body.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
  REDIS_CLIENT,
  parseCredentialEnvelope,
  decryptSecret,
  userPrincipal,
} from '@polyrouter/shared/server';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { ProvidersModule } from '../../src/providers/providers.module';
import { PROVIDER_ADAPTER_FACTORY } from '../../src/providers/providers.service';
import {
  OAUTH_PRESET_LOOKUP,
  OAUTH_TOKEN_FETCH,
} from '../../src/subscription-oauth/subscription-oauth.service';
import type { OauthPreset } from '../../src/subscription-oauth/presets';
import type { TokenSet } from '../../src/subscription-oauth/oauth-client';
import { uniqueEmail } from '../auth/auth-harness';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/providers/providers.config';
import '../../src/database/database.config';
import '../../src/redis/redis.config';

const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
const KEY = 'd'.repeat(64);

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

// Stub IdP: records exchange bodies AND the full inputs (encoding/grant —
// add-chatgpt-responses); programmable per test.
let exchanges: Array<Record<string, string>> = [];
let exchangeInputs: Array<{ encoding?: string; grant?: string; body: Record<string, string> }> = [];
let nextTokens: () => Promise<TokenSet> = () =>
  Promise.resolve({ accessToken: 'at-e2e-1', refreshToken: 'rt-e2e-1', expiresAt: Date.now() + 3_600_000 });
let factoryConfigs: Array<Record<string, unknown>> = [];
let nextChat: () => Promise<unknown> = () =>
  Promise.resolve({ content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' });

// A valid ChatGPT-shaped id_token: the account id lives at the NESTED claim.
const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
const ID_TOKEN = `${b64url({ alg: 'RS256' })}.${b64url({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-e2e-77' },
})}.sig`;
const chatgptTokens = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'at-e2e-1',
  refreshToken: 'rt-e2e-1',
  expiresAt: Date.now() + 3_600_000,
  idToken: ID_TOKEN,
  ...over,
});

describe('subscription OAuth connect (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let alice: string;
  let bob: string;
  let upstream: http.Server;
  let upstreamBase: string;
  let upstreamHeaders: Array<Record<string, string | string[] | undefined>>;
  let preset: OauthPreset;
  let bundledPreset: OauthPreset;
  let chatgptPreset: OauthPreset;

  const mkUser = async (): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'u', $1, false) RETURNING id`,
        [uniqueEmail('oauth')],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = KEY;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`${COMPOSE_HINT}\n(${(error as Error).message})`);
    }
    // Local Anthropic-shaped upstream: records auth headers for the wire assertions.
    upstreamHeaders = [];
    upstream = http.createServer((req, res) => {
      upstreamHeaders.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sub-model', display_name: 'Sub Model' }] }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamBase = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;

    bundledPreset = {
      id: 'stub-bundled',
      displayName: 'Stub Bundled',
      // Canonical ROOT URL (href form, trailing slash) — regression guard for codex r3:
      // a name-only PATCH against a root-URL preset must NOT read as endpoint drift.
      baseUrl: 'https://3.3.3.3/',
      protocol: 'anthropic_compatible',
      authorizeUrl: 'https://idp.example/authorize',
      tokenEndpoint: 'https://idp.example/token',
      clientId: 'client-e2e',
      scopes: 'user:inference',
      redirectUri: 'https://idp.example/oauth/code/callback',
      tokenRequestEncoding: 'json',
      includeStateInExchange: true,
      oauthBeta: 'oauth-2025-04-20',
      modelsSource: 'bundled',
      bundledModels: ['bundled-model-a', 'bundled-model-b'],
      enabled: true,
    };
    chatgptPreset = {
      id: 'stub-chatgpt',
      displayName: 'Stub ChatGPT',
      // Public-shaped canonical ROOT href; wire tests use a direct adapter build.
      baseUrl: 'https://2.2.2.2/',
      protocol: 'openai_responses',
      authorizeUrl: 'https://idp.example/authorize',
      tokenEndpoint: 'https://idp.example/token',
      clientId: 'client-e2e-gpt',
      scopes: 'openid profile',
      // Dead-tab localhost redirect: code+state arrive in the QUERY.
      redirectUri: 'http://localhost:1455/auth/callback',
      tokenRequestEncoding: 'form',
      includeStateInExchange: false,
      modelsSource: 'bundled',
      bundledModels: ['gpt-5', 'gpt-5-codex'],
      probeModel: 'gpt-5',
      enabled: true,
    };
    preset = {
      id: 'stub-claude',
      displayName: 'Stub Claude',
      // Public-shaped constant so PATCH/action-path SSRF gating passes; no request ever
      // dials it (the adapter factory is stubbed). The REAL-wire header assertion uses
      // the local upstream via a direct adapter build below.
      baseUrl: 'https://1.1.1.1/v1',
      protocol: 'anthropic_compatible',
      authorizeUrl: 'https://idp.example/authorize',
      tokenEndpoint: 'https://idp.example/token',
      clientId: 'client-e2e',
      scopes: 'user:inference',
      redirectUri: 'https://idp.example/oauth/code/callback',
      tokenRequestEncoding: 'json',
      includeStateInExchange: true,
      oauthBeta: 'oauth-2025-04-20',
      modelsSource: 'endpoint',
      enabled: true,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ProvidersModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    })
      .overrideProvider(PROVIDER_ADAPTER_FACTORY)
      .useValue(((cfg: unknown) => {
        factoryConfigs.push(cfg as Record<string, unknown>);
        return {
          protocol: 'anthropic_compatible',
          chat: () => nextChat(),
          chatStream: async function* () {
            /* n/a */
          },
          testConnection: () => Promise.resolve({ ok: true, models: 0 }),
          listModels: () => Promise.resolve([]),
        };
      }) as unknown as import('../../src/providers/providers.service').ProviderAdapterFactory)
      .overrideProvider(OAUTH_TOKEN_FETCH)
      .useValue((input: { body: Record<string, string>; encoding?: string; grant?: string }) => {
        exchanges.push(input.body);
        exchangeInputs.push(input);
        return nextTokens();
      })
      .overrideProvider(OAUTH_PRESET_LOOKUP)
      .useValue({
        find: (id: string) =>
          id === 'stub-claude'
            ? preset
            : id === 'stub-bundled'
              ? bundledPreset
              : id === 'stub-chatgpt'
                ? chatgptPreset
                : undefined,
        list: () => [preset, bundledPreset, chatgptPreset],
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    alice = await mkUser();
    bob = await mkUser();
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[alice, bob]]);
    await app.close();
    await pool.end();
    upstream.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM provider WHERE owner_user_id = ANY($1)', [[alice, bob]]);
    // Reset the per-principal + per-IP connect throttles between tests (one file's
    // tests otherwise share the 10/min window).
    const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
    const keys = await redis.keys('rl:oauthp:*');
    const ipKeys = await redis.keys('rl:oauthc:*');
    if (keys.length + ipKeys.length > 0) await redis.del(...keys, ...ipKeys);
    exchanges = [];
    exchangeInputs = [];
    factoryConfigs = [];
    nextChat = () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' });
    upstreamHeaders = [];
    nextTokens = () =>
      Promise.resolve({
        accessToken: 'at-e2e-1',
        refreshToken: 'rt-e2e-1',
        expiresAt: Date.now() + 3_600_000,
      });
  });

  const as = (user: string, path: string): request.Test =>
    request(server).post(path).set('x-test-user', user).set('Cookie', 'session_token=cookie-1');

  async function startConnect(user = alice): Promise<{ sessionId: string; state: string }> {
    const res = await as(user, '/api/providers/oauth/start').send({ preset: 'stub-claude' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const state = new URL(res.body.authorizeUrl).searchParams.get('state')!;
    return { sessionId: res.body.sessionId, state };
  }

  it('connects end to end: row created, envelope typed+sealed, no secrets echoed', async () => {
    const { sessionId, state } = await startConnect();
    const res = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: `the-code#${state}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      kind: 'subscription',
      oauthPreset: 'stub-claude',
      hasCredential: true,
      credentialError: null,
      baseUrl: preset.baseUrl,
      protocol: 'anthropic_compatible',
    });
    expect(res.body.credentialExpiresAt).toBeTruthy();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('at-e2e-1');
    expect(body).not.toContain('rt-e2e-1');
    expect(body).not.toContain('the-code');
    // Exchange carried PKCE + the pasted code.
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({ grant_type: 'authorization_code', code: 'the-code' });
    expect(typeof exchanges[0]!['code_verifier']).toBe('string');
    expect(typeof exchanges[0]!['state']).toBe('string'); // the Claude-shape exchange CARRIES state
    // Stored envelope is the TYPED oauth form, encrypted.
    const rows = await pool.query<{ encrypted_credentials: string }>(
      'SELECT encrypted_credentials FROM provider WHERE id = $1',
      [res.body.id],
    );
    const parsed = parseCredentialEnvelope(decryptSecret(rows.rows[0]!.encrypted_credentials, KEY));
    expect(parsed.kind).toBe('oauth');
  });

  it('rejects a state mismatch, a bare code, and a consumed session — writing nothing', async () => {
    const { sessionId, state } = await startConnect();
    // wrong state
    expect(
      (await as(alice, '/api/providers/oauth/complete').send({ sessionId, pasted: 'c#wrong-state' }))
        .status,
    ).toBe(422);
    // session was atomically consumed by the failed attempt → a replay is unknown
    const replay = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: `c#${state}`,
    });
    expect(replay.status).toBe(422);
    expect(exchanges).toHaveLength(0); // no exchange ever ran
    // bare code (fresh session): rejected with guidance, session intact until claim
    const s2 = await startConnect();
    const bare = await as(alice, '/api/providers/oauth/complete').send({
      sessionId: s2.sessionId,
      pasted: 'just-a-code',
    });
    expect(bare.status).toBe(422);
    const count = await pool.query('SELECT count(*)::int c FROM provider WHERE owner_user_id = $1', [
      alice,
    ]);
    expect(count.rows[0].c).toBe(0);
  });

  it('double-submit yields exactly one exchange (atomic single-use claim)', async () => {
    const { sessionId, state } = await startConnect();
    nextTokens = () =>
      new Promise((r) =>
        setTimeout(
          () =>
            r({ accessToken: 'at-e2e-1', refreshToken: 'rt-e2e-1', expiresAt: Date.now() + 3_600_000 }),
          30,
        ),
      );
    const [a, b] = await Promise.all([
      as(alice, '/api/providers/oauth/complete').send({ sessionId, pasted: `c#${state}` }),
      as(alice, '/api/providers/oauth/complete').send({ sessionId, pasted: `c#${state}` }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect(exchanges).toHaveLength(1);
  });

  it('completion is bound to the principal AND the login session', async () => {
    const { sessionId, state } = await startConnect();
    // another user
    expect(
      (await as(bob, '/api/providers/oauth/complete').send({ sessionId, pasted: `c#${state}` }))
        .status,
    ).toBe(422);
    // same user, different login session (different session cookie)
    const s2 = await startConnect();
    const other = await request(server)
      .post('/api/providers/oauth/complete')
      .set('x-test-user', alice)
      .set('Cookie', 'session_token=DIFFERENT')
      .send({ sessionId: s2.sessionId, pasted: `c#${s2.state}` });
    expect(other.status).toBe(422);
    expect(exchanges).toHaveLength(0);
  });

  it('test-connection resolves through the oauth seam (authScheme + beta threaded); a dead grant surfaces distinctly', async () => {
    const { sessionId, state } = await startConnect();
    const created = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: `c#${state}`,
    });
    const test = await request(server)
      .post(`/api/providers/${created.body.id}/test-connection`)
      .set('x-test-user', alice);
    expect(test.body.ok).toBe(true);
    // The factory received the RESOLVED oauth credential + scheme + preset beta value.
    expect(factoryConfigs).toHaveLength(1);
    expect(factoryConfigs[0]).toMatchObject({
      credential: 'at-e2e-1',
      authScheme: 'oauth_bearer',
      oauthBeta: 'oauth-2025-04-20',
      kind: 'subscription',
    });
    // A durable dead grant fails locally and surfaces the DISTINCT reauthorize message.
    await pool.query("UPDATE provider SET credential_error = 'reauthorize_required' WHERE id = $1", [
      created.body.id,
    ]);
    const dead = await request(server)
      .post(`/api/providers/${created.body.id}/test-connection`)
      .set('x-test-user', alice);
    expect(dead.body.ok).toBe(false);
    expect(dead.body.kind).toBe('credential');
    expect(dead.body.message).toBe('credential needs reauthorization');
    expect(exchanges).toHaveLength(1); // the connect exchange only — no IdP call for the dead grant
  });

  it('the REAL transport sends Bearer + beta and NO x-api-key for an oauth_bearer adapter', async () => {
    // Direct adapter build over the real undici transport against the local upstream
    // (kind 'local' only loosens the loopback SSRF rule; headers are scheme-driven).
    const { createAnthropicProviderAdapter } = await import('@polyrouter/data-plane');
    const adapter = createAnthropicProviderAdapter({
      protocol: 'anthropic_compatible',
      baseUrl: upstreamBase,
      credential: 'at-e2e-1',
      kind: 'local',
      mode: 'selfhosted',
      authScheme: 'oauth_bearer',
      oauthBeta: 'oauth-2025-04-20',
      defaultMaxOutputTokens: 128,
    });
    await adapter.listModels();
    expect(upstreamHeaders.length).toBeGreaterThan(0);
    const h = upstreamHeaders[0]!;
    expect(h['authorization']).toBe('Bearer at-e2e-1');
    expect(h['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(h['x-api-key']).toBeUndefined();
  });

  it('reauthorize renews in place; a stale completion after credential clear writes nothing', async () => {
    const { sessionId, state } = await startConnect();
    const created = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: `c#${state}`,
    });
    const id = created.body.id;
    // Simulate a dead grant (durable state), then reauthorize.
    await pool.query("UPDATE provider SET credential_error = 'reauthorize_required' WHERE id = $1", [id]);
    const re = await as(alice, `/api/providers/oauth/reauthorize/${id}`).send({});
    expect(re.status).toBe(200);
    const reState = new URL(re.body.authorizeUrl).searchParams.get('state')!;
    nextTokens = () =>
      Promise.resolve({
        accessToken: 'at-e2e-2',
        refreshToken: 'rt-e2e-2',
        expiresAt: Date.now() + 3_600_000,
      });
    const done = await as(alice, '/api/providers/oauth/complete').send({
      sessionId: re.body.sessionId,
      pasted: `c2#${reState}`,
    });
    expect(done.status).toBe(200);
    expect(done.body.id).toBe(id); // same row
    expect(done.body.credentialError).toBeNull();
    // Stale path: start a reauthorize, clear the credential via PATCH, then complete.
    const re2 = await as(alice, `/api/providers/oauth/reauthorize/${id}`).send({});
    const re2State = new URL(re2.body.authorizeUrl).searchParams.get('state')!;
    await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ credential: '' })
      .expect(200);
    const stale = await as(alice, '/api/providers/oauth/complete').send({
      sessionId: re2.body.sessionId,
      pasted: `c3#${re2State}`,
    });
    expect(stale.status).toBe(422); // provider changed — nothing restored
    const after = await pool.query<{ encrypted_credentials: string | null; oauth_preset: string | null }>(
      'SELECT encrypted_credentials, oauth_preset FROM provider WHERE id = $1',
      [id],
    );
    expect(after.rows[0]!.encrypted_credentials).toBeNull(); // the clear stands
    expect(after.rows[0]!.oauth_preset).toBeNull(); // metadata never outlives the envelope
  });

  it('editing an OAuth provider: endpoint drift is rejected; credential replace clears metadata', async () => {
    const { sessionId, state } = await startConnect();
    const created = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: `c#${state}`,
    });
    const id = created.body.id;
    // base_url drift while the OAuth envelope is retained → 422
    const drift = await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ baseUrl: 'https://2.2.2.2/v1' });
    expect(drift.status).toBe(422);
    // name-only edit is fine
    await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ name: 'renamed' })
      .expect(200);
    // replacing the credential converts to plain and clears the OAuth metadata
    const replaced = await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ credential: 'sk-manual' });
    expect(replaced.status).toBe(200);
    expect(replaced.body.oauthPreset).toBeNull();
    expect(replaced.body.credentialExpiresAt).toBeNull();
  });

  it('FORGERY: a pasted polycred marker via create stays a plain credential', async () => {
    const forged = `polycred:v1:{"v":1,"kind":"oauth","preset":"stub-claude","accessToken":"x","refreshToken":"y","expiresAt":9999999999999}`;
    const res = await request(server)
      .post('/api/providers')
      .set('x-test-user', alice)
      .send({
        name: 'forge',
        kind: 'subscription',
        protocol: 'anthropic_compatible',
        baseUrl: preset.baseUrl,
        credential: forged,
      });
    expect(res.status).toBe(201);
    expect(res.body.oauthPreset).toBeNull(); // never becomes OAuth-connected
    const rows = await pool.query<{ encrypted_credentials: string }>(
      'SELECT encrypted_credentials FROM provider WHERE id = $1',
      [res.body.id],
    );
    const parsed = parseCredentialEnvelope(decryptSecret(rows.rows[0]!.encrypted_credentials, KEY));
    expect(parsed.kind).toBe('plain'); // wrapped — the lookalike is an opaque string
    expect(parsed.kind === 'plain' && parsed.value).toBe(forged);
  });

  it('a bundled-models preset seeds the preset list and never masks an auth failure (codex r3)', async () => {
    const start = await as(alice, '/api/providers/oauth/start').send({ preset: 'stub-bundled' });
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const created = await as(alice, '/api/providers/oauth/complete').send({
      sessionId: start.body.sessionId,
      pasted: `c#${state}`,
    });
    expect(created.status).toBe(200);
    const id = created.body.id;
    // sync-models seeds the bundled list — no models endpoint involved.
    const sync = await request(server)
      .post(`/api/providers/${id}/sync-models`)
      .set('x-test-user', alice);
    expect(sync.body.synced).toBe(2);
    const models = await request(server)
      .get(`/api/models?providerId=${id}`)
      .set('x-test-user', alice);
    expect(models.body.map((m: { externalModelId: string }) => m.externalModelId).sort()).toEqual([
      'bundled-model-a',
      'bundled-model-b',
    ]);
    // test-connection uses the DESIGNATED validating probe (a chat call).
    const ok = await request(server)
      .post(`/api/providers/${id}/test-connection`)
      .set('x-test-user', alice);
    expect(ok.body.ok).toBe(true);
    // A revoked/invalid credential surfaces as a typed auth failure — never masked.
    const { ProviderError } = await import('@polyrouter/data-plane');
    nextChat = () => Promise.reject(new ProviderError('auth', 'denied'));
    const dead = await request(server)
      .post(`/api/providers/${id}/test-connection`)
      .set('x-test-user', alice);
    expect(dead.body.ok).toBe(false);
    expect(dead.body.kind).toBe('auth');
    // Name-only PATCH on the ROOT-canonical preset URL succeeds (no false drift 422).
    await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ name: 'renamed-bundled' })
      .expect(200);
  });

  it('cross-tenant reauthorize fails closed', async () => {
    const { sessionId, state } = await startConnect();
    const created = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: `c#${state}`,
    });
    expect(
      (await as(bob, `/api/providers/oauth/reauthorize/${created.body.id}`).send({})).status,
    ).toBe(404);
  });

  // ---- ChatGPT Responses preset (add-chatgpt-responses) ----

  async function startChatgpt(): Promise<{ sessionId: string; state: string }> {
    const res = await as(alice, '/api/providers/oauth/start').send({ preset: 'stub-chatgpt' });
    expect(res.status).toBe(200);
    const state = new URL(res.body.authorizeUrl).searchParams.get('state')!;
    return { sessionId: res.body.sessionId, state };
  }
  const pasteUrl = (state: string, code = 'gpt-code'): string =>
    `http://localhost:1455/auth/callback?code=${code}&state=${state}`;

  async function connectChatgpt(): Promise<string> {
    nextTokens = () => Promise.resolve(chatgptTokens());
    const { sessionId, state } = await startChatgpt();
    const res = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: pasteUrl(state),
    });
    expect(res.status).toBe(200);
    return res.body.id as string;
  }

  it('CHATGPT connects: Responses row, account id sealed in the envelope, form+exchange wire', async () => {
    nextTokens = () => Promise.resolve(chatgptTokens());
    const { sessionId, state } = await startChatgpt();
    const res = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: pasteUrl(state),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'subscription',
      protocol: 'openai_responses',
      oauthPreset: 'stub-chatgpt',
      baseUrl: 'https://2.2.2.2/',
      hasCredential: true,
    });
    // The account id appears in NO response — envelope-only (asserted via decrypt).
    expect(JSON.stringify(res.body)).not.toContain('acct-e2e-77');
    const rows = await pool.query<{ encrypted_credentials: string }>(
      'SELECT encrypted_credentials FROM provider WHERE id = $1',
      [res.body.id],
    );
    const parsed = parseCredentialEnvelope(decryptSecret(rows.rows[0]!.encrypted_credentials, KEY));
    expect(parsed.kind === 'oauth' && parsed.cred.accountId).toBe('acct-e2e-77');
    // The stub IdP saw the preset-declared wire: form encoding, exchange grant, PKCE.
    expect(exchangeInputs).toHaveLength(1);
    expect(exchangeInputs[0]).toMatchObject({ encoding: 'form', grant: 'exchange' });
    expect(exchanges[0]).toMatchObject({ grant_type: 'authorization_code', code: 'gpt-code' });
    // auth.openai.com rejects unknown params — the exchange body must NOT carry state.
    expect('state' in exchanges[0]!).toBe(false);
  });

  it('CHATGPT: a missing or invalid id_token claim fails typed with NOTHING written', async () => {
    // Exchange without an id_token at all.
    nextTokens = () =>
      Promise.resolve({
        accessToken: 'at-e2e-1',
        refreshToken: 'rt-e2e-1',
        expiresAt: Date.now() + 3_600_000,
      });
    const first = await startChatgpt();
    const noToken = await as(alice, '/api/providers/oauth/complete').send({
      sessionId: first.sessionId,
      pasted: pasteUrl(first.state),
    });
    expect(noToken.status).toBe(422);
    // Wrongly nested claim (top-level, not under the auth claim object).
    nextTokens = () =>
      Promise.resolve(
        chatgptTokens({
          idToken: `${b64url({ alg: 'RS256' })}.${b64url({ chatgpt_account_id: 'acct-x' })}.sig`,
        }),
      );
    const second = await startChatgpt();
    const badClaim = await as(alice, '/api/providers/oauth/complete').send({
      sessionId: second.sessionId,
      pasted: pasteUrl(second.state),
    });
    expect(badClaim.status).toBe(422);
    const count = await pool.query('SELECT count(*)::int c FROM provider WHERE owner_user_id = $1', [
      alice,
    ]);
    expect(count.rows[0].c).toBe(0); // nothing written by either failure
  });

  it('CHATGPT refresh: an omitted refresh_token is retained, the account id survives, and the factory gets accountId+probeModel', async () => {
    // Connect with a NEAR-EXPIRY token so the next resolution refreshes.
    nextTokens = () => Promise.resolve(chatgptTokens({ expiresAt: Date.now() + 60_000 }));
    const { sessionId, state } = await startChatgpt();
    const created = await as(alice, '/api/providers/oauth/complete').send({
      sessionId,
      pasted: pasteUrl(state),
    });
    expect(created.status).toBe(200);
    // The refresh response omits refresh_token AND id_token (non-rotating endpoint).
    nextTokens = () =>
      Promise.resolve({ accessToken: 'at-e2e-2', expiresAt: Date.now() + 3_600_000 });
    const test = await request(server)
      .post(`/api/providers/${created.body.id}/test-connection`)
      .set('x-test-user', alice);
    expect(test.body.ok).toBe(true);
    expect(exchangeInputs.at(-1)).toMatchObject({ encoding: 'form', grant: 'refresh' });
    // Rotated envelope: new access token, RETAINED refresh token + account id.
    const rows = await pool.query<{ encrypted_credentials: string }>(
      'SELECT encrypted_credentials FROM provider WHERE id = $1',
      [created.body.id],
    );
    const parsed = parseCredentialEnvelope(decryptSecret(rows.rows[0]!.encrypted_credentials, KEY));
    expect(parsed.kind).toBe('oauth');
    if (parsed.kind === 'oauth') {
      expect(parsed.cred.accessToken).toBe('at-e2e-2');
      expect(parsed.cred.refreshToken).toBe('rt-e2e-1'); // omission retention
      expect(parsed.cred.accountId).toBe('acct-e2e-77'); // survives rotation
    }
    // The adapter build received the TRUSTED threading (never user input).
    expect(factoryConfigs.at(-1)).toMatchObject({
      credential: 'at-e2e-2',
      authScheme: 'oauth_bearer',
      oauthAccountId: 'acct-e2e-77',
      probeModel: 'gpt-5',
    });
  });

  it('CHATGPT: bundled sync seeds the preset models; manual create/update with the protocol is rejected; name-only edit works', async () => {
    const id = await connectChatgpt();
    // sync-models seeds the bundled list.
    const sync = await request(server)
      .post(`/api/providers/${id}/sync-models`)
      .set('x-test-user', alice);
    expect(sync.body.synced).toBe(2);
    const models = await request(server)
      .get(`/api/models?providerId=${id}`)
      .set('x-test-user', alice);
    expect(models.body.map((m: { externalModelId: string }) => m.externalModelId).sort()).toEqual([
      'gpt-5',
      'gpt-5-codex',
    ]);
    // Manual create with the upstream-only protocol: rejected by the public DTO enum.
    const create = await request(server)
      .post('/api/providers')
      .set('x-test-user', alice)
      .send({
        name: 'hand-rolled',
        kind: 'subscription',
        protocol: 'openai_responses',
        baseUrl: 'https://2.2.2.2/',
        credential: 'sk-x',
      });
    expect([400, 422]).toContain(create.status);
    // Explicitly supplying it on an update is rejected the same way.
    const explicit = await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ protocol: 'openai_responses' });
    expect([400, 422]).toContain(explicit.status);
    // Moving a DIFFERENT provider onto it is impossible for the same reason.
    // A name-only edit on the connected row succeeds (retention-by-omission).
    const renamed = await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ name: 'my chatgpt' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.protocol).toBe('openai_responses'); // retained
  });

  it('CHATGPT: credential rotate/clear is rejected — the row cannot be wedged and stays reauthorizable', async () => {
    const id = await connectChatgpt();
    // Rotate AND clear both rejected before any write (r3 finding 3).
    const rotate = await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ credential: 'sk-manual' });
    expect(rotate.status).toBe(422);
    const clear = await request(server)
      .patch(`/api/providers/${id}`)
      .set('x-test-user', alice)
      .send({ credential: '' });
    expect(clear.status).toBe(422);
    // Envelope + preset untouched by the rejected edits.
    const before = await pool.query<{ oauth_preset: string | null; encrypted_credentials: string | null }>(
      'SELECT oauth_preset, encrypted_credentials FROM provider WHERE id = $1',
      [id],
    );
    expect(before.rows[0]!.oauth_preset).toBe('stub-chatgpt');
    expect(before.rows[0]!.encrypted_credentials).not.toBeNull();
    // And the row remains fully REAUTHORIZABLE end-to-end.
    const re = await as(alice, `/api/providers/oauth/reauthorize/${id}`).send({});
    expect(re.status).toBe(200);
    const reState = new URL(re.body.authorizeUrl).searchParams.get('state')!;
    nextTokens = () => Promise.resolve(chatgptTokens({ accessToken: 'at-e2e-3' }));
    const done = await as(alice, '/api/providers/oauth/complete').send({
      sessionId: re.body.sessionId,
      pasted: pasteUrl(reState, 'gpt-code-2'),
    });
    expect(done.status).toBe(200);
    expect(done.body.id).toBe(id); // same row, renewed in place
    const after = await pool.query<{ encrypted_credentials: string }>(
      'SELECT encrypted_credentials FROM provider WHERE id = $1',
      [id],
    );
    const parsed = parseCredentialEnvelope(decryptSecret(after.rows[0]!.encrypted_credentials, KEY));
    expect(parsed.kind === 'oauth' && parsed.cred.accessToken).toBe('at-e2e-3');
    expect(parsed.kind === 'oauth' && parsed.cred.accountId).toBe('acct-e2e-77');
  });

  it('CHATGPT REAL wire: exactly the three identity headers, no fingerprints, store:false; stream + 401 probe', async () => {
    // A local Responses-shaped upstream. VERIFIED LIVE: the wire is STREAMING-ONLY
    // (buffered chat() folds the SSE), and rejects max_output_tokens/sampling.
    const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    const okSse = (): string => {
      const frames = [
        { type: 'response.created', response: { id: 'r1', model: 'gpt-5.4-mini' } },
        { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'Hel' },
        { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'lo' },
        { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } },
      ];
      return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
    };
    let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void = (
      _req,
      res,
    ) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(okSse());
    };
    const respUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        handler(req, res, body);
      });
    });
    await new Promise<void>((r) => respUpstream.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${String((respUpstream.address() as AddressInfo).port)}`;
    try {
      const { createResponsesProviderAdapter, ProviderError } = await import('@polyrouter/data-plane');
      const adapter = createResponsesProviderAdapter({
        protocol: 'openai_responses',
        baseUrl: base,
        credential: 'at-e2e-1',
        kind: 'local', // loosens only the loopback SSRF rule; headers are scheme-driven
        mode: 'selfhosted',
        authScheme: 'oauth_bearer',
        oauthAccountId: 'acct-e2e-77',
        probeModel: 'gpt-5.4-mini',
      });
      // Buffered chat over the REAL transport — rides the streaming wire.
      const res = await adapter.chat({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        params: { maxOutputTokens: 128, temperature: 0.2 }, // IR-level no-ops on this wire
      });
      expect(res.content).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
      const first = seen[0]!;
      expect(first.headers['authorization']).toBe('Bearer at-e2e-1');
      expect(first.headers['chatgpt-account-id']).toBe('acct-e2e-77');
      expect(first.headers['openai-beta']).toBe('responses=experimental');
      // The fingerprint ABSENCES (no-spoofing rule) + no cross-protocol bleed.
      expect(first.headers['x-api-key']).toBeUndefined();
      expect(first.headers['originator']).toBeUndefined();
      expect(first.headers['session_id']).toBeUndefined();
      expect(first.headers['anthropic-version']).toBeUndefined();
      expect(first.headers['anthropic-beta']).toBeUndefined();
      const wire = JSON.parse(first.body) as Record<string, unknown>;
      expect(wire['store']).toBe(false); // ALWAYS
      expect(wire['stream']).toBe(true); // streaming-only wire (verified live)
      expect(wire['model']).toBe('gpt-5.4-mini');
      expect('max_output_tokens' in wire).toBe(false); // wire-rejected (verified live)
      expect('temperature' in wire).toBe(false);
      // Streamed lifecycle translating to a client-visible completion.
      let text = '';
      let sawStop = false;
      for await (const ev of adapter.chatStream({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        params: {},
      })) {
        if (ev.type === 'text_delta') text += ev.text;
        if (ev.type === 'message_stop') sawStop = true;
      }
      expect(text).toBe('Hello');
      expect(sawStop).toBe(true);
      // listModels is typed-unsupported (bundled sourcing) — no request is made.
      await expect(adapter.listModels()).rejects.toBeInstanceOf(ProviderError);
      // The designated probe surfaces a revoked credential as typed auth.
      handler = (_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"invalid_token"}');
      };
      const dead = await adapter.testConnection();
      expect(dead.ok).toBe(false);
      if (!dead.ok) expect(dead.kind).toBe('auth');
      const probeWire = JSON.parse(seen.at(-1)!.body) as Record<string, unknown>;
      expect(probeWire['model']).toBe('gpt-5.4-mini'); // the preset probe model
      expect(probeWire['stream']).toBe(true);
      expect('max_output_tokens' in probeWire).toBe(false);
    } finally {
      respUpstream.close();
    }
  });
});
