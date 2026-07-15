export const APP_NAME = 'polyrouter';

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
