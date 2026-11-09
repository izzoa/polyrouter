// add-key-subscription-presets task 5.1/5.2 — connect and list service, DTO and module binding.
import 'reflect-metadata';
import { UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import {
  decryptSecret,
  parseCredentialEnvelope,
  userPrincipal,
  type PersistencePort,
  type ProviderInsertInput,
  type ProviderRow,
} from '@polyrouter/shared/server';
import { normalizeAndGateBaseUrl } from '../providers/base-url-gate';
import { PROVIDERS_RUNTIME } from '../providers/providers.service';
import {
  KEY_PRESET_LOOKUP,
  KEY_PRESETS,
  KIMI_CODE_PRESET,
  MINIMAX_M_PLAN_PRESET,
  OPENCODE_GO_PRESET,
  ZAI_CODING_PLAN_PRESET,
  defaultKeyPresetRegistry,
  type KeyPreset,
  type KeyPresetRegion,
  type KeyPresetRegistry,
} from './key-presets';
import { KeyPresetConnectDto } from './subscription-presets.dto';
import { KeyPresetsController } from './subscription-presets.controller';
import { SubscriptionPresetsModule } from './subscription-presets.module';
import { SubscriptionPresetsService } from './subscription-presets.service';

// The SSRF gate resolves DNS; unit tests must not. The gate itself is covered by the
// providers' own specs and the connect e2e.
jest.mock('../providers/base-url-gate', () => ({
  normalizeAndGateBaseUrl: jest.fn((_mode: string, _kind: string, url: string) =>
    Promise.resolve(new URL(url).href),
  ),
}));
const gate = normalizeAndGateBaseUrl as jest.MockedFunction<typeof normalizeAndGateBaseUrl>;

const KEY = 'd'.repeat(64);
const alice = userPrincipal('u1');

/** A copy of `preset` whose regions start WITHDRAWN (`enabled: false`) and take the given
 * overrides, so each fixture names exactly the regions it offers. The shipped constants are
 * all enabled (redesign-subscription-picker); the shipped registry has its own test below. */
function withRegions(
  preset: KeyPreset,
  flags: Readonly<Record<string, Partial<KeyPresetRegion>>>,
): KeyPreset {
  return {
    ...preset,
    regions: preset.regions.map((r) => ({ ...r, enabled: false, ...(flags[r.id] ?? {}) })),
  };
}
const registryOf = (...presets: KeyPreset[]): KeyPresetRegistry => ({
  find: (id) => presets.find((p) => p.id === id),
  list: () => presets,
});
const ON = { enabled: true };

interface Harness {
  svc: SubscriptionPresetsService;
  insert: jest.Mock<Promise<ProviderRow>, [unknown, ProviderInsertInput]>;
}
function harness(registry: KeyPresetRegistry): Harness {
  const insert = jest.fn((_p: unknown, v: ProviderInsertInput): Promise<ProviderRow> =>
    Promise.resolve({ id: 'p1', ...v } as unknown as ProviderRow),
  );
  // Any port member other than providers.insert is a bug on the connect path.
  const port = {
    providers: new Proxy(
      { insert },
      {
        get: (t, k) => {
          if (k in t) return (t as Record<string | symbol, unknown>)[k];
          throw new Error(`unexpected providers.${String(k)}`);
        },
      },
    ),
  } as unknown as PersistencePort;
  const svc = new SubscriptionPresetsService(port, registry, { key: KEY, mode: 'selfhosted' });
  return { svc, insert };
}

const dto = (over: Partial<KeyPresetConnectDto> = {}): KeyPresetConnectDto =>
  Object.assign(new KeyPresetConnectDto(), { preset: 'opencode-go', credential: 'k-1', ...over });

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  gate.mockClear();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in unit'));
});
afterEach(() => fetchSpy.mockRestore());

