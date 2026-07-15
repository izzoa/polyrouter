import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  RedisBreakerStore,
  createProviderAdapter,
  type BreakerRedis,
} from '@polyrouter/data-plane';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { AuthModule } from '../auth/auth.module';
import { loadAuthConfig, resolveAuthSecrets } from '../auth/auth.config';
import { DatabaseModule } from '../database/database.module';
import { RecordingModule } from '../recording/recording.module';
import { RedisModule } from '../redis/redis.module';
import { ChatCompletionsController } from './chat-completions.controller';
import { MessagesController } from './messages.controller';
import { ModelsController } from './models.controller';
import { ProxyExceptionFilter } from './proxy-exception.filter';
import {
  BREAKER_REDIS_TIMEOUT_MS,
  PROXY_ADAPTER_FACTORY,
  PROXY_BREAKER,
  PROXY_RUNTIME,
  loadProxyRuntime,
} from './proxy.config';
import { ROUTING_CONFIG, loadRoutingConfig } from './routing.config';
import { ProxyService } from './proxy.service';
import { StreamDrainRegistry } from './stream-drain.registry';
import { StructuralBaselineStore } from './structural/structural-baseline.store';
import { StructuralRouter } from './structural/structural-router';

/** ioredis `eval` bounded by a fail-fast deadline so a slow/down Redis degrades
 * to the in-memory breaker without stalling the request (#12). */
function boundedBreakerRedis(redis: Redis): BreakerRedis {
  return {
    eval: (script, numKeys, ...args) =>
      Promise.race([
        redis.eval(script, numKeys, ...args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('breaker redis timeout')), BREAKER_REDIS_TIMEOUT_MS),
        ),
      ]),
  };
}

/**
 * The inference proxy (#10, Layer 0). `AuthModule` supplies the agent-key guard
 * the controllers use; `DatabaseModule` the persistence port. The exception
 * filter is registered globally (it protocol-shapes only `/v1`).
 */
@Module({
  imports: [DatabaseModule, AuthModule, RecordingModule, RedisModule],
  controllers: [ChatCompletionsController, MessagesController, ModelsController],
  providers: [
    ProxyService,
    StreamDrainRegistry,
    StructuralRouter,
    { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
    { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
    { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
    {
      // Structural baseline (#13): a dedicated fail-fast Redis connection, keyed
      // by an HMAC derived from the resolved agent-key secret.
      provide: StructuralBaselineStore,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis): StructuralBaselineStore => {
        const { auth, base } = loadAuthConfig();
        const { apiKeyHmacSecret } = resolveAuthSecrets(auth, base);
        return new StructuralBaselineStore(redis, apiKeyHmacSecret);
      },
    },
    {
      provide: PROXY_BREAKER,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis): CircuitBreaker =>
        new CircuitBreaker(new RedisBreakerStore(boundedBreakerRedis(redis)), {
          fallback: new InMemoryBreakerStore(),
        }),
    },
    { provide: APP_FILTER, useClass: ProxyExceptionFilter },
  ],
})
export class ProxyModule {}
