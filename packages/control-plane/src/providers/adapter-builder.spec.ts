// add-batch-inference task 2.5: the ONE adapter builder — credential decrypt,
// OAuth resolution, SSRF gate, quirks, bounds — with fixed, secret-free failures.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  POLYROUTER_USER_AGENT,
  encryptSecret,
  userPrincipal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import type { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import { SubscriptionOauthService as SubscriptionOauthServiceClass } from '../subscription-oauth/subscription-oauth.service';
import { CHATGPT_PRESET, CLAUDE_PRESET, OAUTH_PRESETS } from '../subscription-oauth/presets';
import type { PresetClientIdentity } from './client-identity';
import {
  createGuardedHttpClient,
  createOpenaiProviderAdapter,
  type HttpClient,
  type HttpInit,
  type HttpResponse,
} from '@polyrouter/data-plane';
import {
  KIMI_CODE_PRESET,
  MINIMAX_M_PLAN_PRESET,
  OPENCODE_GO_PRESET,
  ZAI_CODING_PLAN_PRESET,
} from '../subscription-presets/key-presets';
import { AdapterBuildError, ProviderAdapterBuilder } from './adapter-builder';

const KEY = 'ab'.repeat(32); // 32 bytes of hex — the encryption key format
const principal = userPrincipal('u1');

function row(over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'p1',
    ownerUserId: 'u1',
    orgId: null,
    name: 'Prov',
    kind: 'api_key',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    encryptedCredentials: encryptSecret('sk-live-SECRET', KEY),
    status: 'ok',
    maxTokensSpelling: 'auto',
    oauthPreset: null,
    keyPreset: null,
    credentialExpiresAt: null,
    credentialError: null,
    firstByteTimeoutMs: null,
    idleTimeoutMs: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  } as ProviderRow;
}

function builder(
  resolveCredential: SubscriptionOauthService['resolveCredential'] = () =>
    Promise.reject(new Error('oauth seam not expected')),
  mode: 'selfhosted' | 'cloud' = 'cloud',
  availableClientIdentity: () => PresetClientIdentity | null = () => null,
  identityBindingFor: SubscriptionOauthService['identityBindingFor'] = () => undefined,
): ProviderAdapterBuilder {
  return new ProviderAdapterBuilder({ key: KEY, mode }, {
    resolveCredential,
    availableClientIdentity,
    identityBindingFor,
  } as unknown as SubscriptionOauthService);
}

/** The REAL `identityBindingFor` over the bundled registries (it reads nothing else). */
function realBindingFor(): SubscriptionOauthService['identityBindingFor'] {
  const svc = Object.create(SubscriptionOauthServiceClass.prototype) as SubscriptionOauthService;
  (svc as unknown as { presets: unknown }).presets = {
    find: (id: string) => OAUTH_PRESETS.find((p) => p.id === id),
    list: () => OAUTH_PRESETS,
  };
  return (r) => svc.identityBindingFor(r);
}

const opts = { defaultMaxOutputTokens: 4096 };