describe('SubscriptionPresetsService.connect: rejections write nothing and dial nothing', () => {
  const enabledAll = registryOf(
    withRegions(OPENCODE_GO_PRESET, { default: ON }),
    withRegions(KIMI_CODE_PRESET, { intl: ON, cn: ON }),
    withRegions(ZAI_CODING_PLAN_PRESET, { intl: ON }),
    withRegions(MINIMAX_M_PLAN_PRESET, {}), // every region disabled
  );

  const cases: ReadonlyArray<readonly [string, Partial<KeyPresetConnectDto>]> = [
    ['an unknown preset', { preset: 'nope' }],
    ['a preset with every region disabled', { preset: 'minimax-m-plan' }],
    ['no region while two are offered', { preset: 'kimi-code' }],
    ['an unknown region', { preset: 'kimi-code', region: 'mars' }],
    [
      'a disabled region of an enabled preset',
      { preset: 'zai-coding-plan', region: 'cn', acknowledgeTermsRisk: true },
    ],
    [
      'a high-risk preset without the acknowledgement',
      { preset: 'zai-coding-plan', region: 'intl' },
    ],
    [
      'a high-risk preset with acknowledgeTermsRisk false',
      { preset: 'zai-coding-plan', region: 'intl', acknowledgeTermsRisk: false },
    ],
  ];
  it.each(cases)('%s -> 422, nothing written, no gate, no fetch', async (_n, over) => {
    const h = harness(enabledAll);
    await expect(h.svc.connect(alice, dto(over))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(h.insert).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the shipped registry (every region enabled) lists and connects every region', async () => {
    const h = harness(defaultKeyPresetRegistry);
    expect(h.svc.listAvailable().map((p) => [p.id, p.regions.map((r) => r.id)])).toEqual([
      ['opencode-go', ['default']],
      ['minimax-m-plan', ['intl', 'cn']],
      ['kimi-code', ['intl', 'cn']],
      ['zai-coding-plan', ['intl', 'cn']],
    ]);
    let n = 0;
    for (const p of KEY_PRESETS) {
      for (const r of p.regions) {
        await h.svc.connect(alice, dto({ preset: p.id, region: r.id, acknowledgeTermsRisk: true }));
        n += 1;
        expect(h.insert.mock.calls[n - 1]![1].baseUrl).toBe(r.baseUrl);
      }
    }
    expect(n).toBe(7);
    // The acknowledgement is still enforced on the shipped Z.ai preset.
    await expect(
      h.svc.connect(alice, dto({ preset: 'zai-coding-plan', region: 'intl' })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.insert).toHaveBeenCalledTimes(7);
  });

  it('an imitation-required region needs the acknowledgement, even on a low-risk preset', async () => {
    const reg = registryOf(
      withRegions(OPENCODE_GO_PRESET, { default: { enabled: true, imitationRequired: true } }),
    );
    const h = harness(reg);
    await expect(h.svc.connect(alice, dto())).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.insert).not.toHaveBeenCalled();
    const ok = await h.svc.connect(alice, dto({ acknowledgeTermsRisk: true }));
    expect(ok.keyPreset).toBe('opencode-go');
  });

  it('an SSRF-gate rejection of the pinned URL writes nothing', async () => {
    gate.mockRejectedValueOnce(new UnprocessableEntityException('base_url failed SSRF validation'));
    const h = harness(enabledAll);
    await expect(h.svc.connect(alice, dto())).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.insert).not.toHaveBeenCalled();
  });
});

