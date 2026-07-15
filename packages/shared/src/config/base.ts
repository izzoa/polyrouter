import { z } from 'zod';
import { registerConfig } from './registry';

export const BASE_CONFIG_NAMESPACE = 'core';

export const baseConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  // Loopback by default for self-host safety (spec §12); packaging overrides in-container.
  BIND_ADDRESS: z.string().min(1).default('127.0.0.1'),
  // `test` extends spec §12's development|production for test harnesses (design decision 5).
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Gates self-host-only behavior (local providers, auto-login, SSRF loopback exception).
  MODE: z.enum(['selfhosted', 'cloud']).default('selfhosted'),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;
export type AppConfig = BaseConfig & Record<string, unknown>;

registerConfig(BASE_CONFIG_NAMESPACE, baseConfigSchema);