describe('ProviderAdapterBuilder', () => {
  it('decrypts a plain credential and threads quirks, bounds, mode and the default cap', async () => {
    const bounds = { firstByteTimeoutMs: 1_000, idleTimeoutMs: 2_000, streamEventTimeoutMs: 1_500 };
    const cfg = await builder().buildConfig(
      principal,
      row({ maxTokensSpelling: 'max_completion_tokens' }),
      { defaultMaxOutputTokens: 512, bounds },
    );
    expect(cfg).toMatchObject({
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-live-SECRET',
      kind: 'api_key',
      mode: 'cloud',
      defaultMaxOutputTokens: 512,
      ...bounds,
    });
    expect(cfg.quirks).toBeDefined();
    expect(cfg.authScheme).toBeUndefined(); // api-key default: every existing caller unchanged
  });

  it('resolves a subscription provider through the OAuth seam (refresh path) and threads its scheme', async () => {
    const resolve = jest.fn(() =>
      Promise.resolve({
        credential: 'oauth-ACCESS',
        authScheme: 'oauth_bearer' as const,
        envelope: 'stored-cipher',
        oauthBeta: 'oauth-2025-04-20',
      }),
    );
    const cfg = await builder(resolve).buildConfig(
      principal,
      row({
        kind: 'subscription',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://api.anthropic.com',
      }),
      opts,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cfg).toMatchObject({
      credential: 'oauth-ACCESS',
      authScheme: 'oauth_bearer',
      oauthBeta: 'oauth-2025-04-20',
      kind: 'subscription',
    });
    expect('probeModel' in cfg).toBe(false); // add-live-subscription-models
  });

  it('lets a credential-kind OAuth failure pass through untouched (breaker-neutral, fallback-eligible)', async () => {
    const boom = new Error('reauthorize required');
    await expect(
      builder(() => Promise.reject(boom)).buildConfig(
        principal,
        row({ kind: 'subscription' }),
        opts,
      ),
    ).rejects.toBe(boom);
  });

  it('refuses a private address at build with a fixed message, and skips the gate only when told to', async () => {
    const privateRow = row({ baseUrl: 'http://10.0.0.1/v1' });
    const err = await builder()
      .buildConfig(principal, privateRow, opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterBuildError);
    expect((err as AdapterBuildError).reason).toBe('address_rejected');
    expect((err as Error).message).toBe('provider address rejected');
    // The management path keeps its call-time semantics: no build-time gate.
    const cfg = await builder().buildConfig(principal, privateRow, {
      ...opts,
      assertAddress: false,
    });
    expect(cfg.baseUrl).toBe('http://10.0.0.1/v1');
  });

  it('a loopback local provider builds only under MODE=selfhosted, credential-less', async () => {
    const local = row({
      kind: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      encryptedCredentials: null,
    });
    const cfg = await builder(undefined, 'selfhosted').buildConfig(principal, local, opts);
    expect(cfg.credential).toBe('');
    await expect(
      builder(undefined, 'cloud').buildConfig(principal, local, opts),
    ).rejects.toMatchObject({
      reason: 'address_rejected',
    });
  });

  it('names a missing base_url or credential with a fixed reason', async () => {
    await expect(
      builder().buildConfig(principal, row({ baseUrl: null }), opts),
    ).rejects.toMatchObject({
      reason: 'no_base_url',
      message: 'provider has no base_url',
    });
    await expect(
      builder().buildConfig(principal, row({ encryptedCredentials: null }), opts),
    ).rejects.toMatchObject({ reason: 'no_credential', message: 'provider has no credential' });
  });

  it('never puts the credential, the key, or the URL into a failure message', async () => {
    const failures: unknown[] = [];
    for (const r of [
      row({ baseUrl: null }),
      row({ encryptedCredentials: null }),
      row({ baseUrl: 'http://169.254.169.254/x' }),
    ]) {
      failures.push(
        await builder()
          .buildConfig(principal, r, opts)
          .catch((e: unknown) => e),
      );
    }
    for (const f of failures) {
      const text = (f as Error).message;
      expect(text).not.toMatch(/SECRET|abababab|169\.254|10\.0\.0/);
    }
  });

  // add-provider-health-signals (task 3.1): the envelope the build ACTUALLY used
  // comes back beside the config — never inside it.
  describe('buildConfigWithCredential', () => {
    it('reports the envelope a lazy refresh just wrote, not the row the caller loaded', async () => {
      const loaded = row({
        kind: 'subscription',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://api.anthropic.com',
        encryptedCredentials: 'poly-enc:v1:OLD-CIPHER',
      });
      const resolve = jest.fn(() =>
        Promise.resolve({
          credential: 'oauth-FRESH',
          authScheme: 'oauth_bearer' as const,
          envelope: 'poly-enc:v1:NEW-CIPHER', // written by the refresh inside the build
        }),
      );
      const built = await builder(resolve).buildConfigWithCredential(principal, loaded, opts);
      expect(built.usedEnvelope).toBe('poly-enc:v1:NEW-CIPHER');
      expect(built.config.credential).toBe('oauth-FRESH');
    });

    it('reports the stored envelope for a plain credential and null for a keyless local provider', async () => {
      const plain = row();
      expect((await builder().buildConfigWithCredential(principal, plain, opts)).usedEnvelope).toBe(
        plain.encryptedCredentials,
      );
      const local = row({
        kind: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        encryptedCredentials: null,
      });
      expect(
        (await builder(undefined, 'selfhosted').buildConfigWithCredential(principal, local, opts))
          .usedEnvelope,
      ).toBeNull();
    });

    it('never places the envelope in the adapter config', async () => {
      const envelope = 'poly-enc:v1:MUST-NOT-LEAK';
      const oauth = await builder(() =>
        Promise.resolve({ credential: 'tok', authScheme: 'oauth_bearer' as const, envelope }),
      ).buildConfigWithCredential(
        principal,
        row({
          kind: 'subscription',
          protocol: 'anthropic_compatible',
          baseUrl: 'https://api.anthropic.com',
        }),
        opts,
      );
      expect(JSON.stringify(oauth.config)).not.toContain('MUST-NOT-LEAK');
      const plain = await builder().buildConfigWithCredential(principal, row(), opts);
      expect(JSON.stringify(plain.config)).not.toContain(plain.usedEnvelope!);
    });
  });

  // add-honest-user-agent task 5.4: nothing fills the client-identity seam today, so the
  // wire User-Agent is always polyrouter's own. allow-preset-client-identity later narrows
  // this to "switch off gives no extraHeaders".
  describe('client identity seam', () => {
    /** Every key anywhere in the config, however deeply nested. */
    const allKeys = (value: unknown): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)])
        : [];

    it.each([
      [
        'a plain api_key provider',
        row(),
        undefined as SubscriptionOauthService['resolveCredential'] | undefined,
      ],
      [
        'an OAuth subscription provider',
        row({
          kind: 'subscription',
          protocol: 'anthropic_compatible',
          baseUrl: 'https://api.anthropic.com',
        }),
        () =>
          Promise.resolve({
            credential: 'oauth-ACCESS',
            authScheme: 'oauth_bearer' as const,
            envelope: 'stored-cipher',
            oauthBeta: 'oauth-2025-04-20',
          }),
      ],
    ])('carries no extraHeaders and no User-Agent for %s', async (_name, provider, resolve) => {
      const cfg = await builder(resolve).buildConfig(principal, provider, opts);
      expect('extraHeaders' in cfg).toBe(false);
      expect(cfg.extraHeaders).toBeUndefined();
      expect(allKeys(cfg).filter((k) => /user[-_]?agent/i.test(k))).toEqual([]);
    });
  });
});

