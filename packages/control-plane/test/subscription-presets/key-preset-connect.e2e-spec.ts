// add-key-subscription-presets e2e (tasks 5.2/5.3): the list + connect endpoints over real
// HTTP + Postgres. Most blocks shape the offered regions through
// `.overrideProvider(KEY_PRESET_LOOKUP)` (as oauth-connect.e2e does for OAUTH_PRESET_LOOKUP)
// with a registry built from the BUNDLED pins, so `keyPresetForRow` still matches the rows
// these tests create. The last block (redesign-subscription-picker task 1.4) boots the SHIPPED
// registry with no override. Nothing here calls a provider: the adapter factory is a spy that
// must stay at zero. The pinned URLs go through the real SSRF gate, which only
// RESOLVES their hostnames (DNS), never connects.
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
import { decryptSecret, parseCredentialEnvelope, userPrincipal } from '@polyrouter/shared/server';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.setup';
import { SessionGuard } from '../../src/auth/session.guard';
import { AUTH_INSTANCE } from '../../src/auth/auth.tokens';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { DatabaseModule } from '../../src/database/database.module';
import { ProvidersModule } from '../../src/providers/providers.module';
import {
  PROVIDER_ADAPTER_FACTORY,
  type ProviderAdapterFactory,
} from '../../src/providers/providers.service';
import {
  KEY_PRESETS,
  KEY_PRESET_LOOKUP,
  KIMI_CODE_PRESET,
  MINIMAX_M_PLAN_PRESET,
  OPENCODE_GO_PRESET,
  ZAI_CODING_PLAN_PRESET,
  type KeyPreset,
  type KeyPresetRegion,
  type KeyPresetRegistry,
} from '../../src/subscription-presets/key-presets';
import { SubscriptionPresetsModule } from '../../src/subscription-presets/subscription-presets.module';
import { uniqueEmail } from '../auth/auth-harness';
import { COMPOSE_HINT } from '../tenancy/harness';
import '../../src/providers/providers.config';
import '../../src/database/database.config';
import '../../src/redis/redis.config';
import '../../src/auth/auth.config';

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

/** A copy of `preset` whose regions start WITHDRAWN (`enabled: false`) and take the given
 * overrides, so each fixture names exactly the regions it offers (the pins stay the bundled
 * ones). The shipped constants are all enabled; the last block tests them as shipped. */
function withRegions(
  preset: KeyPreset,
  flags: Readonly<Record<string, Partial<KeyPresetRegion>>>,
): KeyPreset {
  return {
    ...preset,
    regions: preset.regions.map((r) => ({ ...r, enabled: false, ...(flags[r.id] ?? {}) })),
  };
}
const ON = { enabled: true };

/** The default test registry: OpenCode Go; MiniMax international only (China disabled);
 * Kimi with both regions; Z.ai international only. */
function defaultRegistry(): KeyPreset[] {
  return [
    withRegions(OPENCODE_GO_PRESET, { default: ON }),
    withRegions(MINIMAX_M_PLAN_PRESET, { intl: ON }),
    withRegions(KIMI_CODE_PRESET, { intl: ON, cn: ON }),
    withRegions(ZAI_CODING_PLAN_PRESET, { intl: ON }),
  ];
}
let current: KeyPreset[] = defaultRegistry();
const testRegistry: KeyPresetRegistry = {
  find: (id) => current.find((p) => p.id === id),
  list: () => current,
};

let factoryCalls = 0;
const spyFactory = ((): never => {
  factoryCalls += 1;
  throw new Error('no provider adapter may be built by a key-preset connect');
}) as unknown as ProviderAdapterFactory;

