/**
 * Bundled API-key subscription presets (add-key-subscription-presets). Every URL, id and
 * string here is a FIXED constant — never user input (no new SSRF surface; every outbound
 * call still flows through the guarded fetch). A preset carries NO model id
 * (add-live-subscription-models): Test is the provider's own authenticated listing, so an
 * upstream model retirement can never make a preset stale.
 *
 * Modelled on `subscription-oauth/presets.ts`, but a separate registry on purpose (design
 * D1): a key preset must be invisible to every OAuth `presets.find(...)` site. Ids are
 * unique ACROSS both registries (unit-tested) so one namespace names a preset.
 *
 * WITHDRAWAL SWITCH (redesign-subscription-picker, design D1/D2). Every region ships
 * `enabled: true` (and `imitationRequired: false`): the four presets are listed and
 * connectable on every install. The live runbooks (`scripts/verify-<preset>-key.md`) are
 * optional QA that settle the values still marked [U]. A region a run or a user report shows
 * broken is WITHDRAWN by shipping it `enabled: false`: absent from the list, refused on
 * connect, while rows already connected from it keep working (`keyPresetForRow` ignores the
 * flag). An unverified key prefix is still not hinted.
 *
 * PIN-CHANGE MIGRATION RULE (design D6). A row's region is the region whose
 * `(baseUrl, protocol)` equals the row's, so a pinned value is part of every existing
 * row's identity. NEVER move a region's `baseUrl` or `protocol` without a data migration
 * of the existing rows, or keeping the old pin as an additional accepted region: a moved
 * pin silently demotes every existing row to an ordinary pasted-credential subscription
 * (no listing override, no identity). Region ids are stable for the same reason.
 *
 * [V]/[U] markers refer to `Plans/Subscription-providers-research.md` (verified at a
 * primary source / unverified).
 */

import type { ProviderRow } from '@polyrouter/shared/server';
import type { PlanErrorDialect, PlanUsageDialect, PlanUsageProbe } from '@polyrouter/data-plane';
import type { PresetClientIdentity } from '../providers/client-identity';

/** The injection token the connect and list paths read the registry through (design D6),
 * mirroring `OAUTH_PRESET_LOOKUP`. Bound with `useValue` to the bundled constants; e2e
 * suites enable presets with `.overrideProvider(KEY_PRESET_LOOKUP)`. No env var, config
 * value or request field can override it. */
export const KEY_PRESET_LOOKUP = 'polyrouter:key-preset-lookup';

export type KeyPresetRisk = 'low' | 'medium' | 'high';

export interface KeyPresetRegion {
  /** Stable id within the preset (`intl` / `cn` where a preset has two hosts). */
  readonly id: string;
  /** Display label, appended to the default row name when a preset offers >1 region. */
  readonly label: string;
  /** Pinned provider `base_url`, in canonical `new URL(x).href` form (unit-tested), so a
   * name-only PATCH never looks like endpoint drift. */
  readonly baseUrl: string;
  /** Every key preset speaks OpenAI chat completions with Bearer auth (design D4). */
  readonly protocol: 'openai_compatible';
  /** Absolute model-listing URL on the SAME origin as `baseUrl`, only where the listing is
   * not under the protocol base path (OpenCode Go). Trusted data, never user input. */
  readonly modelsUrl?: string;
  /** The OpenAI token-cap field this region honours, stored at connect; absent = `auto`.
   * Decided per region by the runbook's capped completion (design Risks). */
  readonly maxTokensSpelling?: 'max_tokens' | 'max_completion_tokens';
  /** Withdrawal switch: true by default; false withdraws a region found broken (listing and
   * new connects only — existing rows keep working). */
  readonly enabled: boolean;
  /** True when the region passed only with the identity-imitation switch on (design D12).
   * Such a region is enabled, its preset is `high`, and its copy says so. */
  readonly imitationRequired: boolean;
  /**
   * The plan-error dialect the adapter classifies this region's errors with
   * (classify-plan-quota-errors; design D2). Trusted routing data, never user input and
   * never part of the available-presets DTO. Declared per REGION and only once that
   * region's own error reference was recorded as matching the dialect's table
   * (apply-log task 1.3): the international MiniMax, Kimi and Z.ai regions, and Kimi's
   * China host (same English strings and statuses as the international reference).
   * Z.ai China (Chinese messages, unverified reset format) and MiniMax China (separate
   * docs, no live evidence) declare none and keep the generic status map. OpenCode Go has
   * none: no error shape is documented.
   */
  readonly errorDialect?: PlanErrorDialect;
  /**
   * The plan-usage wire format this region's chat replies carry
   * (add-subscription-quota-display, design D1): only OpenCode Go, whose final usage event
   * carries `usage.opencode.billing_source`. Trusted routing data, never user input and never
   * part of the available-presets DTO; it reaches an adapter only through `planUsageSourcesFor`.
   */
  readonly usageDialect?: PlanUsageDialect;
  /**
   * The region's plan-usage endpoint (design D7): a fixed, same-origin `https` constant read by
   * Refresh usage and by the 15-minute usage schedule (add-subscription-usage-history). EVERY
   * probe ships `enabled: true` (design D3, the same decision as redesign-subscription-picker
   * option 1): `false` WITHDRAWS an endpoint a run or a user report shows broken, so its rows
   * offer no Refresh usage and the schedule skips them. The live runbook
   * (`scripts/verify-plan-usage.md`) is optional QA. A region with no verified host (MiniMax
   * China) declares none.
   */
  readonly usageProbe?: PlanUsageProbe;
}

