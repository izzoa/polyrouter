/**
 * Pure pricing resolution (#8, §7.7) — no DB, no clock, no network, so both the
 * control-plane management view and #11's data-plane cost path resolve
 * identically. Cost is NOT computed here; this returns unit prices + provenance
 * for #11 to snapshot (invariant 4).
 */
import type { ModelPriceRow } from '../db/schema';

export type PriceSource = 'model' | 'local' | 'bundled' | 'refresh' | 'manual';

/** A resolved unit-price snapshot. `priceVersionId`/`validFrom` are set for a
 * catalog hit so #11 can record exactly which version priced the request. */
export interface PriceSnapshot {
  readonly priceVersionId: string | null;
  readonly modelKey: string | null;
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
  readonly cacheReadPricePer1m: number | null;
  readonly cacheWritePricePer1m: number | null;
  readonly isFree: boolean;
  readonly source: PriceSource;
  readonly validFrom: Date | null;
}

/** What the resolver needs about a tenant model (the caller supplies the catalog
 * row separately, from `priceAt(deriveModelKey(...), at)`). */
export interface PriceResolutionInput {
  readonly providerKind: string;
  readonly modelInputPricePer1m: number | null;
  readonly modelOutputPricePer1m: number | null;
  readonly modelIsFree: boolean;
}

/** A catalog row ready to seed/append (no id/createdAt). */
export interface BundledPrice {
  readonly modelKey: string;
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
  readonly cacheReadPricePer1m?: number;
  readonly cacheWritePricePer1m?: number;
  readonly contextWindow?: number;
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
  readonly isFree?: boolean;
}

/** Provider base_url host → LiteLLM `litellm_provider` family. Aligned to
 * LiteLLM's namespace so a catalog key and a derived key are byte-identical. */
export const PROVIDER_FAMILY_HOSTS: Readonly<Record<string, string>> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'gemini',
  'api.deepseek.com': 'deepseek',
  'api.mistral.ai': 'mistral',
  'api.groq.com': 'groq',
  'openrouter.ai': 'openrouter',
  'api.x.ai': 'xai',
  'api.cohere.ai': 'cohere',
  'api.cohere.com': 'cohere',
  'api.together.xyz': 'together_ai',
  'api.perplexity.ai': 'perplexity',
  // §8 BYOK families — ONLY the international (USD-billed) endpoints are mapped, so
  // a bundled/refresh USD price is correct. The China-domestic endpoints
  // (dashscope.aliyuncs.com, api.moonshot.cn, api.minimax.chat, open.bigmodel.cn)
  // bill in CNY and are deliberately left unmapped → null (unknown, not a
  // currency-wrong cost — invariant 4's "unknown rather than wrong").
  'dashscope-intl.aliyuncs.com': 'dashscope',
  'api.moonshot.ai': 'moonshot',
  'api.minimax.io': 'minimax', // NOTE: api.minimaxi.com is the CNY endpoint — left unmapped
  'api.z.ai': 'zai',
};

/** THE single key builder — used by both the LiteLLM parser and `deriveModelKey`
 * so keys round-trip. `family` is a `litellm_provider`; one leading
 * `"<family>/"` is stripped (LiteLLM keys `gemini/gemini-1.5-pro`, providers
 * return the bare `gemini-1.5-pro`). */
export function canonicalModelKey(family: string, modelId: string): string {
  const f = family.trim().toLowerCase();
  let id = modelId.trim().toLowerCase();
  const prefix = `${f}/`;
  if (id.startsWith(prefix)) id = id.slice(prefix.length);
  return `${f}:${id}`;
}

/** Map a tenant provider (host) + model id to a catalog key, or null when the
 * host is not a known family — an unknown/reseller host NEVER inherits a
 * well-known provider's price (cost-correctness). */
export function deriveModelKey(providerBaseUrl: string, externalModelId: string): string | null {
  let host: string;
  try {
    host = new URL(providerBaseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const family = PROVIDER_FAMILY_HOSTS[host];
  if (family === undefined) return null;
  return canonicalModelKey(family, externalModelId);
}

/** Resolve unit prices by precedence: Model-own → local-free → catalog → null.
 * A null return means "price unknown" — distinct from `usage_estimated`
 * (missing token usage); the caller records it and never guesses a cost. */
export function resolveModelPrice(
  input: PriceResolutionInput,
  catalogRow: ModelPriceRow | null,
): PriceSnapshot | null {
  // A model-own price is honored ONLY for a custom/local provider — the API forbids
  // setting one on an api_key/subscription provider (its price comes from the
  // catalog), so a stale price left after a kind change, or one restored by a
  // request racing that change, must never override the catalog (§7.7, invariant 4).
  const kindHonorsModelPrice = input.providerKind === 'custom' || input.providerKind === 'local';
  if (
    kindHonorsModelPrice &&
    input.modelInputPricePer1m !== null &&
    input.modelOutputPricePer1m !== null
  ) {
    return {
      priceVersionId: null,
      modelKey: null,
      inputPricePer1m: input.modelInputPricePer1m,
      outputPricePer1m: input.modelOutputPricePer1m,
      cacheReadPricePer1m: null,
      cacheWritePricePer1m: null,
      isFree: input.modelIsFree,
      source: 'model',
      validFrom: null,
    };
  }
  if (input.providerKind === 'local') {
    return {
      priceVersionId: null,
      modelKey: null,
      inputPricePer1m: 0,
      outputPricePer1m: 0,
      cacheReadPricePer1m: null,
      cacheWritePricePer1m: null,
      isFree: true,
      source: 'local',
      validFrom: null,
    };
  }
  if (catalogRow !== null) {
    return {
      priceVersionId: catalogRow.id,
      modelKey: catalogRow.modelKey,
      inputPricePer1m: catalogRow.inputPricePer1m,
      outputPricePer1m: catalogRow.outputPricePer1m,
      cacheReadPricePer1m: catalogRow.cacheReadPricePer1m,
      cacheWritePricePer1m: catalogRow.cacheWritePricePer1m,
      isFree: catalogRow.isFree,
      source: catalogRow.source as PriceSource,
      validFrom: catalogRow.validFrom,
    };
  }
  return null;
}
