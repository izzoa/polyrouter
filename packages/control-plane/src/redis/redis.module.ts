import { Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadConfig } from '@polyrouter/shared';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import './redis.config';
import type { RedisConfig } from './redis.config';

/** Minimal event surface for the error logger (so it's unit-testable). */
interface ErrorEmitter {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
}
interface ErrorLog {
  error(message: string): void;
}

/**
 * Attach a latched `error` listener (A-43): without one, ioredis emits an
 * "Unhandled error event" per reconnect attempt during an outage (log flooding /
 * a latent EventEmitter crash). Logs ONE line per outage (reset on `ready`) and
 * logs ONLY the error's syscall code / class — never `err.message`, which can carry
 * the endpoint, TLS details, or server-controlled text (invariant 8).
 */
export function installRedisErrorLog(client: ErrorEmitter, logger: ErrorLog): void {
  let warned = false;
  client.on('error', (err: Error) => {
    if (warned) return;
    warned = true;
    const code = (err as { code?: string }).code ?? err.name;
    logger.error(
      `redis connection error (${code}) — retrying; further errors suppressed until reconnect`,
    );
  });
  client.on('ready', () => {
    warned = false;
  });
}

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
        const client = new Redis(config.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 3,
          retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
        });
        installRedisErrorLog(client, new Logger('RedisModule'));
        return client;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
