// add-subscription-quota-display task 5.2: ONE lookup, ONE pin test. `planUsageSourcesFor`
// reuses `identityBindingFor` and `bindingMatches`, so identity and plan usage cannot disagree
// about which rows are coherent.
import type { ProviderRow } from '@polyrouter/shared/server';
import {
  bindingMatches,
  clientIdentityFor,
  type IdentityBinding,
  type PresetClientIdentity,
} from '../providers/client-identity';
import {
  CHATGPT_PRESET,
  CLAUDE_PRESET,
  OAUTH_PRESETS,
  type OauthPreset,
} from '../subscription-oauth/presets';
import { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import {
  KEY_PRESETS,
  KIMI_CODE_PRESET,
  OPENCODE_GO_PRESET,
  ZAI_CODING_PLAN_PRESET,
  defaultKeyPresetRegistry,
  type KeyPreset,
  type KeyPresetRegion,
} from '../subscription-presets/key-presets';
import { planUsageSourcesFor } from './plan-usage-sources';

/** The REAL `identityBindingFor`, over the bundled registries, with no other collaborator: the
 * lookup is a pure read of `presets` and the bundled key-preset constants. */
const oauth = Object.create(SubscriptionOauthService.prototype) as SubscriptionOauthService;
(oauth as unknown as { presets: unknown }).presets = {
  find: (id: string): OauthPreset | undefined => OAUTH_PRESETS.find((p) => p.id === id),
  list: (): readonly OauthPreset[] => OAUTH_PRESETS,
};

type Row = Pick<ProviderRow, 'kind' | 'baseUrl' | 'protocol' | 'oauthPreset' | 'keyPreset'>;

function oauthRow(preset: OauthPreset, over: Partial<Row> = {}): Row {
  return {
    kind: 'subscription',
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    oauthPreset: preset.id,
    keyPreset: null,
    ...over,
  };
}

function keyRow(preset: KeyPreset, region: KeyPresetRegion, over: Partial<Row> = {}): Row {
  return {
    kind: 'subscription',
    baseUrl: region.baseUrl,
    protocol: region.protocol,
    oauthPreset: null,
    keyPreset: preset.id,
    ...over,
  };
}

const sourcesOf = (row: Row) => planUsageSourcesFor(row, oauth.identityBindingFor(row));

describe('planUsageSourcesFor (task 5.2)', () => {
  it('a coherent Claude row, ChatGPT row and OpenCode Go row each yield their dialect', () => {
    expect(sourcesOf(oauthRow(CLAUDE_PRESET))).toEqual({ dialect: 'anthropic_unified' });
    expect(sourcesOf(oauthRow(CHATGPT_PRESET))).toEqual({ dialect: 'codex' });
    const go = OPENCODE_GO_PRESET.regions[0]!;
    expect(sourcesOf(keyRow(OPENCODE_GO_PRESET, go))).toEqual({
      dialect: 'opencode_go',
      probe: go.usageProbe,
    });
  });

  it('a Kimi row yields its probe, and no dialect', () => {
    for (const region of KIMI_CODE_PRESET.regions) {
      const sources = sourcesOf(keyRow(KIMI_CODE_PRESET, region));
      expect(sources).toEqual({ probe: region.usageProbe });
      expect(sources?.dialect).toBeUndefined();
      expect(sources?.probe?.parser).toBe('kimi_usages');
    }
  });

  it('every shipped region resolves exactly what it declares', () => {
    for (const preset of KEY_PRESETS) {
      for (const region of preset.regions) {
        const sources = sourcesOf(keyRow(preset, region));
        if (region.usageDialect === undefined && region.usageProbe === undefined) {
          expect(sources).toBeNull(); // MiniMax China declares nothing
        } else {
          expect(sources?.dialect).toBe(region.usageDialect);
          expect(sources?.probe).toBe(region.usageProbe);
        }
      }
    }
  });

  it('a drifted OAuth row (changed base_url or protocol) yields null', () => {
    expect(sourcesOf(oauthRow(CLAUDE_PRESET, { baseUrl: 'https://proxy.example/' }))).toBeNull();
    expect(sourcesOf(oauthRow(CLAUDE_PRESET, { baseUrl: 'https://api.anthropic.com' }))).toBeNull();
    expect(sourcesOf(oauthRow(CLAUDE_PRESET, { protocol: 'openai_compatible' }))).toBeNull();
    expect(sourcesOf(oauthRow(CHATGPT_PRESET, { protocol: 'openai_compatible' }))).toBeNull();
    expect(
      sourcesOf(oauthRow(CHATGPT_PRESET, { baseUrl: 'https://chatgpt.com/backend/' })),
    ).toBeNull();
  });

  it('an OAuth row whose kind is not subscription yields null', () => {
    for (const kind of ['api_key', 'custom', 'local']) {
      expect(sourcesOf(oauthRow(CLAUDE_PRESET, { kind }))).toBeNull();
      expect(sourcesOf(oauthRow(CHATGPT_PRESET, { kind }))).toBeNull();
    }
  });

  it('a drifted key-preset row yields null', () => {
    const go = OPENCODE_GO_PRESET.regions[0]!;
    const kimi = KIMI_CODE_PRESET.regions[0]!;
    expect(sourcesOf(keyRow(OPENCODE_GO_PRESET, go, { baseUrl: `${go.baseUrl}/` }))).toBeNull();
    expect(
      sourcesOf(keyRow(KIMI_CODE_PRESET, kimi, { baseUrl: 'https://evil.example/' })),
    ).toBeNull();
    expect(sourcesOf(keyRow(KIMI_CODE_PRESET, kimi, { baseUrl: null }))).toBeNull();
    expect(
      sourcesOf(keyRow(KIMI_CODE_PRESET, kimi, { protocol: 'anthropic_compatible' })),
    ).toBeNull();
    for (const kind of ['api_key', 'custom', 'local']) {
      expect(sourcesOf(keyRow(KIMI_CODE_PRESET, kimi, { kind }))).toBeNull();
    }
    // A marker naming another preset does not borrow that preset's pin or source.
    expect(sourcesOf(keyRow(KIMI_CODE_PRESET, kimi, { keyPreset: 'opencode-go' }))).toBeNull();
  });

  it('an "Other subscription" row yields null, even on a preset host', () => {
    const kimi = KIMI_CODE_PRESET.regions[0]!;
    // No marker and no OAuth preset: an ordinary pasted-credential subscription.
    expect(sourcesOf(keyRow(KIMI_CODE_PRESET, kimi, { keyPreset: null }))).toBeNull();
    expect(
      sourcesOf({
        kind: 'subscription',
        baseUrl: CLAUDE_PRESET.baseUrl,
        protocol: CLAUDE_PRESET.protocol,
        oauthPreset: null,
        keyPreset: null,
      }),
    ).toBeNull();
    // An unknown marker, and an OAuth preset id used as a key-preset marker.
    expect(sourcesOf(keyRow(KIMI_CODE_PRESET, kimi, { keyPreset: 'nope' }))).toBeNull();
    expect(sourcesOf(keyRow(KIMI_CODE_PRESET, kimi, { keyPreset: 'claude' }))).toBeNull();
  });

  it('a pay-as-you-go row on https://api.z.ai/api/paas/v4 yields null', () => {
    const zai = ZAI_CODING_PLAN_PRESET.regions[0]!;
    const payg = { baseUrl: 'https://api.z.ai/api/paas/v4', kind: 'api_key' };
    expect(sourcesOf(keyRow(ZAI_CODING_PLAN_PRESET, zai, payg))).toBeNull();
    // Even a marked, subscription-kind row on the pay-as-you-go path is not the coding pin.
    expect(
      sourcesOf(keyRow(ZAI_CODING_PLAN_PRESET, zai, { baseUrl: 'https://api.z.ai/api/paas/v4' })),
    ).toBeNull();
    expect(sourcesOf(keyRow(ZAI_CODING_PLAN_PRESET, zai, { keyPreset: null, ...payg }))).toBeNull();
  });

  it('no binding at all yields null, and a binding with no usage declaration yields null', () => {
    const row = oauthRow(CLAUDE_PRESET);
    expect(planUsageSourcesFor(row, undefined)).toBeNull();
    const bare: IdentityBinding = {
      identity: undefined,
      pin: { baseUrl: CLAUDE_PRESET.baseUrl, protocol: CLAUDE_PRESET.protocol },
    };
    expect(planUsageSourcesFor(row, bare)).toBeNull();
    expect(planUsageSourcesFor(row, { ...bare, usage: {} })).toBeNull();
  });

  it('is a plain function: the same arguments give the same answer, with no host input', () => {
    const row = oauthRow(CLAUDE_PRESET);
    const binding = oauth.identityBindingFor(row);
    expect(planUsageSourcesFor(row, binding)).toEqual(planUsageSourcesFor(row, binding));
    expect(planUsageSourcesFor.length).toBe(2);
  });
});

describe('one table, both gates (task 5.2)', () => {
  // Claude and ChatGPT declare no identity, so the identity gate is exercised through a stub
  // declaration on a copy of their real binding: what is compared is the PIN, which is the point.
  const STUB: PresetClientIdentity = { label: 'Stub', apiHeaders: { 'X-Stub': 'value' } };
  const withIdentity = (binding: IdentityBinding | undefined): IdentityBinding | undefined =>
    binding === undefined ? undefined : { ...binding, identity: binding.identity ?? STUB };

  const kimi = KIMI_CODE_PRESET.regions[0]!;
  const zai = ZAI_CODING_PLAN_PRESET.regions[0]!;
  const go = OPENCODE_GO_PRESET.regions[0]!;
  const table: Array<[string, Row]> = [
    ['coherent Claude', oauthRow(CLAUDE_PRESET)],
    ['coherent ChatGPT', oauthRow(CHATGPT_PRESET)],
    ['coherent OpenCode Go', keyRow(OPENCODE_GO_PRESET, go)],
    ['coherent Kimi', keyRow(KIMI_CODE_PRESET, kimi)],
    ['coherent Z.ai', keyRow(ZAI_CODING_PLAN_PRESET, zai)],
    ['drifted OAuth base_url', oauthRow(CLAUDE_PRESET, { baseUrl: 'https://proxy.example/' })],
    ['drifted OAuth protocol', oauthRow(CHATGPT_PRESET, { protocol: 'openai_compatible' })],
    ['OAuth, kind not subscription', oauthRow(CLAUDE_PRESET, { kind: 'api_key' })],
    [
      'drifted key-preset base_url',
      keyRow(KIMI_CODE_PRESET, kimi, { baseUrl: 'https://x.example/' }),
    ],
    [
      'drifted key-preset protocol',
      keyRow(KIMI_CODE_PRESET, kimi, { protocol: 'openai_responses' }),
    ],
    ['key preset, kind not subscription', keyRow(ZAI_CODING_PLAN_PRESET, zai, { kind: 'api_key' })],
    ['Other subscription', keyRow(KIMI_CODE_PRESET, kimi, { keyPreset: null })],
    [
      'pay-as-you-go on a preset host',
      keyRow(ZAI_CODING_PLAN_PRESET, zai, {
        baseUrl: 'https://api.z.ai/api/paas/v4',
        kind: 'api_key',
      }),
    ],
  ];

  it.each(table)(
    '%s: clientIdentityFor, bindingMatches and planUsageSourcesFor agree',
    (_n, row) => {
      const binding = withIdentity(oauth.identityBindingFor(row));
      const identityCoherent = clientIdentityFor(row, binding) !== null;
      const usageCoherent = planUsageSourcesFor(row, binding) !== null;
      // MiniMax China (no usage declaration) is the only coherent row with no usage; none is in the
      // table, so the two answers must be equal here.
      expect(usageCoherent).toBe(identityCoherent);
      expect(bindingMatches(row, binding)).toBe(identityCoherent);
    },
  );

  it('the table is not vacuous: it holds both coherent and not-coherent rows', () => {
    const answers = table.map(([, row]) => bindingMatches(row, oauth.identityBindingFor(row)));
    expect(answers.filter(Boolean)).toHaveLength(5);
    expect(answers.filter((a) => !a)).toHaveLength(8);
  });

  it('bindingMatches reads only kind, base_url and protocol', () => {
    const binding = oauth.identityBindingFor(oauthRow(CLAUDE_PRESET));
    expect(bindingMatches(oauthRow(CLAUDE_PRESET), binding)).toBe(true);
    expect(bindingMatches(oauthRow(CLAUDE_PRESET), undefined)).toBe(false);
    expect(bindingMatches(oauthRow(CLAUDE_PRESET, { kind: 'custom' }), binding)).toBe(false);
  });

  it('the registry used is the bundled one (no host-injected lookup exists)', () => {
    expect(defaultKeyPresetRegistry.list()).toBe(KEY_PRESETS);
  });
});
