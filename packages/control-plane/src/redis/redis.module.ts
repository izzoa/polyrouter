import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadConfig } from '@polyrouter/shared';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import './redis.config';
import type { RedisConfig } from './redis.config';

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    if (this.client.status !== 'end') {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
    }
  }
}

/** Shared Redis client (ioredis — BullMQ-compatible for #15). Counters,
 * circuit breakers, and queues are owned by later changes; this module only
 * provides the connection and closes it on shutdown. */
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const config = loadConfig<RedisConfig>();
        return new Redis(config.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 3,
          retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
        });
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
