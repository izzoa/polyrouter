import { Logger, Module } from '@nestjs/common';
import {
  FailoverPlanCooldownStore,
  InMemoryPlanCooldownStore,
  RedisPlanCooldownStore,
  type PlanCooldownStore,
} from '@polyrouter/data-plane';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { breakerStoreErrorHandler } from '../proxy/breaker-observability';
import { ObservabilityModule } from '../observability/observability.module';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { boundedBreakerRedis } from '../redis/bounded-breaker-redis';
import { RedisModule } from '../redis/redis.module';
import { PLAN_COOLDOWN_STORE } from './plan-cooldown.tokens';

export { PLAN_COOLDOWN_STORE };

/**
 * The shared plan-cooldown store (classify-plan-quota-errors, design D6a/D7). One
 * `FailoverPlanCooldownStore` over the bounded Redis store, with a per-instance in-memory
 * fallback and the breaker-store fault meter. Nest builds a module's provider once per
 * application, so the proxy's breaker and the provider management service inject the SAME
 * instance, fallback record included.
 */
@Module({
  imports: [RedisModule, ObservabilityModule],
  providers: [
    {
      provide: PLAN_COOLDOWN_STORE,
      inject: [REDIS_CLIENT, ProxyMetrics],
      useFactory: (redis: Redis, metrics: ProxyMetrics): PlanCooldownStore =>
        new FailoverPlanCooldownStore(
          new RedisPlanCooldownStore(boundedBreakerRedis(redis)),
          new InMemoryPlanCooldownStore(),
          breakerStoreErrorHandler(metrics, new Logger('PlanCooldownStore')),
        ),
    },
  ],
  exports: [PLAN_COOLDOWN_STORE],
})
export class PlanCooldownModule {}