/** An advisory key hint (design D9): a caution, never a server-side rejection. */
export interface KeyHint {
  /** The prefix the plan's keys carry, or null where none is documented. */
  readonly prefix: string | null;
  /** The caution text shown beside the key field. */
  readonly note: string;
}

export interface KeyPreset {
  readonly id: string;
  readonly displayName: string;
  readonly regions: readonly KeyPresetRegion[];
  /** Null while no prefix or note is verified: nothing is hinted. */
  readonly keyHint: KeyHint | null;
  /** Default terms-risk level. A runbook outcome may only RAISE it, never lower it. A
   * preset with an imitation-required region MUST be `high` (unit-tested). */
  readonly risk: KeyPresetRisk;
  /** A paraphrase of the provider's own terms, shown before connecting. */
  readonly riskCopy: string;
  /** The provider's terms page. Rendered in the SPA only; the server never fetches it. */
  readonly termsUrl: string;
  /** Fixed model-API client identity, sent only while the provider's switch is on
   * (allow-preset-client-identity). Model-API only (`apiHeaders`): a key preset has no
   * token endpoint, so it never declares `tokenHeaders`. Kimi Code and Z.ai declare one;
   * OpenCode Go and MiniMax declare none. */
  readonly clientIdentity?: PresetClientIdentity;
}

/**
 * Kimi Code's optional imitation identity (allow-preset-client-identity; design D10).
 * Sent ONLY while the provider's switch is on, on chat and listing alike; polyrouter's
 * own honest `polyrouter/<version>` User-Agent is the default.
 *
 * VERIFY AT IMPLEMENTATION: the string and its version are fixed constants taken from the
 * research ([V] that Kimi's coding endpoint admits allow-listed User-Agent prefixes
 * including `claude-code/`; [U] that this exact value passes). The group 11 runbook
 * records the outcome. NEVER `KimiCLI/`: clients that sent that were banned in May 2026
 * (pi#5009; whether the UA caused it is [U] but the ban stays as a precaution).
 * `X-Msh-Platform` is deliberately absent: it is added only if the runbook shows
 * Moonshot's allow-list needs it.
 */
export const KIMI_CODE_CLIENT_IDENTITY: PresetClientIdentity = {
  label: 'Claude Code',
  apiHeaders: { 'User-Agent': 'claude-code/2.1.319' },
};

/**
 * Z.ai's optional imitation identity (same rules as Kimi's above). Claude Code is on
 * Z.ai's supported-tool list [V]. VERIFY AT IMPLEMENTATION: the value is Claude Code's
 * own User-Agent shape (`claude-cli/<version> (external, cli)`, the version taken from
 * the quota research) and whether the plan endpoint needs it at all is [U]; the group 11
 * runbook decides.
 */
export const ZAI_CODING_PLAN_CLIENT_IDENTITY: PresetClientIdentity = {
  label: 'Claude Code',
  apiHeaders: { 'User-Agent': 'claude-cli/2.1.319 (external, cli)' },
};

/**
 * OpenCode Go: one endpoint, no region choice. Ordinary account key, so no prefix hint
 * [V]. Its listing is not under the OpenAI base path, hence the absolute override; the
 * response shape is [U] until the runbook parses a real listing.
 */
export const OPENCODE_GO_PRESET: KeyPreset = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  regions: [
    {
      id: 'default',
      label: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      protocol: 'openai_compatible',
      modelsUrl: 'https://opencode.ai/inference/go/v1/models',
      enabled: true,
      imitationRequired: false,
      usageDialect: 'opencode_go',
      usageProbe: {
        url: 'https://opencode.ai/zen/go/v1/usage',
        auth: 'bearer',
        parser: 'opencode_go_usage',
        enabled: true,
      },
    },
  ],
  keyHint: null,
  risk: 'low',
  riskCopy:
    'OpenCode Go is open to other coding agents that send typical coding traffic. Check the ' +
    'plan terms for usage limits before relying on it.',
  termsUrl: 'https://opencode.ai/v2/docs/console/go/',
};