describe('key-preset connect and list (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let alice: string;
  let bob: string;

  const mkUser = async (): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'u', $1, false) RETURNING id`,
        [uniqueEmail('kp')],
      )
    ).rows[0]!.id;
  const providerCount = async (): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>(
          'SELECT count(*) AS n FROM provider WHERE owner_user_id = ANY($1)',
          [[alice, bob]],
        )
      ).rows[0]!.n,
    );

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
    const moduleRef = await Test.createTestingModule({
      imports: [ProvidersModule, SubscriptionPresetsModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    })
      .overrideProvider(PROVIDER_ADAPTER_FACTORY)
      .useValue(spyFactory)
      .overrideProvider(KEY_PRESET_LOOKUP)
      .useValue(testRegistry)
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
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM provider WHERE owner_user_id = ANY($1)', [[alice, bob]]);
    current = defaultRegistry();
    factoryCalls = 0;
  });
  afterEach(() => {
    // The connect path never builds an adapter, so it can never reach a provider.
    expect(factoryCalls).toBe(0);
  });

  const connect = (body: unknown, user = alice): request.Test =>
    request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-test-user', user)
      .send(body as object);
  const available = (user = alice): request.Test =>
    request(server).get('/api/providers/key-presets/available').set('x-test-user', user);
  const row = async (id: string): Promise<Record<string, unknown>> =>
    (await pool.query('SELECT * FROM provider WHERE id = $1', [id])).rows[0] as Record<
      string,
      unknown
    >;

  it('creates the pinned row; the stored envelope decrypts to a plain credential', async () => {
    const res = await connect({ preset: 'opencode-go', credential: 'ocg-secret-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'OpenCode Go',
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      keyPreset: 'opencode-go',
      oauthPreset: null,
      hasCredential: true,
    });
    const stored = await row(res.body.id as string);
    expect(stored).toMatchObject({
      kind: 'subscription',
      base_url: 'https://opencode.ai/inference/go/openai/v1',
      protocol: 'openai_compatible',
      key_preset: 'opencode-go',
      oauth_preset: null,
      imitate_client_identity: false,
      owner_user_id: alice,
    });
    const envelope = stored['encrypted_credentials'] as string;
    expect(envelope).toMatch(/^poly-enc:/);
    expect(envelope).not.toContain('ocg-secret-1');
    expect(parseCredentialEnvelope(decryptSecret(envelope, KEY))).toEqual({
      kind: 'plain',
      value: 'ocg-secret-1',
    });
  });

  it('answers no-store with no key, imitation off, and no client identity for OpenCode Go and MiniMax', async () => {
    for (const body of [
      { preset: 'opencode-go', credential: 'sk-no-echo-1' },
      { preset: 'minimax-m-plan', credential: 'sk-no-echo-2' },
    ]) {
      const res = await connect(body);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.imitateClientIdentity).toBe(false);
      expect(res.body.clientIdentity).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(body.credential);
      expect(JSON.stringify(res.body)).not.toMatch(/encrypted/i);
    }
  });

  it('a Kimi or Z.ai connect names the Claude Code identity label, with imitation off and no header value', async () => {
    // Design D7 step 6: the safe view carries the availability LABEL (so the SPA can show
    // the Edit switch without a reload) and never a header name or value; a new row without
    // the opt-in starts with the switch off.
    for (const body of [
      { preset: 'kimi-code', region: 'intl', credential: 'sk-kimi-id-1' },
      { preset: 'kimi-code', region: 'cn', credential: 'sk-kimi-id-2' },
      {
        preset: 'zai-coding-plan',
        region: 'intl',
        credential: 'zai-id-3',
        acknowledgeTermsRisk: true,
      },
    ]) {
      const res = await connect(body);
      expect(res.status).toBe(200);
      expect(res.body.clientIdentity).toEqual({ label: 'Claude Code' });
      expect(res.body.imitateClientIdentity).toBe(false);
      expect((await row(res.body.id as string))['imitate_client_identity']).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(
        /claude-code\/|claude-cli|User-Agent|apiHeaders/i,
      );
    }
  });

  it('an opted-in Kimi or Z.ai connect creates the provider with the switch on (add-key-preset-identity-optin)', async () => {
    for (const body of [
      {
        preset: 'kimi-code',
        region: 'intl',
        credential: 'sk-kimi-opt-1',
        imitateClientIdentity: true,
      },
      {
        preset: 'zai-coding-plan',
        region: 'intl',
        credential: 'zai-opt-2',
        acknowledgeTermsRisk: true,
        imitateClientIdentity: true,
      },
    ]) {
      const res = await connect(body);
      expect(res.status).toBe(200);
      expect(res.body.imitateClientIdentity).toBe(true);
      expect(res.body.clientIdentity).toEqual({ label: 'Claude Code' });
      expect((await row(res.body.id as string))['imitate_client_identity']).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/claude-code\/|claude-cli|User-Agent/i);
    }
    const off = await connect({
      preset: 'kimi-code',
      region: 'intl',
      credential: 'sk-kimi-opt-3',
      imitateClientIdentity: false,
    });
    expect(off.body.imitateClientIdentity).toBe(false);
  });

  describe('invalid input writes nothing', () => {
    const bad: ReadonlyArray<readonly [string, unknown, number | readonly number[]]> = [
      ['an unknown preset', { preset: 'nope', credential: 'k' }, 422],
      ['no region while two are offered', { preset: 'kimi-code', credential: 'k' }, 422],
      ['an unknown region', { preset: 'kimi-code', region: 'mars', credential: 'k' }, 422],
      ['a disabled region', { preset: 'minimax-m-plan', region: 'cn', credential: 'k' }, 422],
      ['an empty key', { preset: 'opencode-go', credential: '' }, 400],
      ['a missing key', { preset: 'opencode-go' }, 400],
      ['an over-8192 key', { preset: 'opencode-go', credential: 'x'.repeat(8193) }, 400],
      ['a newline in the key', { preset: 'opencode-go', credential: 'a\nb' }, 400],
      ['a NUL in the key', { preset: 'opencode-go', credential: 'a\u0000b' }, 400],
      [
        'a baseUrl field',
        { preset: 'opencode-go', credential: 'k', baseUrl: 'https://evil.example/v1' },
        400,
      ],
      [
        'a protocol field',
        { preset: 'opencode-go', credential: 'k', protocol: 'anthropic_compatible' },
        400,
      ],
      ['a kind field', { preset: 'opencode-go', credential: 'k', kind: 'api_key' }, 400],
      [
        'a keyPreset field',
        { preset: 'opencode-go', credential: 'k', keyPreset: 'zai-coding-plan' },
        400,
      ],
      // add-key-preset-identity-optin: the opt-in is a boolean the connect accepts, so a null
      // is a 400 and an opt-in the preset cannot honour is a 422; header fields stay unknown.
      [
        'a null imitation opt-in',
        { preset: 'opencode-go', credential: 'k', imitateClientIdentity: null },
        400,
      ],
      [
        'an imitation opt-in for a preset that declares no identity',
        { preset: 'opencode-go', credential: 'k', imitateClientIdentity: true },
        422,
      ],
      [
        'a clientIdentity field',
        { preset: 'kimi-code', region: 'intl', credential: 'k', clientIdentity: { label: 'x' } },
        400,
      ],
      [
        'a userAgent field',
        { preset: 'kimi-code', region: 'intl', credential: 'k', userAgent: 'claude-code/1' },
        400,
      ],
      [
        'an extraHeaders field',
        { preset: 'kimi-code', region: 'intl', credential: 'k', extraHeaders: { a: 'b' } },
        400,
      ],
      ['an over-long name', { preset: 'opencode-go', credential: 'k', name: 'x'.repeat(81) }, 400],
    ];
    it.each(bad)('%s', async (_n, body, status) => {
      const res = await connect(body);
      expect(res.status).toBe(status);
      expect(await providerCount()).toBe(0);
    });

    it('a preset whose every region is disabled is refused', async () => {
      current = [withRegions(OPENCODE_GO_PRESET, {})];
      const res = await connect({ preset: 'opencode-go', credential: 'k' });
      expect(res.status).toBe(422);
      expect(await providerCount()).toBe(0);
    });
  });

  it('Z.ai needs the terms acknowledgement: 422 without (or false), 200 with', async () => {
    for (const extra of [{}, { acknowledgeTermsRisk: false }]) {
      const res = await connect({ preset: 'zai-coding-plan', credential: 'zk', ...extra });
      expect(res.status).toBe(422);
    }
    expect(await providerCount()).toBe(0);
    const ok = await connect({
      preset: 'zai-coding-plan',
      credential: 'zk',
      acknowledgeTermsRisk: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      keyPreset: 'zai-coding-plan',
    });
    // The acknowledgement is never stored.
    expect(JSON.stringify(await row(ok.body.id as string))).not.toMatch(/acknowledg/i);
  });

  it('lower-risk presets connect without the acknowledgement field', async () => {
    for (const body of [
      { preset: 'opencode-go', credential: 'k' },
      { preset: 'minimax-m-plan', credential: 'k' },
      { preset: 'kimi-code', region: 'intl', credential: 'k' },
    ]) {
      expect((await connect(body)).status).toBe(200);
    }
  });

  it('accepts a key without the hinted prefix', async () => {
    const res = await connect({ preset: 'kimi-code', region: 'intl', credential: 'not-sk-kimi' });
    expect(res.status).toBe(200);
  });

  it('stores a polycred:v1 lookalike as a plain credential', async () => {
    const lookalike = 'polycred:v1:{"v":1,"kind":"oauth","preset":"claude","accessToken":"a"}';
    const res = await connect({ preset: 'opencode-go', credential: lookalike });
    expect(res.status).toBe(200);
    const envelope = (await row(res.body.id as string))['encrypted_credentials'] as string;
    expect(parseCredentialEnvelope(decryptSecret(envelope, KEY))).toEqual({
      kind: 'plain',
      value: lookalike,
    });
  });

  it('names an unnamed connect after the preset, with the region label only when several are offered', async () => {
    const single = await connect({ preset: 'minimax-m-plan', credential: 'k' });
    expect(single.body.name).toBe('MiniMax M Plan'); // two registry regions, ONE offered
    const kimi = await connect({ preset: 'kimi-code', region: 'cn', credential: 'k' });
    expect(kimi.body.name).toBe('Kimi Code (China)');
    expect(kimi.body.baseUrl).toBe('https://api.kimi.com/coding/v1');
    const named = await connect({
      preset: 'kimi-code',
      region: 'intl',
      name: 'mine',
      credential: 'k',
    });
    expect(named.body.name).toBe('mine');
  });

  it('a disabled preset or region is absent from the list and refused on connect', async () => {
    current = [
      withRegions(OPENCODE_GO_PRESET, {}), // disabled
      withRegions(KIMI_CODE_PRESET, { intl: ON }), // cn disabled
    ];
    const list = await available();
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map((p) => p.id)).toEqual(['kimi-code']);
    expect(list.body[0].regions.map((r: { id: string }) => r.id)).toEqual(['intl']);
    expect((await connect({ preset: 'opencode-go', credential: 'k' })).status).toBe(422);
    expect((await connect({ preset: 'kimi-code', region: 'cn', credential: 'k' })).status).toBe(
      422,
    );
    expect(await providerCount()).toBe(0);
  });

  it('withdrawing a region hides it and refuses new connects; an existing row keeps working (redesign-subscription-picker 1.4)', async () => {
    const before = await connect({ preset: 'kimi-code', region: 'cn', credential: 'k' });
    expect(before.status).toBe(200);
    const id = before.body.id as string;
    current = [withRegions(KIMI_CODE_PRESET, { intl: ON })]; // cn withdrawn after the connect
    const list = await available();
    expect(list.body[0].regions.map((r: { id: string }) => r.id)).toEqual(['intl']);
    const refused = await connect({ preset: 'kimi-code', region: 'cn', credential: 'k' });
    expect(refused.status).toBe(422);
    expect(await providerCount()).toBe(1);
    const still = await request(server).get(`/api/providers/${id}`).set('x-test-user', alice);
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({
      keyPreset: 'kimi-code',
      baseUrl: 'https://api.kimi.com/coding/v1',
      hasCredential: true,
    });
  });

  it('a two-region preset with one offered region: listed with one, connect without region pins it, no label', async () => {
    const list = await available();
    const minimax = (list.body as Array<{ id: string; regions: unknown[] }>).find(
      (p) => p.id === 'minimax-m-plan',
    )!;
    expect(minimax.regions).toEqual([
      { id: 'intl', label: 'International', host: 'api.minimax.io', imitationRequired: false },
    ]);
    const res = await connect({ preset: 'minimax-m-plan', credential: 'k' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      baseUrl: 'https://api.minimax.io/v1',
      name: 'MiniMax M Plan',
    });
    const named = await connect({ preset: 'minimax-m-plan', region: 'intl', credential: 'k' });
    expect(named.body).toMatchObject({
      baseUrl: 'https://api.minimax.io/v1',
      name: 'MiniMax M Plan',
    });
  });

  it('an enabled imitation-required region is listed as such and needs the acknowledgement', async () => {
    current = [
      withRegions(OPENCODE_GO_PRESET, { default: { enabled: true, imitationRequired: true } }),
    ];
    const list = await available();
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      id: 'opencode-go',
      termsRisk: 'high',
      requiresAcknowledgement: true,
    });
    expect(list.body[0].regions[0].imitationRequired).toBe(true);
    const refused = await connect({ preset: 'opencode-go', credential: 'k' });
    expect(refused.status).toBe(422);
    expect(await providerCount()).toBe(0);
    const ok = await connect({
      preset: 'opencode-go',
      credential: 'k',
      acknowledgeTermsRisk: true,
    });
    expect(ok.status).toBe(200);
    // A key-preset connect always starts with imitation off.
    expect(ok.body.imitateClientIdentity).toBe(false);
  });

  it('stores a region-declared max-tokens spelling, and auto where none is declared', async () => {
    current = [
      withRegions(OPENCODE_GO_PRESET, {
        default: { enabled: true, maxTokensSpelling: 'max_tokens' },
      }),
      withRegions(KIMI_CODE_PRESET, { intl: ON }),
    ];
    const declared = await connect({ preset: 'opencode-go', credential: 'k' });
    expect(declared.body.maxTokensSpelling).toBe('max_tokens');
    expect((await row(declared.body.id as string))['max_tokens_spelling']).toBe('max_tokens');
    const none = await connect({ preset: 'kimi-code', credential: 'k' });
    expect(none.body.maxTokensSpelling).toBe('auto');
    expect((await row(none.body.id as string))['max_tokens_spelling']).toBe('auto');
  });

  describe('the list is display-safe, principal-independent and session-only', () => {
    it('carries exactly the display fields, host-only regions and no listing URL or identity', async () => {
      const res = await available();
      expect(res.status).toBe(200);
      const list = res.body as Array<Record<string, unknown>>;
      expect(list.map((p) => p['id'])).toEqual([
        'opencode-go',
        'minimax-m-plan',
        'kimi-code',
        'zai-coding-plan',
      ]);
      for (const p of list) {
        expect(Object.keys(p).sort()).toEqual(
          [
            'clientIdentityLabel',
            'declaresIdentity',
            'displayName',
            'id',
            'keyHint',
            'regions',
            'requiresAcknowledgement',
            'riskCopy',
            'termsRisk',
            'termsUrl',
          ].sort(),
        );
      }
      const json = JSON.stringify(list);
      expect(json).not.toContain('inference/go/v1/models');
      // The `clientIdentityLabel` display name is allowed (add-key-preset-identity-optin D3); an
      // identity object, header name or value, or a credential is not.
      expect(json).not.toMatch(
        /"clientIdentity"|apiHeaders|User-Agent|credential|claude-c(?:ode|li)\//i,
      );
      // Kimi and Z.ai DO declare an identity in this registry (7.1): no header value of it is
      // listed, only its display label, and only as `clientIdentityLabel`.
      expect(KIMI_CODE_PRESET.clientIdentity).toBeDefined();
      expect(ZAI_CODING_PLAN_PRESET.clientIdentity).toBeDefined();
      expect(json).not.toMatch(/claude-code\/|claude-cli/);
      expect(json.match(/Claude Code/g) ?? []).toHaveLength(
        list.filter((p) => p['clientIdentityLabel'] === 'Claude Code').length,
      );
      // The only URLs are the terms links.
      const urls = json.match(/https?:\/\/[^"\s]+/g) ?? [];
      const terms = KEY_PRESETS.map((p) => p.termsUrl);
      expect(urls.filter((u) => !terms.includes(u))).toEqual([]);
      expect(list.find((p) => p['id'] === 'zai-coding-plan')).toMatchObject({
        termsRisk: 'high',
        requiresAcknowledgement: true,
      });
      expect(list.find((p) => p['id'] === 'kimi-code')).toMatchObject({
        termsRisk: 'medium',
        requiresAcknowledgement: false,
      });
    });

    it('two principals of different tenants receive equal lists', async () => {
      const [a, b] = await Promise.all([available(alice), available(bob)]);
      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
    });
  });

  it('answers as key-preset routes and is never taken for a provider id', async () => {
    const list = await available();
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    // The one-segment path is the provider-id route, which 404s for a non-id.
    const asId = await request(server).get('/api/providers/key-presets').set('x-test-user', alice);
    expect(asId.status).toBe(404);
    const res = await connect({ preset: 'opencode-go', credential: 'k' });
    expect(res.status).toBe(200);
    expect(res.body.keyPreset).toBe('opencode-go');
  });

  it('never writes the pasted key to any log, accepted or rejected', async () => {
    const secret = 'sk-LOGCHECK-9f3a7c1e5b';
    const chunks: string[] = [];
    const spies = [jest.spyOn(process.stdout, 'write'), jest.spyOn(process.stderr, 'write')].map(
      (s) =>
        s.mockImplementation(((c: unknown) => {
          chunks.push(String(c));
          return true;
        }) as never),
    );
    const consoleSpies = (['log', 'warn', 'error', 'debug', 'info'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        chunks.push(a.map(String).join(' '));
      }),
    );
    try {
      const results = [
        await connect({ preset: 'opencode-go', credential: secret }),
        await connect({ preset: 'nope', credential: secret }),
        await connect({ preset: 'opencode-go', credential: `${secret}\n` }),
        await connect({ preset: 'zai-coding-plan', credential: secret }),
        await connect({ preset: 'opencode-go', credential: secret, baseUrl: 'https://x.example' }),
      ];
      expect(results.map((r) => r.status)).toEqual([200, 422, 400, 422, 400]);
      for (const r of results.slice(1)) expect(JSON.stringify(r.body)).not.toContain(secret);
    } finally {
      for (const s of [...spies, ...consoleSpies]) s.mockRestore();
    }
    expect(chunks.join('')).not.toContain(secret);
  });

  it('a connected key-preset row is invisible to another tenant', async () => {
    const res = await connect({ preset: 'opencode-go', credential: 'k' });
    const id = res.body.id as string;
    expect(
      ((await request(server).get('/api/providers').set('x-test-user', bob)).body as unknown[])
        .length,
    ).toBe(0);
    expect((await request(server).get(`/api/providers/${id}`).set('x-test-user', bob)).status).toBe(
      404,
    );
  });
});

// The list and connect routes sit behind the REAL SessionGuard (they are not @Public):
// with no session and auto-login refused, both answer 401 and nothing is written.
describe('key-preset endpoints require a session (real SessionGuard)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    process.env['PROVIDER_CREDENTIAL_KEY'] = KEY;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, ProvidersModule, SubscriptionPresetsModule],
      providers: [
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: AUTH_INSTANCE, useValue: { getSession: () => Promise.resolve(null) } },
      ],
    })
      .overrideProvider(PROVIDER_ADAPTER_FACTORY)
      .useValue(spyFactory)
      .overrideProvider(KEY_PRESET_LOOKUP)
      .useValue(testRegistry)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('an unauthenticated list and connect are refused 401 with no list and no write', async () => {
    current = defaultRegistry();
    const before = Number(
      (await pool.query<{ n: string }>('SELECT count(*) AS n FROM provider')).rows[0]!.n,
    );
    // A forwarding header refuses localhost auto-login, so there is no principal at all.
    const list = await request(server)
      .get('/api/providers/key-presets/available')
      .set('x-forwarded-for', '203.0.113.9');
    expect(list.status).toBe(401);
    expect(JSON.stringify(list.body)).not.toContain('opencode-go');
    const post = await request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-forwarded-for', '203.0.113.9')
      .send({ preset: 'opencode-go', credential: 'k' });
    expect(post.status).toBe(401);
    const after = Number(
      (await pool.query<{ n: string }>('SELECT count(*) AS n FROM provider')).rows[0]!.n,
    );
    expect(after).toBe(before);
    expect(factoryCalls).toBe(0);
  });
});

// redesign-subscription-picker task 1.4: the SHIPPED registry, with no override. Every
// region ships enabled, so the four presets are listed and connectable on a stock install;
// the acknowledgement is still enforced; and withdrawing a region (shipping it disabled)
// hides it and refuses new connects while a row already connected from it keeps working.
describe('the shipped key-preset registry (no override)', () => {
  let app: INestApplication;
  let server: App;
  let pool: Pool;
  let carol: string;

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
    const moduleRef = await Test.createTestingModule({
      imports: [ProvidersModule, SubscriptionPresetsModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    })
      .overrideProvider(PROVIDER_ADAPTER_FACTORY)
      .useValue(spyFactory)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer();
    carol = (
      await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'u', $1, false) RETURNING id`,
        [uniqueEmail('kp-shipped')],
      )
    ).rows[0]!.id;
    factoryCalls = 0;
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM "user" WHERE id = $1', [carol]);
    await app.close();
    await pool.end();
  });

  afterEach(() => {
    expect(factoryCalls).toBe(0);
  });

  const count = async (): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>(
          'SELECT count(*) AS n FROM provider WHERE owner_user_id = $1',
          [carol],
        )
      ).rows[0]!.n,
    );

  it('lists the four presets with their seven regions and declaresIdentity', async () => {
    const res = await request(server)
      .get('/api/providers/key-presets/available')
      .set('x-test-user', carol);
    expect(res.status).toBe(200);
    const body = res.body as Array<{
      id: string;
      declaresIdentity: boolean;
      regions: Array<{ id: string; host: string }>;
    }>;
    expect(body.map((p) => [p.id, p.regions.map((r) => r.host), p.declaresIdentity])).toEqual([
      ['opencode-go', ['opencode.ai'], false],
      ['minimax-m-plan', ['api.minimax.io', 'api.minimaxi.com'], false],
      ['kimi-code', ['api.kimi.ai', 'api.kimi.com'], true],
      ['zai-coding-plan', ['api.z.ai', 'open.bigmodel.cn'], true],
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/claude-code\/|claude-cli\/|User-Agent/);
  });

  it('connects a China region of the shipped registry to its pinned endpoint', async () => {
    const res = await request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-test-user', carol)
      .send({ preset: 'kimi-code', region: 'cn', credential: 'sk-kimi-shipped-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Kimi Code (China)',
      kind: 'subscription',
      baseUrl: 'https://api.kimi.com/coding/v1',
      keyPreset: 'kimi-code',
      imitateClientIdentity: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('sk-kimi-shipped-1');
  });

  it('still refuses a Z.ai connect without the acknowledgement, writing nothing', async () => {
    const before = await count();
    const res = await request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-test-user', carol)
      .send({ preset: 'zai-coding-plan', region: 'intl', credential: 'k' });
    expect(res.status).toBe(422);
    expect(await count()).toBe(before);
  });
});
