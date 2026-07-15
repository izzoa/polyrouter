/**
 * Parse LiteLLM's `model_prices_and_context_window.json` into catalog rows
 * (#8, §7.7). Pure — no network. LiteLLM keys models by name and carries the
 * authoritative `litellm_provider` namespace; costs are per-token, so we scale
 * to per-1M USD. Non-chat modes, the `sample_spec` placeholder, and malformed
 * entries are skipped.
 */
import { canonicalModelKey, type BundledPrice } from './resolve';

interface LiteLlmEntry {
  litellm_provider?: unknown;
  mode?: unknown;
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  supports_function_calling?: unknown;
  supports_vision?: unknown;
  supports_reasoning?: unknown;
}

const PER_MILLION = 1_000_000;

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function per1m(v: unknown): number | undefined {
  const n = finiteNumber(v);
  return n === undefined ? undefined : n * PER_MILLION;
}

export function parseLiteLlmCatalog(json: unknown): BundledPrice[] {
  if (typeof json !== 'object' || json === null) return [];
  const out: BundledPrice[] = [];
  for (const [name, raw] of Object.entries(json as Record<string, unknown>)) {
    if (name === 'sample_spec') continue;
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as LiteLlmEntry;

    const provider = typeof e.litellm_provider === 'string' ? e.litellm_provider : '';
    if (provider === '') continue;
    const mode = typeof e.mode === 'string' ? e.mode : undefined;
    if (mode !== undefined && mode !== 'chat' && mode !== 'completion') continue;

    const inputP = per1m(e.input_cost_per_token);
    const outputP = per1m(e.output_cost_per_token);
    if (inputP === undefined || outputP === undefined) continue;

    const cacheRead = per1m(e.cache_read_input_token_cost);
    const cacheWrite = per1m(e.cache_creation_input_token_cost);
    const contextWindow = finiteNumber(e.max_input_tokens) ?? finiteNumber(e.max_tokens);
    const isFree = inputP === 0 && outputP === 0;

    out.push({
      modelKey: canonicalModelKey(provider, name),
      inputPricePer1m: inputP,
      outputPricePer1m: outputP,
      ...(cacheRead !== undefined ? { cacheReadPricePer1m: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWritePricePer1m: cacheWrite } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(e.supports_function_calling === true ? { supportsTools: true } : {}),
      ...(e.supports_vision === true ? { supportsVision: true } : {}),
      ...(e.supports_reasoning === true ? { supportsReasoning: true } : {}),
      ...(isFree ? { isFree: true } : {}),
    });
  }
  return out;
}