/**
 * MiniMax M Plan. The international host is [V]; the China host is [U] and ships enabled
 * (redesign-subscription-picker) — a failed run withdraws it. The `sk-cp-` prefix is [U]
 * and is HELD BACK (`keyHint: null`): it is added only after a live run confirms it. The rating
 * rests on the plan docs alone; MiniMax's general Terms of Service could not be parsed
 * [U], so the risk copy says those general terms may add limits (design D8).
 */
export const MINIMAX_M_PLAN_PRESET: KeyPreset = {
  id: 'minimax-m-plan',
  displayName: 'MiniMax M Plan',
  regions: [
    {
      id: 'intl',
      label: 'International',
      baseUrl: 'https://api.minimax.io/v1',
      protocol: 'openai_compatible',
      enabled: true,
      imitationRequired: false,
      errorDialect: 'minimax',
      usageProbe: {
        url: 'https://api.minimax.io/v1/token_plan/remains',
        auth: 'bearer',
        parser: 'minimax_remains',
        enabled: true,
      },
    },
    {
      id: 'cn',
      label: 'China',
      baseUrl: 'https://api.minimaxi.com/v1',
      protocol: 'openai_compatible',
      enabled: true,
      imitationRequired: false,
    },
  ],
  keyHint: null,
  risk: 'low',
  riskCopy:
    'MiniMax M Plan is for individual, interactive use with any tool that speaks its ' +
    'protocols. Use a Coding Plan key: a pay-as-you-go key bills your balance instead of the ' +
    'plan. MiniMax’s general terms may add limits beyond the plan docs.',
  termsUrl: 'https://platform.minimax.io/docs/m-plan/faq',
};

/**
 * Kimi Code. Both documented coding hosts are [V]; the `/models` listing path is [U].
 * `medium`: interactive use only, no reverse-proxy sharing or non-interactive automation,
 * and tampering with the User-Agent is forbidden. Two readings of "proxy" exist, so the
 * copy states the restriction and does not pick the favourable one as fact (design D8).
 */
export const KIMI_CODE_PRESET: KeyPreset = {
  id: 'kimi-code',
  displayName: 'Kimi Code',
  regions: [
    {
      id: 'intl',
      label: 'International',
      baseUrl: 'https://api.kimi.ai/coding/v1',
      protocol: 'openai_compatible',
      enabled: true,
      imitationRequired: false,
      errorDialect: 'kimi',
      usageProbe: {
        url: 'https://api.kimi.ai/coding/v1/usages',
        auth: 'bearer',
        parser: 'kimi_usages',
        enabled: true,
      },
    },
    {
      id: 'cn',
      label: 'China',
      baseUrl: 'https://api.kimi.com/coding/v1',
      protocol: 'openai_compatible',
      enabled: true,
      imitationRequired: false,
      errorDialect: 'kimi',
      usageProbe: {
        url: 'https://api.kimi.com/coding/v1/usages',
        auth: 'bearer',
        parser: 'kimi_usages',
        enabled: true,
      },
    },
  ],
  keyHint: {
    prefix: 'sk-kimi-',
    note: 'Kimi Code keys start with sk-kimi-. A key that does not may be a different Moonshot key.',
  },
  risk: 'medium',
  riskCopy:
    'Kimi Code is meant for interactive use. Its guidelines forbid reverse-proxy sharing, ' +
    'non-interactive automation and altering the client identity it sees, and they name ' +
    'high-risk agents as harmful. A personal router may count as automation, so unattended ' +
    'traffic (model refresh, fallbacks, auto routing) can put the account at risk.',
  termsUrl: 'https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html',
  clientIdentity: KIMI_CODE_CLIENT_IDENTITY,
};

/**
 * Z.ai GLM Coding Plan: the coding endpoint, never pay-as-you-go `/api/paas/v4`. Both
 * hosts are [V]; the `/models` path is [U]. `high`: the subscription terms forbid
 * aggregate, proxy and own-application API use without a separate written agreement
 * [V], so a connect needs the server-enforced acknowledgement. No documented key prefix,
 * so the hint is a key-type note worded per design D9: for keys created on or after
 * 2026-10-16 the key type, not the endpoint, decides billing; older Compatible keys bill
 * plan quota only if the account has ever had a Coding Plan. It claims no more than that.
 */
