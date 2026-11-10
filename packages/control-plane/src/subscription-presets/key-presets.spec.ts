// add-key-subscription-presets — registry invariants and the coherence gate.
import { PLAN_USAGE_PARSER_IDS } from '@polyrouter/data-plane';
import { isValidClientIdentity, validateClientIdentity } from '../providers/client-identity';
import { OAUTH_PRESETS } from '../subscription-oauth/presets';
import {
  KEY_PRESETS,
  KEY_PRESET_LOOKUP,
  KIMI_CODE_PRESET,
  MINIMAX_M_PLAN_PRESET,
  OPENCODE_GO_PRESET,
  ZAI_CODING_PLAN_PRESET,
  defaultKeyPresetRegistry,
  findKeyPreset,
  keyPresetForRow,
  listOfferedKeyPresets,
  offeredRegions,
  type KeyPreset,
  type KeyPresetRegion,
  type KeyPresetRegistry,
  type KeyPresetRow,
} from './key-presets';

const allRegions = KEY_PRESETS.flatMap((preset) =>
  preset.regions.map((region) => ({ preset, region })),
);

/** A copy of `preset` with its region flags overridden, to exercise the helpers on a
 * registry the shipped (all-enabled) constants cannot show: a withdrawn region. */
function withRegions(
  preset: KeyPreset,
  flags: Readonly<Record<string, Partial<KeyPresetRegion>>>,
): KeyPreset {
  return {
    ...preset,
    regions: preset.regions.map((r) => ({ ...r, ...(flags[r.id] ?? {}) })),
  };
}

function registryOf(...presets: KeyPreset[]): KeyPresetRegistry {
  return { find: (id) => presets.find((p) => p.id === id), list: () => presets };
}