// allow-preset-client-identity (task 5.1): the builder spreads the declared model-API
// headers as `extraHeaders` only while the row's switch is on. These cases are decided
// by the stub; the real-service guarantee for Claude and ChatGPT is the e2e pin (5.4).
describe('ProviderAdapterBuilder client identity', () => {
  const FIXTURE: PresetClientIdentity = {
    label: 'Fixture Client',
    apiHeaders: { 'User-Agent': 'fixture-client/1.0', 'X-Fixture-Client': 'polyrouter-test' },
    tokenHeaders: { 'User-Agent': 'fixture-auth/1.0' },
  };
  const subRow = (imitate: boolean): ProviderRow =>
    row({
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      imitateClientIdentity: imitate,
    });
  const bearer = (): ReturnType<SubscriptionOauthService['resolveCredential']> =>
    Promise.resolve({
      credential: 'oauth-ACCESS',
      authScheme: 'oauth_bearer' as const,
      envelope: 'stored-cipher',
    });

  it('omits extraHeaders with the switch off', async () => {
    const cfg = await builder(bearer, 'cloud', () => FIXTURE).buildConfig(
      principal,
      subRow(false),
      opts,
    );
    expect('extraHeaders' in cfg).toBe(false);
  });

  it("sends the fixture's apiHeaders with the switch on", async () => {
    const cfg = await builder(bearer, 'cloud', () => FIXTURE).buildConfig(
      principal,
      subRow(true),
      opts,
    );
    expect(cfg.extraHeaders).toEqual(FIXTURE.apiHeaders);
  });

  it('omits extraHeaders when imitation is not available (stub null), whatever the switch', async () => {
    const built = await builder(bearer, 'cloud', () => null).buildConfigWithCredential(
      principal,
      subRow(true),
      opts,
    );
    expect('extraHeaders' in built.config).toBe(false);
  });

  it('carries the identity on the non-OAuth path too (a resolveCredential that returns api_key)', async () => {
    const apiKey = (): ReturnType<SubscriptionOauthService['resolveCredential']> =>
      Promise.resolve({
        credential: 'sk-plain',
        authScheme: 'api_key' as const,
        envelope: 'stored-cipher',
      });
    const cfg = await builder(apiKey, 'cloud', () => FIXTURE).buildConfig(
      principal,
      subRow(true),
      opts,
    );
    expect(cfg.authScheme).toBe('api_key');
    expect(cfg.extraHeaders).toEqual(FIXTURE.apiHeaders);
  });

  it('carries the identity on the plain-credential return as well', async () => {
    const cfg = await builder(undefined, 'cloud', () => FIXTURE).buildConfig(
      principal,
      row({ imitateClientIdentity: true }),
      opts,
    );
    expect(cfg.extraHeaders).toEqual(FIXTURE.apiHeaders);
  });
});