export const ZAI_CODING_PLAN_PRESET: KeyPreset = {
  id: 'zai-coding-plan',
  displayName: 'Z.ai GLM Coding Plan',
  regions: [
    {
      id: 'intl',
      label: 'International',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      protocol: 'openai_compatible',
      enabled: true,
      imitationRequired: false,
      errorDialect: 'zai',
      usageProbe: {
        url: 'https://api.z.ai/api/monitor/usage/quota/limit',
        auth: 'bearer',
        parser: 'zai_quota_limit',
        enabled: true,
      },
    },
    {
      id: 'cn',
      label: 'China',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      protocol: 'openai_compatible',
      enabled: true,
      imitationRequired: false,
      usageProbe: {
        url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
        auth: 'bearer',
        parser: 'zai_quota_limit',
        enabled: true,
      },
    },
  ],
  keyHint: {
    prefix: null,
    note:
      'Use a Personal Coding Plan (or Team Plan) key. For keys created since 2026-10-16 the ' +
      'key type, not the endpoint, decides billing, so a pay-as-you-go key bills your balance. ' +
      'An older Compatible key bills plan quota only if the account has ever had a Coding Plan.',
  },
  risk: 'high',
  riskCopy:
    'Z.ai’s subscription terms forbid aggregate and proxy use, and calling the model API ' +
    'from your own applications, unless you hold a separate written agreement. Routing ' +
    'through polyrouter is exactly that kind of use and may get the account restricted. ' +
    'Connect only if you have Z.ai’s permission.',
  termsUrl: 'https://docs.z.ai/legal-agreement/subscription-terms',
  clientIdentity: ZAI_CODING_PLAN_CLIENT_IDENTITY,
};

export const KEY_PRESETS: readonly KeyPreset[] = [
  OPENCODE_GO_PRESET,
  MINIMAX_M_PLAN_PRESET,
  KIMI_CODE_PRESET,
  ZAI_CODING_PLAN_PRESET,
];

/** What the connect and list paths read through `KEY_PRESET_LOOKUP`. */
export interface KeyPresetRegistry {
  find(id: string): KeyPreset | undefined;
  list(): readonly KeyPreset[];
}

export function findKeyPreset(id: string): KeyPreset | undefined {
  return KEY_PRESETS.find((p) => p.id === id);
}

export const defaultKeyPresetRegistry: KeyPresetRegistry = {
  find: findKeyPreset,
  list: () => KEY_PRESETS,
};

/**
 * The regions a principal may see and connect (design D3): enabled ones, in every
 * deployment mode, an imitation-required region included. Every rule that counts a
 * preset's regions (the region choice, the default name) counts these, never the
 * registry's.
 */
export function offeredRegions(preset: KeyPreset): readonly KeyPresetRegion[] {
  return preset.regions.filter((r) => r.enabled);
}

/**
 * The presets to list: each with only its offered regions, and only those that keep at
 * least one. Never varies by principal.
 */
export function listOfferedKeyPresets(registry: KeyPresetRegistry): readonly KeyPreset[] {
  const offered: KeyPreset[] = [];
  for (const preset of registry.list()) {
    const regions = offeredRegions(preset);
    if (regions.length > 0) offered.push({ ...preset, regions });
  }
  return offered;
}

/** The row columns the coherence gate reads. */
export type KeyPresetRow = Pick<ProviderRow, 'kind' | 'baseUrl' | 'protocol' | 'keyPreset'>;

/**
 * The coherence gate (design D6). A plain function over the BUNDLED constants — not an
 * injectable, so no constructor of `ProviderAdapterBuilder` or `ProxyService` changes.
 * Ignores `enabled` and `imitationRequired`: a row of a since-disabled region keeps
 * serving. Returns a match only when the marker resolves to a preset, the row is a
 * `subscription`, and `(base_url, protocol)` equals one of that preset's region pins.
 * Otherwise null: the row behaves as an ordinary pasted-credential subscription, and no
 * preset-declared value (listing URL, identity) can reach a host the preset does not pin.
 */
export function keyPresetForRow(
  row: KeyPresetRow,
): { readonly preset: KeyPreset; readonly region: KeyPresetRegion } | null {
  if (row.keyPreset === null || row.keyPreset === undefined) return null;
  if (row.kind !== 'subscription') return null;
  const preset = findKeyPreset(row.keyPreset);
  if (preset === undefined) return null;
  const region = preset.regions.find(
    (r) => r.baseUrl === row.baseUrl && r.protocol === row.protocol,
  );
  return region === undefined ? null : { preset, region };
}