describe('key-preset registry invariants', () => {
  it('ships exactly the four coding-plan presets', () => {
    expect(KEY_PRESETS.map((p) => p.id)).toEqual([
      'opencode-go',
      'minimax-m-plan',
      'kimi-code',
      'zai-coding-plan',
    ]);
  });

  it('every URL is https and equals new URL(x).href', () => {
    for (const { preset, region } of allRegions) {
      const urls = [region.baseUrl, region.modelsUrl, preset.termsUrl].filter(
        (u): u is string => u !== undefined,
      );
      for (const url of urls) {
        const parsed = new URL(url);
        expect({ preset: preset.id, region: region.id, url, protocol: parsed.protocol }).toEqual({
          preset: preset.id,
          region: region.id,
          url,
          protocol: 'https:',
        });
        expect(parsed.href).toBe(url);
      }
    }
  });

  it('each modelsUrl shares its region origin', () => {
    for (const { region } of allRegions) {
      if (region.modelsUrl !== undefined) {
        expect(new URL(region.modelsUrl).origin).toBe(new URL(region.baseUrl).origin);
      }
    }
  });

  it('only OpenCode Go carries a listing override', () => {
    const withOverride = allRegions.filter(({ region }) => region.modelsUrl !== undefined);
    expect(withOverride.map(({ preset }) => preset.id)).toEqual(['opencode-go']);
    expect(OPENCODE_GO_PRESET.regions[0]!.modelsUrl).toBe(
      'https://opencode.ai/inference/go/v1/models',
    );
  });

  it('pins every region to an OpenAI-compatible coding endpoint', () => {
    for (const { region } of allRegions) expect(region.protocol).toBe('openai_compatible');
    expect(ZAI_CODING_PLAN_PRESET.regions.map((r) => r.baseUrl)).toEqual([
      'https://api.z.ai/api/coding/paas/v4',
      'https://open.bigmodel.cn/api/coding/paas/v4',
    ]);
    expect(KIMI_CODE_PRESET.regions.map((r) => r.baseUrl)).toEqual([
      'https://api.kimi.ai/coding/v1',
      'https://api.kimi.com/coding/v1',
    ]);
    expect(MINIMAX_M_PLAN_PRESET.regions.map((r) => r.baseUrl)).toEqual([
      'https://api.minimax.io/v1',
      'https://api.minimaxi.com/v1',
    ]);
    expect(OPENCODE_GO_PRESET.regions.map((r) => r.baseUrl)).toEqual([
      'https://opencode.ai/inference/go/openai/v1',
    ]);
  });

  it('preset ids are unique and disjoint from the OAuth preset ids; region ids are unique per preset', () => {
    const ids = KEY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const oauthIds = new Set(OAUTH_PRESETS.map((p) => p.id));
    for (const id of ids) expect(oauthIds.has(id)).toBe(false);
    for (const preset of KEY_PRESETS) {
      const regionIds = preset.regions.map((r) => r.id);
      expect({ preset: preset.id, unique: new Set(regionIds).size }).toEqual({
        preset: preset.id,
        unique: regionIds.length,
      });
    }
  });

  it('no two regions anywhere share a (baseUrl, protocol) pin', () => {
    const pins = allRegions.map(({ region }) => `${region.protocol} ${region.baseUrl}`);
    expect(new Set(pins).size).toBe(pins.length);
  });

  it('no preset or region field names a model', () => {
    // A bundled model id goes stale the day the upstream retires it; Test is the listing.
    for (const preset of KEY_PRESETS) {
      for (const key of Object.keys(preset)) expect(key).not.toMatch(/model/i);
      for (const region of preset.regions) {
        for (const key of Object.keys(region)) {
          // `modelsUrl` is the LISTING endpoint, not a model id.
          if (key !== 'modelsUrl') expect(key).not.toMatch(/model/i);
        }
      }
      expect(JSON.stringify(preset)).not.toMatch(
        /"(gpt|claude|glm|kimi-for|k[0-9]|deepseek|qwen)[-0-9.a-z]*"/i,
      );
    }
  });

  it('only Z.ai is high risk, and an imitation-required region forces high', () => {
    expect(KEY_PRESETS.filter((p) => p.risk === 'high').map((p) => p.id)).toEqual([
      'zai-coding-plan',
    ]);
    expect(OPENCODE_GO_PRESET.risk).toBe('low');
    expect(MINIMAX_M_PLAN_PRESET.risk).toBe('low');
    expect(KIMI_CODE_PRESET.risk).toBe('medium');
    for (const preset of KEY_PRESETS) {
      if (preset.regions.some((r) => r.imitationRequired)) expect(preset.risk).toBe('high');
    }
  });

  it('every preset carries risk copy and an https terms link', () => {
    for (const preset of KEY_PRESETS) {
      expect(preset.riskCopy.length).toBeGreaterThan(20);
      expect(preset.termsUrl.startsWith('https://')).toBe(true);
    }
  });

  it('hints: only Kimi hints a prefix; sk-cp- is held back; Z.ai carries a key-type note', () => {
    expect(KIMI_CODE_PRESET.keyHint?.prefix).toBe('sk-kimi-');
    expect(OPENCODE_GO_PRESET.keyHint).toBeNull();
    // `sk-cp-` is [U]: never shown while unverified.
    expect(MINIMAX_M_PLAN_PRESET.keyHint).toBeNull();
    expect(JSON.stringify(MINIMAX_M_PLAN_PRESET)).not.toContain('sk-cp-');
    const zai = ZAI_CODING_PLAN_PRESET.keyHint;
    expect(zai?.prefix).toBeNull();
    expect(zai?.note).toContain('Personal Coding Plan');
    expect(zai?.note).toContain('2026-10-16');
    expect(zai?.note).toContain('key type');
  });

  it('every region ships enabled and not imitation-required (redesign-subscription-picker)', () => {
    // The runbooks are optional QA; a region found broken is withdrawn by shipping it false.
    for (const { preset, region } of allRegions) {
      expect({ preset: preset.id, region: region.id, enabled: region.enabled }).toEqual({
        preset: preset.id,
        region: region.id,
        enabled: true,
      });
      expect(region.imitationRequired).toBe(false);
    }
  });

  it('no region declares a max-tokens spelling before its runbook decides one', () => {
    for (const { region } of allRegions) expect(region.maxTokensSpelling).toBeUndefined();
  });

  it('the default registry reads the bundled constants', () => {
    expect(defaultKeyPresetRegistry.list()).toBe(KEY_PRESETS);
    expect(defaultKeyPresetRegistry.find('kimi-code')).toBe(KIMI_CODE_PRESET);
    expect(findKeyPreset('kimi-code')).toBe(KIMI_CODE_PRESET);
    expect(findKeyPreset('claude')).toBeUndefined();
    expect(KEY_PRESET_LOOKUP).toBe('polyrouter:key-preset-lookup');
  });
});