// add-key-subscription-presets (task 4.2): the listing override rides ONLY through the
// coherence gate over the bundled constants. The builder takes no preset argument.
describe('ProviderAdapterBuilder key-preset listing override', () => {
  const OPENCODE = OPENCODE_GO_PRESET.regions[0]!;
  const kimi = KIMI_CODE_PRESET.regions[0]!;
  const keyRow = (over: Partial<ProviderRow> = {}): ProviderRow =>
    row({
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: OPENCODE.baseUrl,
      keyPreset: OPENCODE_GO_PRESET.id,
      ...over,
    });
  // The plain pasted key resolves as `api_key` through the (stubbed) subscription seam.
  const plainKey = (): ReturnType<SubscriptionOauthService['resolveCredential']> =>
    Promise.resolve({
      credential: 'sk-plain-key',
      authScheme: 'api_key' as const,
      envelope: 'stored-cipher',
    });
  const noGate = { ...opts, assertAddress: false };

  it('an OpenCode Go row gets the trusted listing URL, and the plain key is an api_key credential', async () => {
    const cfg = await builder(plainKey).buildConfig(principal, keyRow(), noGate);
    expect(cfg.modelsUrl).toBe('https://opencode.ai/inference/go/v1/models');
    expect(cfg.baseUrl).toBe(OPENCODE.baseUrl);
    expect(cfg.authScheme).toBe('api_key');
    expect(cfg.credential).toBe('sk-plain-key');
  });

  it.each([
    ['a drifted base_url', { baseUrl: 'https://opencode.ai/inference/go/openai/v1/' }],
    ['a drifted protocol', { protocol: 'anthropic_compatible' as const }],
    ['an unknown marker', { keyPreset: 'no-such-preset' }],
    ['a non-subscription row', { kind: 'api_key' as const }],
    ['no marker', { keyPreset: null }],
  ])('%s gets no override', async (_name, over) => {
    const cfg = await builder(plainKey).buildConfig(principal, keyRow(over), noGate);
    expect('modelsUrl' in cfg).toBe(false);
  });

  it('a Kimi row gets none (the preset declares no listing override)', async () => {
    const cfg = await builder(plainKey).buildConfig(
      principal,
      keyRow({ baseUrl: kimi.baseUrl, keyPreset: KIMI_CODE_PRESET.id }),
      noGate,
    );
    expect('modelsUrl' in cfg).toBe(false);
    const zai = ZAI_CODING_PLAN_PRESET.regions[0]!;
    const z = await builder(plainKey).buildConfig(
      principal,
      keyRow({ baseUrl: zai.baseUrl, keyPreset: ZAI_CODING_PLAN_PRESET.id }),
      noGate,
    );
    expect('modelsUrl' in z).toBe(false);
  });

  it('a key-preset row stored with max_tokens_spelling max_tokens sends max_tokens on the wire', async () => {
    const bodies: string[] = [];
    const client: HttpClient = (_url: string, init: HttpInit): Promise<HttpResponse> => {
      bodies.push(typeof init.body === 'string' ? init.body : '');
      const text = JSON.stringify({
        id: 'c1',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: null,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(JSON.parse(text) as unknown),
      });
    };
    const cfg = await builder(plainKey).buildConfig(
      principal,
      keyRow({ maxTokensSpelling: 'max_tokens' }),
      noGate,
    );
    const adapter = createOpenaiProviderAdapter(cfg, { httpClient: client });
    await adapter.chat({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      params: { maxOutputTokens: 64 },
    });
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body['max_tokens']).toBe(64);
    expect('max_completion_tokens' in body).toBe(false);
  });
});

