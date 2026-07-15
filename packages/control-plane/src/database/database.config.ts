import { registerConfig, z } from '@polyrouter/shared';

function isProtocolUrl(protocols: string[]): (value: string) => boolean {
  return (value) => {
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  };
}

registerConfig(
  'database',
  z.object({
    DATABASE_URL: z
      .string()
      .refine(isProtocolUrl(['postgres:', 'postgresql:']), {
        message: 'expected a postgresql:// connection URL',
      })
      // Loopback default matching docker-compose.dev.yml (design decision 8);
      // non-secret dev credentials only meaningful for the local container.
      .default('postgresql://polyrouter:polyrouter@localhost:5432/polyrouter'),
  }),
);

export type DatabaseConfig = {
  DATABASE_URL: string;
};