describe('model-API identity declarations (task 7.1)', () => {
  const declaring = KEY_PRESETS.filter((p) => p.clientIdentity !== undefined);

  it('only Kimi Code and Z.ai declare one; OpenCode Go and MiniMax declare nothing', () => {
    expect(declaring.map((p) => p.id)).toEqual(['kimi-code', 'zai-coding-plan']);
    expect(OPENCODE_GO_PRESET.clientIdentity).toBeUndefined();
    expect(MINIMAX_M_PLAN_PRESET.clientIdentity).toBeUndefined();
    expect(Object.keys(OPENCODE_GO_PRESET)).not.toContain('clientIdentity');
    expect(Object.keys(MINIMAX_M_PLAN_PRESET)).not.toContain('clientIdentity');
  });

  it('every declaration passes allow-preset-client-identity validation', () => {
    for (const preset of declaring) {
      expect({
        preset: preset.id,
        problems: validateClientIdentity(preset.clientIdentity!),
      }).toEqual({
        preset: preset.id,
        problems: [],
      });
      expect(isValidClientIdentity(preset.clientIdentity!)).toBe(true);
    }
  });

  it('is labelled "Claude Code", model-API only (no token identity), and carries a User-Agent', () => {
    for (const preset of declaring) {
      const identity = preset.clientIdentity!;
      expect(identity.label).toBe('Claude Code');
      expect(identity.tokenHeaders).toBeUndefined();
      expect(Object.keys(identity.apiHeaders).map((n) => n.toLowerCase())).toContain('user-agent');
    }
  });

  it('Kimi declares a claude-code/ User-Agent and never KimiCLI/ in any value or name', () => {
    const headers = KIMI_CODE_PRESET.clientIdentity!.apiHeaders;
    expect(headers['User-Agent']).toMatch(/^claude-code\/\d+\.\d+\.\d+/);
    // X-Msh-Platform is added only if the group 11 runbook shows the allow-list needs it.
    expect(Object.keys(headers)).toEqual(['User-Agent']);
    expect(JSON.stringify(KIMI_CODE_PRESET.clientIdentity)).not.toContain('KimiCLI/');
    for (const preset of KEY_PRESETS) {
      expect(JSON.stringify(preset)).not.toContain('KimiCLI/');
    }
  });

  it('Z.ai declares the Claude Code User-Agent', () => {
    expect(ZAI_CODING_PLAN_PRESET.clientIdentity!.apiHeaders['User-Agent']).toMatch(
      /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/,
    );
  });

  it('no identity value can be mistaken for polyrouter’s own User-Agent', () => {
    for (const preset of declaring) {
      for (const value of Object.values(preset.clientIdentity!.apiHeaders)) {
        expect(value).not.toMatch(/polyrouter/i);
      }
    }
  });
});