// add-key-subscription-presets (task 7.2): a key-preset row's identity reaches the adapter only
// through the (stubbed) availability seam and only while the row's switch is on. Drift and
// the non-declaring presets are decided by the REAL service in subscription-oauth.service.spec.ts,
// not here (the stub decides this file's cases).
describe('ProviderAdapterBuilder key-preset client identity', () => {
  const kimiRegion = KIMI_CODE_PRESET.regions[0]!;
  const KIMI_IDENTITY = KIMI_CODE_PRESET.clientIdentity!;
  const kimiRow = (imitate: boolean): ProviderRow =>
    row({
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: kimiRegion.baseUrl,
      keyPreset: KIMI_CODE_PRESET.id,
      imitateClientIdentity: imitate,
    });
  const plainKey = (): ReturnType<SubscriptionOauthService['resolveCredential']> =>
    Promise.resolve({
      credential: 'sk-kimi-plain',
      authScheme: 'api_key' as const,
      envelope: 'stored-cipher',
    });
  const noGate = { ...opts, assertAddress: false };

  it('with the switch off a Kimi row gets no extraHeaders', async () => {
    const cfg = await builder(plainKey, 'cloud', () => KIMI_IDENTITY).buildConfig(
      principal,
      kimiRow(false),
      noGate,
    );
    expect('extraHeaders' in cfg).toBe(false);
  });

  it('with the switch on a Kimi row gets exactly the declared headers', async () => {
    const cfg = await builder(plainKey, 'cloud', () => KIMI_IDENTITY).buildConfig(
      principal,
      kimiRow(true),
      noGate,
    );
    expect(cfg.extraHeaders).toEqual(KIMI_IDENTITY.apiHeaders);
    expect(cfg.authScheme).toBe('api_key');
  });

  describe('on the wire (real loopback transport, raw headers)', () => {
    let server: http.Server;
    let port: number;
    let raws: string[][] = [];
    const uas = (raw: string[]): string[] => {
      const out: string[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        if (raw[i]?.toLowerCase() === 'user-agent') out.push(raw[i + 1] ?? '');
      }
      return out;
    };

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        raws.push([...req.rawHeaders]);
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            req.url?.endsWith('/models')
              ? JSON.stringify({ data: [{ id: 'm' }] })
              : JSON.stringify({
                  id: 'c',
                  object: 'chat.completion',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: 'x' },
                      finish_reason: 'stop',
                    },
                  ],
                }),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    beforeEach(() => {
      raws = [];
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** The builder's config for a Kimi row, re-pointed at the loopback server: only the
     * destination changes, so the headers are exactly the ones the builder decided. */
    const wireAdapter = async (imitate: boolean) => {
      const cfg = await builder(plainKey, 'cloud', () => KIMI_IDENTITY).buildConfig(
        principal,
        kimiRow(imitate),
        noGate,
      );
      const origin = `http://127.0.0.1:${String(port)}`;
      return createOpenaiProviderAdapter(
        { ...cfg, baseUrl: `${origin}/v1`, kind: 'local', mode: 'selfhosted' },
        { httpClient: createGuardedHttpClient({ mode: 'selfhosted', providerKind: 'local' }) },
      );
    };
    const chatRequest = {
      model: 'm',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      params: {},
    };

    it('switch off: exactly one User-Agent, polyrouter’s own, on chat and listing', async () => {
      const adapter = await wireAdapter(false);
      await adapter.chat(chatRequest);
      await adapter.listModels();
      expect(raws).toHaveLength(2);
      for (const raw of raws) expect(uas(raw)).toEqual([POLYROUTER_USER_AGENT]);
    });

    it('switch on: exactly one User-Agent, the declared one, on chat and listing; never both', async () => {
      const adapter = await wireAdapter(true);
      await adapter.chat(chatRequest);
      await adapter.listModels();
      expect(raws).toHaveLength(2);
      for (const raw of raws) {
        expect(uas(raw)).toEqual([KIMI_IDENTITY.apiHeaders['User-Agent']]);
        expect(uas(raw).join()).not.toContain('polyrouter/');
        expect(raw.join('\n')).not.toMatch(/KimiCLI\//);
      }
    });
  });
});

