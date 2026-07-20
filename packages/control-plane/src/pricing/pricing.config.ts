import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import type { BaseConfig } from '@polyrouter/shared';
import { parseExpression } from 'cron-parser';

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
    // Scheduled refresh (add-pricing-refresh-ui): ON by default with a
    // one-line opt-out — the recorded user decision 2026-07-20 (silent price
    // staleness is the costlier failure; the pull is a public static catalog
    // with no tenant data outbound; disclosed in README/release notes/UI).
    PRICING_REFRESH_SCHED_ENABLED: z.string().default('true'),
    PRICING_REFRESH_SCHED_CRON: z.string().default('30 4 * * *'),
  }),
);

export type PricingConfig = {
  PRICING_REFRESH_URL: string;
  PRICING_FETCH_TIMEOUT_MS: number;
  PRICING_MAX_BYTES: number;
  PRICING_REFRESH_SCHED_ENABLED: string;
  PRICING_REFRESH_SCHED_CRON: string;
};

export interface PricingSchedulerConfig {
  /** The env flag alone — the panel reports it distinctly from the mode. */
  readonly configuredEnabled: boolean;
  readonly cron: string;
}

/** Pure cross-field validation (unit-testable without the registry): the cron
 * is PARSED at boot and invalid syntax fails fast (the budgets precedent) —
 * fail-open stays reserved for Redis/runtime faults, never operator typos
 * silently reported as "enabled". */
export function buildPricingSchedulerConfig(cfg: PricingConfig): PricingSchedulerConfig {
  try {
    parseExpression(cfg.PRICING_REFRESH_SCHED_CRON, { utc: true });
  } catch (err) {
    throw new Error(
      `PRICING_REFRESH_SCHED_CRON is not a valid cron expression: ${(err as Error).message}`,
    );
  }
  return {
    configuredEnabled: cfg.PRICING_REFRESH_SCHED_ENABLED !== 'false',
    cron: cfg.PRICING_REFRESH_SCHED_CRON,
  };
}

export function loadPricingConfig(): { pricing: PricingConfig; base: BaseConfig } {
  const all = loadConfig<PricingConfig & BaseConfig>();
  return { pricing: all, base: all };
}