describe('offeredRegions and listOfferedKeyPresets', () => {
  it('offeredRegions returns enabled regions only, an enabled imitation-required one included', () => {
    const withdrawn = withRegions(KIMI_CODE_PRESET, {
      intl: { enabled: false },
      cn: { enabled: false },
    });
    expect(offeredRegions(withdrawn)).toEqual([]);
    const kimi = withRegions(KIMI_CODE_PRESET, { cn: { enabled: false } });
    expect(offeredRegions(kimi).map((r) => r.id)).toEqual(['intl']);
    const both = withRegions(KIMI_CODE_PRESET, {
      intl: { enabled: true, imitationRequired: true },
      cn: { enabled: true },
    });
    expect(offeredRegions(both).map((r) => r.id)).toEqual(['intl', 'cn']);
    expect(offeredRegions(both)[0]!.imitationRequired).toBe(true);
  });

  it('the shipped registry lists all four presets with seven regions, in registry order', () => {
    const listed = listOfferedKeyPresets(defaultKeyPresetRegistry);
    expect(listed.map((p) => [p.id, p.regions.map((r) => r.id)])).toEqual([
      ['opencode-go', ['default']],
      ['minimax-m-plan', ['intl', 'cn']],
      ['kimi-code', ['intl', 'cn']],
      ['zai-coding-plan', ['intl', 'cn']],
    ]);
  });

  it('omits withdrawn presets and regions, and a preset with no offered region', () => {
    const registry = registryOf(
      OPENCODE_GO_PRESET,
      withRegions(MINIMAX_M_PLAN_PRESET, { cn: { enabled: false } }), // cn withdrawn
      withRegions(KIMI_CODE_PRESET, { intl: { enabled: false }, cn: { enabled: false } }),
      ZAI_CODING_PLAN_PRESET,
    );
    const listed = listOfferedKeyPresets(registry);
    expect(listed.map((p) => [p.id, p.regions.map((r) => r.id)])).toEqual([
      ['opencode-go', ['default']],
      ['minimax-m-plan', ['intl']],
      ['zai-coding-plan', ['intl', 'cn']],
    ]);
    // the source constants are not mutated by listing
    expect(MINIMAX_M_PLAN_PRESET.regions).toHaveLength(2);
  });
});

describe('region plan-error dialects (classify-plan-quota-errors, design D2)', () => {
  // Declared per REGION, only where task 1.3 recorded the region's error reference as
  // matching the dialect table (apply-log; flag F1).
  it.each([
    ['opencode-go', 'default', undefined],
    ['minimax-m-plan', 'intl', 'minimax'],
    ['minimax-m-plan', 'cn', undefined],
    ['kimi-code', 'intl', 'kimi'],
    ['kimi-code', 'cn', 'kimi'],
    ['zai-coding-plan', 'intl', 'zai'],
    ['zai-coding-plan', 'cn', undefined],
  ] as const)('%s / %s declares %s', (presetId, regionId, dialect) => {
    const region = findKeyPreset(presetId)?.regions.find((r) => r.id === regionId);
    expect(region).toBeDefined();
    expect(region?.errorDialect).toBe(dialect);
  });

  it('covers every shipped region, so a new region must decide', () => {
    expect(allRegions).toHaveLength(7);
  });

  it('the dialect reaches a row only through the coherence gate', () => {
    const region = ZAI_CODING_PLAN_PRESET.regions[0]!;
    const row = (over: Partial<KeyPresetRow>): KeyPresetRow => ({
      kind: 'subscription',
      baseUrl: region.baseUrl,
      protocol: region.protocol,
      keyPreset: 'zai-coding-plan',
      ...over,
    });
    expect(keyPresetForRow(row({}))?.region.errorDialect).toBe('zai');
    // A drifted host, an unbound row and an api_key row never resolve a region at all.
    expect(keyPresetForRow(row({ baseUrl: 'https://api.z.ai/api/paas/v4' }))).toBeNull();
    expect(keyPresetForRow(row({ keyPreset: null }))).toBeNull();
    expect(keyPresetForRow(row({ kind: 'api_key' }))).toBeNull();
  });
});