describe('SubscriptionPresetsService.connect: success', () => {
  it('writes the pinned row with an encrypted plain credential, and runs the pin through the gate', async () => {
    const h = harness(registryOf(withRegions(KIMI_CODE_PRESET, { intl: ON })));
    const row = await h.svc.connect(alice, dto({ preset: 'kimi-code', credential: 'sk-kimi-abc' }));
    expect(gate).toHaveBeenCalledWith(
      'selfhosted',
      'subscription',
      'https://api.kimi.ai/coding/v1',
    );
    const v = h.insert.mock.calls[0]![1];
    expect(v).toMatchObject({
      name: 'Kimi Code',
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.kimi.ai/coding/v1',
      keyPreset: 'kimi-code',
    });
    // No identity switch, acknowledgement or token spelling rides along.
    expect(Object.keys(v).sort()).toEqual(
      ['baseUrl', 'encryptedCredentials', 'keyPreset', 'kind', 'name', 'protocol'].sort(),
    );
    const stored = v.encryptedCredentials as string;
    expect(stored).not.toContain('sk-kimi-abc');
    expect(parseCredentialEnvelope(decryptSecret(stored, KEY))).toEqual({
      kind: 'plain',
      value: 'sk-kimi-abc',
    });
    expect(row.keyPreset).toBe('kimi-code');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a polycred:v1 oauth lookalike is stored wrapped as plain', async () => {
    const lookalike = 'polycred:v1:{"kind":"oauth","preset":"x","accessToken":"a"}';
    const h = harness(registryOf(withRegions(OPENCODE_GO_PRESET, { default: ON })));
    await h.svc.connect(alice, dto({ credential: lookalike }));
    const stored = h.insert.mock.calls[0]![1].encryptedCredentials as string;
    expect(parseCredentialEnvelope(decryptSecret(stored, KEY))).toEqual({
      kind: 'plain',
      value: lookalike,
    });
  });

  it('a key without the hinted prefix is accepted', async () => {
    const h = harness(registryOf(withRegions(KIMI_CODE_PRESET, { intl: ON })));
    await expect(
      h.svc.connect(alice, dto({ preset: 'kimi-code', credential: 'not-a-kimi-key' })),
    ).resolves.toBeDefined();
  });

  it('a two-region preset with ONE offered region: region omitted and region named both succeed, unlabelled name', async () => {
    const h = harness(registryOf(withRegions(KIMI_CODE_PRESET, { intl: ON })));
    const omitted = await h.svc.connect(alice, dto({ preset: 'kimi-code' }));
    const named = await h.svc.connect(alice, dto({ preset: 'kimi-code', region: 'intl' }));
    for (const r of [omitted, named]) {
      expect(r.baseUrl).toBe('https://api.kimi.ai/coding/v1');
      expect(r.name).toBe('Kimi Code');
    }
  });

  it('two offered regions: the region is required and its label joins the default name', async () => {
    const h = harness(registryOf(withRegions(KIMI_CODE_PRESET, { intl: ON, cn: ON })));
    const cn = await h.svc.connect(alice, dto({ preset: 'kimi-code', region: 'cn' }));
    expect(cn.baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(cn.name).toBe('Kimi Code (China)');
  });

  it('an explicit name wins over the default', async () => {
    const h = harness(registryOf(withRegions(KIMI_CODE_PRESET, { intl: ON, cn: ON })));
    const row = await h.svc.connect(
      alice,
      dto({ preset: 'kimi-code', region: 'intl', name: 'mine' }),
    );
    expect(row.name).toBe('mine');
  });

  it('a high-risk preset connects with the acknowledgement, which is not stored', async () => {
    const h = harness(registryOf(withRegions(ZAI_CODING_PLAN_PRESET, { intl: ON })));
    await h.svc.connect(alice, dto({ preset: 'zai-coding-plan', acknowledgeTermsRisk: true }));
    expect(JSON.stringify(h.insert.mock.calls[0]![1])).not.toMatch(/acknowledge/i);
  });

  it('stores a declared max-tokens spelling, and none otherwise', async () => {
    const h = harness(
      registryOf(
        withRegions(OPENCODE_GO_PRESET, {
          default: { enabled: true, maxTokensSpelling: 'max_tokens' },
        }),
        withRegions(KIMI_CODE_PRESET, { intl: ON }),
      ),
    );
    await h.svc.connect(alice, dto());
    expect(h.insert.mock.calls[0]![1].maxTokensSpelling).toBe('max_tokens');
    await h.svc.connect(alice, dto({ preset: 'kimi-code' }));
    expect(h.insert.mock.calls[1]![1]).not.toHaveProperty('maxTokensSpelling');
  });
});

describe('SubscriptionPresetsService.listAvailable', () => {
  it('lists only offered regions, host-only, with no URL beyond the terms link and no identity', () => {
    const h = harness(
      registryOf(
        withRegions(OPENCODE_GO_PRESET, { default: ON }),
        withRegions(KIMI_CODE_PRESET, { intl: ON }),
        withRegions(MINIMAX_M_PLAN_PRESET, {}),
      ),
    );
    const list = h.svc.listAvailable();
    expect(list.map((p) => p.id)).toEqual(['opencode-go', 'kimi-code']);
    expect(list[1]!.regions).toEqual([
      { id: 'intl', label: 'International', host: 'api.kimi.ai', imitationRequired: false },
    ]);
    const json = JSON.stringify(list);
    expect(json).not.toContain('inference/go/v1/models');
    expect(json).not.toContain('https://api.kimi.ai');
    expect(json).not.toMatch(/clientIdentity|apiHeaders|User-Agent|claude-|label":"Claude/);
    expect(Object.keys(list[0]!).sort()).toEqual(
      [
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
  });

  it('says whether a preset declares an identity, as a boolean only (redesign-subscription-picker D3)', () => {
    const h = harness(defaultKeyPresetRegistry);
    const byId = Object.fromEntries(h.svc.listAvailable().map((p) => [p.id, p.declaresIdentity]));
    expect(byId).toEqual({
      'opencode-go': false,
      'minimax-m-plan': false,
      'kimi-code': true,
      'zai-coding-plan': true,
    });
    // The fixture really declares identity values, so their absence below is not vacuous.
    expect(KIMI_CODE_PRESET.clientIdentity?.apiHeaders['User-Agent']).toMatch(/^claude-code\//);
    const json = JSON.stringify(h.svc.listAvailable());
    expect(json).not.toMatch(
      /claude-code\/|claude-cli\/|User-Agent|apiHeaders|"label":"Claude Code"/,
    );
  });

  it('never exposes the plan-error dialect', () => {
    const h = harness(
      registryOf(
        withRegions(MINIMAX_M_PLAN_PRESET, { intl: ON }),
        withRegions(KIMI_CODE_PRESET, { intl: ON, cn: ON }),
        withRegions(ZAI_CODING_PLAN_PRESET, { intl: ON }),
      ),
    );
    // The fixture really declares dialects, so the absence below is not vacuous.
    expect(KIMI_CODE_PRESET.regions[0]!.errorDialect).toBe('kimi');
    const json = JSON.stringify(h.svc.listAvailable());
    expect(json).not.toMatch(/errorDialect|dialect|zai"|minimax"/i);
    for (const preset of h.svc.listAvailable()) {
      for (const region of preset.regions) {
        expect(Object.keys(region).sort()).toEqual(['host', 'id', 'imitationRequired', 'label']);
      }
    }
  });

  it('never exposes the plan-usage dialect or probe (add-subscription-quota-display)', () => {
    const h = harness(
      registryOf(
        withRegions(OPENCODE_GO_PRESET, { default: ON }),
        withRegions(MINIMAX_M_PLAN_PRESET, { intl: ON }),
        withRegions(KIMI_CODE_PRESET, { intl: ON, cn: ON }),
        withRegions(ZAI_CODING_PLAN_PRESET, { intl: ON, cn: ON }),
      ),
    );
    // The fixture really declares both, so the absence below is not vacuous.
    expect(OPENCODE_GO_PRESET.regions[0]!.usageDialect).toBe('opencode_go');
    expect(KIMI_CODE_PRESET.regions[0]!.usageProbe).toBeDefined();
    const list = h.svc.listAvailable();
    const json = JSON.stringify(list);
    expect(json).not.toMatch(
      /usageDialect|usageProbe|"probe"|"dialect"|opencode_go|zen\/go|token_plan|quota\/limit|\/usages/i,
    );
    for (const preset of list) {
      for (const region of preset.regions) {
        expect(Object.keys(region).sort()).toEqual(['host', 'id', 'imitationRequired', 'label']);
      }
    }
  });

  it('flags acknowledgement for a high preset and for an imitation-required region', () => {
    const h = harness(
      registryOf(
        withRegions(ZAI_CODING_PLAN_PRESET, { intl: ON }),
        withRegions(OPENCODE_GO_PRESET, { default: { enabled: true, imitationRequired: true } }),
        withRegions(KIMI_CODE_PRESET, { intl: ON }),
      ),
    );
    const by = Object.fromEntries(h.svc.listAvailable().map((p) => [p.id, p]));
    expect(by['zai-coding-plan']).toMatchObject({
      termsRisk: 'high',
      requiresAcknowledgement: true,
    });
    expect(by['opencode-go']).toMatchObject({ termsRisk: 'high', requiresAcknowledgement: true });
    expect(by['opencode-go']!.regions[0]!.imitationRequired).toBe(true);
    expect(by['kimi-code']).toMatchObject({ termsRisk: 'medium', requiresAcknowledgement: false });
  });

  it('takes no principal, so it cannot vary by one', () => {
    const h = harness(registryOf(withRegions(OPENCODE_GO_PRESET, { default: ON })));
    expect(h.svc.listAvailable()).toEqual(h.svc.listAvailable());
  });
});

describe('KeyPresetConnectDto validation (global whitelist + forbid)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const run = (body: unknown): Promise<unknown> =>
    pipe.transform(body, { type: 'body', metatype: KeyPresetConnectDto });

  it('accepts the five documented fields', async () => {
    await expect(
      run({ preset: 'p', region: 'r', name: 'n', credential: 'k', acknowledgeTermsRisk: true }),
    ).resolves.toBeDefined();
    await expect(run({ preset: 'p', credential: 'k' })).resolves.toBeDefined();
  });

  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['an empty credential', { preset: 'p', credential: '' }],
    ['a missing credential', { preset: 'p' }],
    ['a missing preset', { credential: 'k' }],
    ['an over-8192 credential', { preset: 'p', credential: 'x'.repeat(8193) }],
    ['a newline in the credential', { preset: 'p', credential: 'a\nb' }],
    ['a NUL in the credential', { preset: 'p', credential: 'a\u0000b' }],
    ['a DEL in the credential', { preset: 'p', credential: 'a\u007fb' }],
    ['a non-Latin-1 credential', { preset: 'p', credential: 'ключ' }],
    ['a credential character above U+00FF', { preset: 'p', credential: 'kĀ' }],
    ['a non-string credential', { preset: 'p', credential: 5 }],
    ['an empty name', { preset: 'p', credential: 'k', name: '' }],
    ['an 81-char name', { preset: 'p', credential: 'k', name: 'x'.repeat(81) }],
    [
      'a non-boolean acknowledgement',
      { preset: 'p', credential: 'k', acknowledgeTermsRisk: 'yes' },
    ],
    ['a null acknowledgement', { preset: 'p', credential: 'k', acknowledgeTermsRisk: null }],
    ['baseUrl', { preset: 'p', credential: 'k', baseUrl: 'https://evil.example/v1' }],
    ['protocol', { preset: 'p', credential: 'k', protocol: 'openai_compatible' }],
    ['kind', { preset: 'p', credential: 'k', kind: 'api_key' }],
    ['keyPreset', { preset: 'p', credential: 'k', keyPreset: 'zai-coding-plan' }],
    ['imitateClientIdentity', { preset: 'p', credential: 'k', imitateClientIdentity: true }],
  ];
  it.each(bad)('rejects %s', async (_n, body) => {
    await expect(run(body)).rejects.toMatchObject({ status: 400 });
  });

  it('accepts an 8192-character credential', async () => {
    await expect(run({ preset: 'p', credential: 'x'.repeat(8192) })).resolves.toBeDefined();
  });
});

describe('SubscriptionPresetsModule wiring (design D6)', () => {
  const providers = Reflect.getMetadata('providers', SubscriptionPresetsModule) as Array<
    Record<string, unknown> | (new (...a: never[]) => unknown)
  >;

  it('binds KEY_PRESET_LOOKUP with useValue of the bundled registry, no factory', () => {
    const binding = providers.find(
      (p): p is Record<string, unknown> =>
        typeof p === 'object' && p['provide'] === KEY_PRESET_LOOKUP,
    );
    expect(binding).toBeDefined();
    expect(binding!['useValue']).toBe(defaultKeyPresetRegistry);
    for (const k of ['useFactory', 'useClass', 'useExisting', 'inject']) {
      expect(binding).not.toHaveProperty(k);
    }
    // Exactly one binding of the token.
    expect(
      providers.filter((p) => typeof p === 'object' && p['provide'] === KEY_PRESET_LOOKUP),
    ).toHaveLength(1);
  });

  it('registers the controller and resolves the runtime like the OAuth module does', () => {
    expect(Reflect.getMetadata('controllers', SubscriptionPresetsModule)).toEqual([
      KeyPresetsController,
    ]);
    expect(providers.some((p) => typeof p === 'object' && p['provide'] === PROVIDERS_RUNTIME)).toBe(
      true,
    );
  });

  it('the controller mounts under api/providers with two-segment literal routes', () => {
    expect(Reflect.getMetadata('path', KeyPresetsController)).toBe('api/providers');
    const paths = ['listAvailable', 'connect'].map((m) =>
      Reflect.getMetadata('path', KeyPresetsController.prototype[m as 'listAvailable']),
    );
    expect(paths).toEqual(['key-presets/available', 'key-presets/connect']);
  });
});
