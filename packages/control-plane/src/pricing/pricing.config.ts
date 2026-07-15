import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import type { BaseConfig } from '@polyrouter/shared';

/** Pricing-refresh config (#8). The LiteLLM pull URL is admin-configured (not
 * user input); the fetch is SSRF-guarded with a timeout + body-size cap. */

const DEFAULT_LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

registerConfig(
  'pricing',
  z.object({
    PRICING_REFRESH_URL: z.string().url().default(DEFAULT_LITELLM_URL),
    PRICING_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    PRICING_MAX_BYTES: z.coerce.number().int().positive().default(8_000_000),
  }),
);

export type PricingConfig = {
  PRICING_REFRESH_URL: string;
  PRICING_FETCH_TIMEOUT_MS: number;
  PRICING_MAX_BYTES: number;
};

export function loadPricingConfig(): { pricing: PricingConfig; base: BaseConfig } {
  const all = loadConfig<PricingConfig & BaseConfig>();
  return { pricing: all, base: all };
}