describe('keyPresetForRow (the D6 coherence gate)', () => {
  const rowFor = (
    preset: KeyPreset,
    region: KeyPresetRegion,
    over: Partial<KeyPresetRow> = {},
  ): KeyPresetRow => ({
    kind: 'subscription',
    baseUrl: region.baseUrl,
    protocol: region.protocol,
    keyPreset: preset.id,
    ...over,
  });

  it('matches every pin, a withdrawn region included (it ignores enabled)', () => {
    for (const { preset, region } of allRegions) {
      const match = keyPresetForRow(rowFor(preset, region));
      expect(match?.preset).toBe(preset);
      expect(match?.region).toBe(region);
    }
    // A withdrawn region's row still resolves: the gate reads the bundled pins, not the flag.
    const withdrawn = withRegions(KIMI_CODE_PRESET, { cn: { enabled: false } });
    const cn = withdrawn.regions[1]!;
    expect(cn.enabled).toBe(false);
    expect(keyPresetForRow(rowFor(withdrawn, cn))?.region.id).toBe('cn');
  });

  it('resolves the region by pin, not by preset alone', () => {
    const [intl, cn] = KIMI_CODE_PRESET.regions as [KeyPresetRegion, KeyPresetRegion];
    expect(keyPresetForRow(rowFor(KIMI_CODE_PRESET, cn))?.region.id).toBe('cn');
    expect(keyPresetForRow(rowFor(KIMI_CODE_PRESET, intl))?.region.id).toBe('intl');
  });

  it('returns null for a drifted base_url', () => {
    const region = ZAI_CODING_PLAN_PRESET.regions[0]!;
    for (const baseUrl of [
      'https://api.z.ai/api/paas/v4', // the pay-as-you-go path
      'https://api.z.ai/api/coding/paas/v4/',
      'https://evil.example/api/coding/paas/v4',
      null,
    ]) {
      expect(keyPresetForRow(rowFor(ZAI_CODING_PLAN_PRESET, region, { baseUrl }))).toBeNull();
    }
  });

  it('returns null for a different protocol', () => {
    const region = KIMI_CODE_PRESET.regions[0]!;
    expect(
      keyPresetForRow(rowFor(KIMI_CODE_PRESET, region, { protocol: 'anthropic_compatible' })),
    ).toBeNull();
  });

  it('returns null for a non-subscription kind', () => {
    const region = KIMI_CODE_PRESET.regions[0]!;
    for (const kind of ['api_key', 'custom', 'local']) {
      expect(keyPresetForRow(rowFor(KIMI_CODE_PRESET, region, { kind }))).toBeNull();
    }
  });

  it('returns null for an unknown or absent marker, and for an OAuth preset id', () => {
    const region = KIMI_CODE_PRESET.regions[0]!;
    for (const keyPreset of ['not-a-preset', 'claude', 'chatgpt', '', null]) {
      expect(keyPresetForRow(rowFor(KIMI_CODE_PRESET, region, { keyPreset }))).toBeNull();
    }
  });

  it('a marker naming a different preset does not borrow another preset’s pin', () => {
    const kimiRegion = KIMI_CODE_PRESET.regions[0]!;
    expect(
      keyPresetForRow(rowFor(KIMI_CODE_PRESET, kimiRegion, { keyPreset: 'zai-coding-plan' })),
    ).toBeNull();
  });
});

