/**
 * Bundled pricing snapshot (#8, §7.7) — a vendored subset of LiteLLM's
 * `model_prices_and_context_window.json` covering the §8 BYOK providers plus a
 * curated free set, run through the same `parseLiteLlmCatalog` used for the live
 * refresh. Values are a point-in-time snapshot (USD per token, as LiteLLM ships
 * them); an admin `refresh` supersedes them from the live source.
 *
 * A content change MUST bump `BUNDLED_CATALOG_VERSION` so it lands as a new
 * effective-dated version rather than being swallowed by the same-version row.
 */
import { parseLiteLlmCatalog, type BundledPrice } from '@polyrouter/shared/server';

const LITELLM_SNAPSHOT: Record<string, unknown> = {
  'gpt-4o': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.00000125,
    max_input_tokens: 128000,
    supports_function_calling: true,
    supports_vision: true,
  },
  'gpt-4o-mini': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.00000015,
    output_cost_per_token: 0.0000006,
    cache_read_input_token_cost: 0.000000075,
    max_input_tokens: 128000,
    supports_function_calling: true,
    supports_vision: true,
  },
  'o3-mini': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.0000011,
    output_cost_per_token: 0.0000044,
    max_input_tokens: 200000,
    supports_function_calling: true,
    supports_reasoning: true,
  },
  'claude-sonnet-4-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375,
    max_input_tokens: 200000,
    supports_function_calling: true,
    supports_vision: true,
  },
  'claude-3-5-haiku-latest': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0.0000008,
    output_cost_per_token: 0.000004,
    max_input_tokens: 200000,
    supports_function_calling: true,
  },
  'gemini/gemini-1.5-pro': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 0.00000125,
    output_cost_per_token: 0.000005,
    max_input_tokens: 2000000,
    supports_function_calling: true,
    supports_vision: true,
  },
  'gemini/gemini-1.5-flash': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 0.000000075,
    output_cost_per_token: 0.0000003,
    max_input_tokens: 1000000,
    supports_function_calling: true,
    supports_vision: true,
  },
  'deepseek-chat': {
    litellm_provider: 'deepseek',
    mode: 'chat',
    input_cost_per_token: 0.00000027,
    output_cost_per_token: 0.0000011,
    cache_read_input_token_cost: 0.00000007,
    max_input_tokens: 65536,
    supports_function_calling: true,
  },
  'mistral/mistral-large-latest': {
    litellm_provider: 'mistral',
    mode: 'chat',
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000006,
    max_input_tokens: 128000,
    supports_function_calling: true,
  },
  'groq/llama-3.3-70b-versatile': {
    litellm_provider: 'groq',
    mode: 'chat',
    input_cost_per_token: 0.00000059,
    output_cost_per_token: 0.00000079,
    max_input_tokens: 128000,
    supports_function_calling: true,
  },
  // Curated free set (§8) — $0 tiers routable for simple traffic.
  'openrouter/meta-llama/llama-3.3-70b-instruct:free': {
    litellm_provider: 'openrouter',
    mode: 'chat',
    input_cost_per_token: 0,
    output_cost_per_token: 0,
    max_input_tokens: 65536,
    supports_function_calling: true,
  },
  'text-embedding-3-small': {
    // Non-chat: MUST be skipped by the parser (guards the mode filter).
    litellm_provider: 'openai',
    mode: 'embedding',
    input_cost_per_token: 0.00000002,
    output_cost_per_token: 0,
  },
};

/** UTC instant used as `valid_from` for every bundled row. Bump on any change. */
export const BUNDLED_CATALOG_VERSION = new Date('2026-07-15T00:00:00.000Z');

export const BUNDLED_PRICES: BundledPrice[] = parseLiteLlmCatalog(LITELLM_SNAPSHOT);