// classify-plan-quota-errors task 6.2: the region's plan-error dialect reaches the config only
// through the coherence gate, so only a row still equal to a region pin that declares one.
describe('ProviderAdapterBuilder key-preset plan-error dialect', () => {
  const keyRow = (preset: string, baseUrl: string, over: Partial<ProviderRow> = {}): ProviderRow =>
    row({
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl,
      keyPreset: preset,
      ...over,
    });
  const plainKey = (): ReturnType<SubscriptionOauthService['resolveCredential']> =>
    Promise.resolve({
      credential: 'sk-plain-key',
      authScheme: 'api_key' as const,
      envelope: 'stored-cipher',
    });
  const noGate = { ...opts, assertAddress: false };
  const dialectOf = async (r: ProviderRow): Promise<string | undefined> => {
    const cfg = await builder(plainKey).buildConfig(principal, r, noGate);
    return cfg.errorDialect;
  };

  it.each([
    ['Z.ai international', ZAI_CODING_PLAN_PRESET, 'intl', 'zai'],
    ['MiniMax international', MINIMAX_M_PLAN_PRESET, 'intl', 'minimax'],
    ['Kimi international', KIMI_CODE_PRESET, 'intl', 'kimi'],
    ['Kimi China', KIMI_CODE_PRESET, 'cn', 'kimi'],
  ] as const)('%s carries its dialect', async (_n, preset, regionId, dialect) => {
    const region = preset.regions.find((r) => r.id === regionId)!;
    expect(await dialectOf(keyRow(preset.id, region.baseUrl))).toBe(dialect);
  });

  it.each([
    [
      'a Z.ai China row (no evidence recorded)',
      ZAI_CODING_PLAN_PRESET.regions[1]!.baseUrl,
      'zai-coding-plan',
      {},
    ],
    [
      'a MiniMax China row (no evidence recorded)',
      MINIMAX_M_PLAN_PRESET.regions[1]!.baseUrl,
      'minimax-m-plan',
      {},
    ],
    ['an OpenCode Go row', OPENCODE_GO_PRESET.regions[0]!.baseUrl, 'opencode-go', {}],
    ['a drifted base_url', 'https://api.z.ai/api/coding/paas/v4/', 'zai-coding-plan', {}],
    [
      'an "Other subscription" row on api.z.ai',
      ZAI_CODING_PLAN_PRESET.regions[0]!.baseUrl,
      null,
      {},
    ],
    [
      'an api_key row on the pay-as-you-go path',
      'https://api.z.ai/api/paas/v4',
      null,
      { kind: 'api_key' as const },
    ],
    [
      'an api_key row on the coding host',
      ZAI_CODING_PLAN_PRESET.regions[0]!.baseUrl,
      'zai-coding-plan',
      { kind: 'api_key' as const },
    ],
  ])('%s carries none', async (_n, baseUrl, preset, over) => {
    const cfg = await builder(plainKey).buildConfig(
      principal,
      keyRow(preset as string, baseUrl, { keyPreset: preset, ...over }),
      noGate,
    );
    expect('errorDialect' in cfg).toBe(false);
  });

  it('an OAuth preset row carries none', async () => {
    const r = row({
      kind: 'subscription',
      protocol: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com',
      oauthPreset: 'claude-code',
      keyPreset: null,
    });
    const cfg = await builder(() =>
      Promise.resolve({
        credential: 'tok',
        authScheme: 'oauth_bearer' as const,
        envelope: 'stored-cipher',
      }),
    ).buildConfig(principal, r, noGate);
    expect('errorDialect' in cfg).toBe(false);
  });

  describe('Test (the model listing) with the dialect', () => {
    const refusing =
      (status: number, message: string): HttpClient =>
      (): Promise<HttpResponse> => {
        const text = JSON.stringify({ error: { message } });
        return Promise.resolve({
          status,
          ok: false,
          headers: { get: () => null },
          body: null,
          text: () => Promise.resolve(text),
          json: () => Promise.resolve(JSON.parse(text) as unknown),
        });
      };
    const testKimi = async (status: number, message: string) => {
      const region = KIMI_CODE_PRESET.regions[0]!;
      const cfg = await builder(plainKey).buildConfig(
        principal,
        keyRow(KIMI_CODE_PRESET.id, region.baseUrl),
        noGate,
      );
      return createOpenaiProviderAdapter(cfg, {
        httpClient: refusing(status, message),
      }).testConnection();
    };

    it('a recognized 403 tier text is plan_entitlement, not permission', async () => {
      const r = await testKimi(403, 'Your current subscription does not have access to kimi-k3.');
      expect(r).toMatchObject({ ok: false, kind: 'plan_entitlement' });
    });

    it('an unrecognised 403 still gives permission', async () => {
      const r = await testKimi(403, 'Forbidden for some other reason');
      expect(r).toMatchObject({ ok: false, kind: 'permission' });
    });

    it('the documented membership 403 stays permission (design D1)', async () => {
      const r = await testKimi(
        403,
        'We’re unable to verify your membership benefits at this time. Please ensure your membership is active.',
      );
      expect(r).toMatchObject({ ok: false, kind: 'permission' });
    });

    it('a 401 is still auth', async () => {
      const r = await testKimi(401, 'Your current subscription does not have access to x');
      expect(r).toMatchObject({ ok: false, kind: 'auth' });
    });
  });
});

