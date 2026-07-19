export const APP_NAME = 'polyrouter';
/** The polyrouter project's canonical public URL — used as the `HTTP-Referer` for OpenRouter
 * app attribution (add-openrouter-attribution). Deliberately NOT named `APP_URL`, which is the
 * operator's own instance origin (auth callbacks/cookies). A project constant, not per-instance. */
export const PROJECT_URL = 'https://polyrouter.app';
/** OpenRouter's API host — the gate for disclosing app-attribution headers. Kept as its own
 * constant (not the pricing `PROVIDER_FAMILY_HOSTS` map) so pricing-map growth can never broaden
 * what identity we disclose to whom. */
export const OPENROUTER_HOST = 'openrouter.ai';

export { z } from 'zod';
export {
  ConfigRegistry,
  ConfigValidationError,
  configRegistry,
  registerConfig,
  loadConfig,
} from './config/registry';
export type { ConfigProblem, ConfigShape } from './config/registry';
export { BASE_CONFIG_NAMESPACE, baseConfigSchema } from './config/base';
export type { AppConfig, BaseConfig } from './config/base';
export { HARNESS_TYPES, HARNESS_LABELS, connectionSnippet, isHarnessType } from './harness';
export type { HarnessType } from './harness';
