import { Logger, Module } from '@nestjs/common';
import {
  FailoverPlanUsageStore,
  InMemoryPlanUsageStore,
  PlanUsageRecorder,
  RedisPlanUsageStore,
  readPlanUsage,
  type PlanUsageStore,
} from '@polyrouter/data-plane';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { ObservabilityModule } from '../observability/observability.module';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { breakerStoreErrorHandler } from '../proxy/breaker-observability';
import { boundedBreakerRedis } from '../redis/bounded-breaker-redis';
import { RedisModule } from '../redis/redis.module';
import { PLAN_USAGE_READER, PLAN_USAGE_RECORDER, PLAN_USAGE_STORE } from './plan-usage.tokens';

export { PLAN_USAGE_READER, PLAN_USAGE_RECORDER, PLAN_USAGE_STORE };

/**
 * The shared plan-usage store and its recorder (add-subscription-quota-display, design D5/D6).
 * One `FailoverPlanUsageStore` over the bounded Redis store, with a per-instance in-memory
 * fallback and the breaker-store fault meter, and ONE `PlanUsageRecorder` in front of it. Nest
 * builds a module's provider once per application, so the proxy's breaker (which hosts the
 * recorder) and any consumer that injects the store share the SAME instances, fallback included.
 * `PLAN_USAGE_READER` is the usage-endpoint read, a plain function bound with `useValue`.
 */
@Module({
  imports: [RedisModule, ObservabilityModule],
  providers: [
    {
      provide: PLAN_USAGE_STORE,
      inject: [REDIS_CLIENT, ProxyMetrics],
      useFactory: (redis: Redis, metrics: ProxyMetrics): PlanUsageStore => {
        const logger = new Logger('PlanUsageStore');
        return new FailoverPlanUsageStore(
          new RedisPlanUsageStore(boundedBreakerRedis(redis)),
          new InMemoryPlanUsageStore(),
          breakerStoreErrorHandler(metrics, logger),
          // A fixed, secret-free line: the final failed clear (the store never passes a value).
          { log: (message: string): void => logger.warn(message) },
        );
      },
    },
    {
      provide: PLAN_USAGE_RECORDER,
      inject: [PLAN_USAGE_STORE],
      useFactory: (store: PlanUsageStore): PlanUsageRecorder => new PlanUsageRecorder(store),
    },
    { provide: PLAN_USAGE_READER, useValue: readPlanUsage },
  ],
  exports: [PLAN_USAGE_STORE, PLAN_USAGE_RECORDER, PLAN_USAGE_READER],
})
export class PlanUsageModule {}
