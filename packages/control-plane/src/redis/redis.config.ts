import { registerConfig, z } from '@polyrouter/shared';

function isRedisUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'redis:' || protocol === 'rediss:';
  } catch {
    return false;
  }
}

registerConfig(
  'redis',
  z.object({
    REDIS_URL: z
      .string()
      .refine(isRedisUrl, { message: 'expected a redis:// or rediss:// URL' })
      // spec §12 default, matching docker-compose.dev.yml
      .default('redis://localhost:6379'),
  }),
);

export type RedisConfig = {
  REDIS_URL: string;
};