// add-subscription-quota-display (task 5.3): the plan-usage dialect reaches the adapter config
// only through `planUsageSourcesFor` over the single preset lookup.
describe('ProviderAdapterBuilder plan-usage dialect', () => {
  const noGate = { ...opts, assertAddress: false };
  const tokenResolve = (): ReturnType<SubscriptionOauthService['resolveCredential']> =>
    Promise.resolve({
      credential: 'tok-ACCESS',
      authScheme: 'oauth_bearer' as const,
      envelope: 'stored-cipher',
    });
  const keyResolve = (): ReturnType<SubscriptionOauthService['resolveCredential']> =>
    Promise.resolve({
      credential: 'sk-plain-key',
      authScheme: 'api_key' as const,
      envelope: 'stored-cipher',
    });
  const real = (resolve: SubscriptionOauthService['resolveCredential']) =>
    builder(resolve, 'cloud', () => null, realBindingFor());

  const oauthRowOf = (preset: typeof CLAUDE_PRESET, over: Partial<ProviderRow> = {}) =>
    row({
      kind: 'subscription',
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      oauthPreset: preset.id,
      keyPreset: null,
      ...over,
    });
  const goRow = (over: Partial<ProviderRow> = {}) =>
    row({
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: OPENCODE_GO_PRESET.regions[0]!.baseUrl,
      oauthPreset: null,
      keyPreset: OPENCODE_GO_PRESET.id,
      ...over,
    });

  it('a coherent Claude row and ChatGPT row carry their dialect (the subscription return)', async () => {
    const claude = await real(tokenResolve).buildConfig(
      principal,
      oauthRowOf(CLAUDE_PRESET),
      noGate,
    );
    expect(claude.usageDialect).toBe('anthropic_unified');
    const chatgpt = await real(tokenResolve).buildConfig(
      principal,
      oauthRowOf(CHATGPT_PRESET),
      noGate,
    );
    expect(chatgpt.usageDialect).toBe('codex');
  });

  it('a coherent OpenCode Go row carries opencode_go, on the subscription return', async () => {
    const cfg = await real(keyResolve).buildConfig(principal, goRow(), noGate);
    expect(cfg.usageDialect).toBe('opencode_go');
  });

  it('a row with no usage dialect carries none: Kimi (a probe only), an api_key row, a custom row', async () => {
    const kimi = KIMI_CODE_PRESET.regions[0]!;
    const kimiCfg = await real(keyResolve).buildConfig(
      principal,
      row({
        kind: 'subscription',
        protocol: 'openai_compatible',
        baseUrl: kimi.baseUrl,
        keyPreset: KIMI_CODE_PRESET.id,
      }),
      noGate,
    );
    expect('usageDialect' in kimiCfg).toBe(false);
    for (const kind of ['api_key', 'custom']) {
      const cfg = await real(keyResolve).buildConfig(principal, row({ kind }), noGate);
      expect('usageDialect' in cfg).toBe(false);
    }
  });

  it('a drifted row does not carry the dialect (OAuth base_url or protocol, key-preset base_url)', async () => {
    const drifted: ProviderRow[] = [
      oauthRowOf(CLAUDE_PRESET, { baseUrl: 'https://proxy.example/' }),
      oauthRowOf(CLAUDE_PRESET, { protocol: 'openai_compatible' }),
      oauthRowOf(CHATGPT_PRESET, { baseUrl: 'https://chatgpt.com/other/' }),
      goRow({ baseUrl: `${OPENCODE_GO_PRESET.regions[0]!.baseUrl}/` }),
      goRow({ protocol: 'anthropic_compatible' }),
      goRow({ kind: 'api_key' }),
      goRow({ keyPreset: null }),
    ];
    for (const r of drifted) {
      const cfg = await real(tokenResolve).buildConfig(principal, r, noGate);
      expect({ id: r.baseUrl, has: 'usageDialect' in cfg }).toEqual({ id: r.baseUrl, has: false });
    }
  });

  it('the dialect never comes from the host: a preset host without the marker carries none', async () => {
    const cfg = await real(keyResolve).buildConfig(
      principal,
      row({
        kind: 'subscription',
        protocol: 'openai_compatible',
        baseUrl: OPENCODE_GO_PRESET.regions[0]!.baseUrl,
        keyPreset: null,
        oauthPreset: null,
      }),
      noGate,
    );
    expect('usageDialect' in cfg).toBe(false);
  });

  it('the dialect is decided by the lookup alone: a stub binding with a dialect yields it, never the row', async () => {
    const stub = builder(
      keyResolve,
      'cloud',
      () => null,
      () => ({
        identity: undefined,
        pin: { baseUrl: 'https://api.openai.com/v1', protocol: 'openai_compatible' },
        usage: { dialect: 'codex' as const },
      }),
    );
    // The row is api_key: the single pin test (kind subscription) refuses it.
    const cfg = await stub.buildConfig(principal, row(), noGate);
    expect('usageDialect' in cfg).toBe(false);
  });
});