describe('region plan-usage sources (add-subscription-quota-display, design D1/D7)', () => {
  const probes = allRegions.flatMap(({ preset, region }) =>
    region.usageProbe === undefined ? [] : [{ preset, region, probe: region.usageProbe }],
  );

  // The D7 table, pinned: a probe exists exactly where the research verified a host.
  it.each([
    ['opencode-go', 'default', 'opencode_go', 'https://opencode.ai/zen/go/v1/usage'],
    ['minimax-m-plan', 'intl', undefined, 'https://api.minimax.io/v1/token_plan/remains'],
    ['minimax-m-plan', 'cn', undefined, undefined],
    ['kimi-code', 'intl', undefined, 'https://api.kimi.ai/coding/v1/usages'],
    ['kimi-code', 'cn', undefined, 'https://api.kimi.com/coding/v1/usages'],
    ['zai-coding-plan', 'intl', undefined, 'https://api.z.ai/api/monitor/usage/quota/limit'],
    ['zai-coding-plan', 'cn', undefined, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'],
  ] as const)('%s / %s declares dialect %s and probe %s', (presetId, regionId, dialect, url) => {
    const region = findKeyPreset(presetId)?.regions.find((r) => r.id === regionId);
    expect(region).toBeDefined();
    expect(region?.usageDialect).toBe(dialect);
    expect(region?.usageProbe?.url).toBe(url);
  });

  it('covers every shipped region, so a new region must decide', () => {
    expect(allRegions).toHaveLength(7);
    expect(probes).toHaveLength(6);
  });

  it('every probe URL is https, canonical, and same-origin with its region baseUrl', () => {
    for (const { preset, region, probe } of probes) {
      const parsed = new URL(probe.url);
      const where = { preset: preset.id, region: region.id, url: probe.url };
      expect({ ...where, protocol: parsed.protocol }).toEqual({ ...where, protocol: 'https:' });
      expect({ ...where, href: parsed.href }).toEqual({ ...where, href: probe.url });
      expect({ ...where, origin: parsed.origin }).toEqual({
        ...where,
        origin: new URL(region.baseUrl).origin,
      });
      // No credentials, query or fragment ride a bundled constant.
      expect(parsed.username + parsed.password + parsed.search + parsed.hash).toBe('');
    }
  });

  it('every probe ships enabled (add-subscription-usage-history, design D3): false withdraws one', () => {
    for (const { preset, region, probe } of probes) {
      expect({ preset: preset.id, region: region.id, enabled: probe.enabled }).toEqual({
        preset: preset.id,
        region: region.id,
        enabled: true,
      });
    }
  });

  it('no key-preset probe names an extra header (only the OAuth presets need one)', () => {
    for (const { probe } of probes) expect(probe.extraHeaders).toBeUndefined();
  });

  it('every probe sends a Bearer key, and names a parser the data plane owns', () => {
    for (const { probe } of probes) {
      expect(probe.auth).toBe('bearer');
      expect(PLAN_USAGE_PARSER_IDS).toContain(probe.parser);
    }
  });

  it('no probe reaches a Kimi /me, a /wham, an /api/oauth/ or a /backend-api/accounts path', () => {
    for (const { probe } of probes) {
      const path = new URL(probe.url).pathname;
      expect(path).not.toMatch(/\/me(\/|$)/);
      expect(path).not.toContain('/wham');
      expect(path).not.toContain('/api/oauth/');
      expect(path).not.toContain('/backend-api/accounts');
    }
  });

  it('a probe never sits on a pay-as-you-go path, and no probe URL is a region baseUrl or listing', () => {
    for (const { region, probe } of probes) {
      expect(probe.url).not.toContain('/paas/v4/');
      expect(probe.url).not.toBe(region.baseUrl);
      expect(probe.url).not.toBe(region.modelsUrl);
    }
  });

  it('only OpenCode Go declares a passive usage dialect', () => {
    const dialects = allRegions
      .filter(({ region }) => region.usageDialect !== undefined)
      .map(({ preset, region }) => `${preset.id}/${region.id}:${String(region.usageDialect)}`);
    expect(dialects).toEqual(['opencode-go/default:opencode_go']);
  });

  it('each parser matches its host: no Kimi parser on a Z.ai URL and so on', () => {
    for (const { preset, probe } of probes) {
      const expected: Record<string, string> = {
        'opencode-go': 'opencode_go_usage',
        'minimax-m-plan': 'minimax_remains',
        'kimi-code': 'kimi_usages',
        'zai-coding-plan': 'zai_quota_limit',
      };
      expect(probe.parser).toBe(expected[preset.id]);
    }
  });
});
