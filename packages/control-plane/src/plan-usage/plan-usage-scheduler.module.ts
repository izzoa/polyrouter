import { Module } from '@nestjs/common';
import { DatabaseMaintenanceModule } from '../database/maintenance.module';
import { ProvidersModule } from '../providers/providers.module';
import { RedisModule } from '../redis/redis.module';
import { PlanUsageModule } from './plan-usage.module';
import { PlanUsageScheduler } from './plan-usage.scheduler';

/**
 * The plan-usage schedule's own module (add-subscription-usage-history, design D1).
 * Controller-free by construction: it enumerates subscription providers across owners through
 * `PERSISTENCE_MAINTENANCE`, which a request-handling module never imports. It reads through the
 * providers service (`ProvidersModule`'s export) and the ONE shared plan-usage store
 * (`PlanUsageModule`, the same instance the proxy and the service use).
 */
@Module({
  imports: [DatabaseMaintenanceModule, RedisModule, ProvidersModule, PlanUsageModule],
  providers: [PlanUsageScheduler],
})
export class PlanUsageSchedulerModule {}
