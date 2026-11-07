import { Logger, Module, type Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  RedisBreakerStore,
  createProviderAdapter,
  type PlanCooldownStore,
} from '@polyrouter/data-plane';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { AuthModule } from '../auth/auth.module';
import { loadAuthConfig, resolveAuthSecrets } from '../auth/auth.config';
import { BudgetsModule } from '../budgets/budgets.module';
import { DatabaseModule } from '../database/database.module';
import { SubscriptionOauthModule } from '../subscription-oauth/subscription-oauth.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ProducersModule } from '../producers/producers.module';
import { BodyCaptureModule } from '../body-capture/body-capture.module';
import { RecordingModule } from '../recording/recording.module';
import { SemanticModule } from '../semantic/semantic.module';
import { RedisModule } from '../redis/redis.module';
import { boundedBreakerRedis } from '../redis/bounded-breaker-redis';
import { PLAN_COOLDOWN_STORE, PlanCooldownModule } from '../plan-cooldown/plan-cooldown.module';
import { InflightModule } from '../inflight/inflight.module';
import { ChatCompletionsController } from './chat-completions.controller';
import { MessagesController } from './messages.controller';
import { ModelsController } from './models.controller';
import { ProxyExceptionFilter } from './proxy-exception.filter';
import {
  PROXY_ADAPTER_FACTORY,
  PROXY_BREAKER,
  PROXY_RUNTIME,
  loadProxyRuntime,
} from './proxy.config';
import { ROUTING_CONFIG, loadRoutingConfig } from './routing.config';
import {
  CALIBRATION_RAILS,
  loadCalibrationConfig,
  railsOf,
  type CalibrationRails,
} from '../calibration/calibration.config';
import { ProxyService } from './proxy.service';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { breakerStoreErrorHandler } from './breaker-observability';
import { StreamDrainRegistry } from './stream-drain.registry';
import { StructuralBaselineStore } from './structural/structural-baseline.store';
import { StructuralRouter } from './structural/structural-router';
import { WorkloadRouter } from './workload/workload-router';
import { CascadeRouter } from './cascade/cascade-router';

/**
 * The ONE circuit breaker, backed by Redis behind the 150 ms fail-fast race, with an in-memory
 * fallback and the shared plan-cooldown store (classify-plan-quota-errors). Exported so a test
 * can build the REAL factory against the real modules instead of a copy of it.
 */
export const PROXY_BREAKER_PROVIDER: Provider = {
  provide: PROXY_BREAKER,
  inject: [REDIS_CLIENT, ProxyMetrics, PLAN_COOLDOWN_STORE],
  useFactory: (
    redis: Redis,
    metrics: ProxyMetrics,
    planCooldowns: PlanCooldownStore,
  ): CircuitBreaker =>
    new CircuitBreaker(new RedisBreakerStore(boundedBreakerRedis(redis)), {
      fallback: new InMemoryBreakerStore(),
      // The shared plan-cooldown store (classify-plan-quota-errors): the SAME instance
      // the provider view and the lift read; it owns its own degradation (design D6a).
      planCooldowns,
      // Surface a Redis breaker-store fault instead of silently degrading to the
      // per-instance fallback (A-10): meter every fault + throttled WARN.
      onError: breakerStoreErrorHandler(metrics, new Logger('ProxyBreaker')),
    }),
};

/**
 * The inference proxy (#10, Layer 0). `AuthModule` supplies the agent-key guard
 * the controllers use; `DatabaseModule` the persistence port. The exception
 * filter is registered globally (it protocol-shapes only `/v1`).
 */
@Module({
  imports: [
    DatabaseModule,
    SubscriptionOauthModule,
    AuthModule,
    RecordingModule,
    BodyCaptureModule,
    RedisModule,
    PlanCooldownModule,
    InflightModule,
    ProducersModule,
    BudgetsModule,
    ObservabilityModule,
    // Layer 2 (add-semantic-routing): supplies SemanticRouter +
    // SemanticClassifierService to ProxyService.
    SemanticModule,
  ],
  controllers: [ChatCompletionsController, MessagesController, ModelsController],
  providers: [
    ProxyService,
    StreamDrainRegistry,
    StructuralRouter,
    WorkloadRouter,
    CascadeRouter,
    { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
    { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
    { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
    // The hot path re-validates stored calibrated pairs against the ACTIVE
    // rails on every read (add-auto-threshold-calibration).
    {
      provide: CALIBRATION_RAILS,
      useFactory: (): CalibrationRails => railsOf(loadCalibrationConfig()),
    },
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
    PROXY_BREAKER_PROVIDER,
    { provide: APP_FILTER, useClass: ProxyExceptionFilter },
  ],
  // The drain registry is shared with the batch surface (add-batch-inference task
  // 4.5): a results stream is an in-flight stream, and shutdown must drain both
  // through ONE deadline rather than two independent ones.
  exports: [StreamDrainRegistry],
})
export class ProxyModule {}
