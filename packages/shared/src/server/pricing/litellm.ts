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
  input_cost_per_token_batches?: unknown;
  output_cost_per_token_batches?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  max_output_tokens?: unknown;
  supports_function_calling?: unknown;
  supports_vision?: unknown;
  supports_reasoning?: unknown;
}

const PER_MILLION = 1_000_000;

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Output caps must be positive integers; anything else drops the FIELD (the
 * row keeps its prices) — and because this parser also produces the bundled
 * snapshot, no parser-produced source can carry an invalid cap. */
function positiveInteger(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function per1m(v: unknown): number | undefined {
  const n = finiteNumber(v);
  return n === undefined ? undefined : n * PER_MILLION;
}

/** A capability flag is THREE-valued (honest-model-capabilities): an explicit
 * boolean is carried as it stands — `false` included — and anything else (absent,
 * null, a string, a number) yields `undefined`, which the catalog stores as null.
 *
 * Reading a negative out of silence is the failure this guards: LiteLLM annotates
 * only part of its catalog, so collapsing "absent" into `false` makes every
 * unannotated model indistinguishable from one verified to lack the capability.
 * Same unknown-not-wrong stance `max_output_tokens` above already takes. */
function capabilityFlag(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
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
    // Explicit field ONLY: LiteLLM's legacy `max_tokens` may hold an INPUT or
    // output limit, so it is never read as a cap (unknown-not-wrong).
    const maxOutputTokens = positiveInteger(e.max_output_tokens);
    const isFree = inputP === 0 && outputP === 0;
    // Batch-tier pair (add-batch-inference): BOTH or neither — a half rate is
    // never used, and a negative one drops the pair, never the row.
    const batchIn = per1m(e.input_cost_per_token_batches);
    const batchOut = per1m(e.output_cost_per_token_batches);
    const batchPair =
      batchIn !== undefined && batchOut !== undefined && batchIn >= 0 && batchOut >= 0
        ? { batchInputPricePer1m: batchIn, batchOutputPricePer1m: batchOut }
        : {};
    const tools = capabilityFlag(e.supports_function_calling);
    const vision = capabilityFlag(e.supports_vision);
    const reasoning = capabilityFlag(e.supports_reasoning);

    out.push({
      modelKey: canonicalModelKey(provider, name),
      inputPricePer1m: inputP,
      outputPricePer1m: outputP,
      ...(cacheRead !== undefined ? { cacheReadPricePer1m: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWritePricePer1m: cacheWrite } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(tools !== undefined ? { supportsTools: tools } : {}),
      ...(vision !== undefined ? { supportsVision: vision } : {}),
      ...(reasoning !== undefined ? { supportsReasoning: reasoning } : {}),
      ...(isFree ? { isFree: true } : {}),
      ...batchPair,
    });
  }
  return out;
}
