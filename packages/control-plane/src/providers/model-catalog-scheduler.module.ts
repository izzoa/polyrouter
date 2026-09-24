import { Module } from '@nestjs/common';
import { DatabaseMaintenanceModule } from '../database/maintenance.module';
import { RedisModule } from '../redis/redis.module';
import { ModelCatalogScheduler } from './model-catalog.scheduler';
import { ProvidersModule } from './providers.module';

/**
 * The daily model-catalog refresh's own module (add-live-subscription-models).
 * Controller-free by construction: it enumerates providers across owners through
 * `PERSISTENCE_MAINTENANCE`, which a request-handling module never imports. It consumes
 * the providers service through `ProvidersModule`'s export (that module never sees the
 * maintenance port).
 */
@Module({
  imports: [DatabaseMaintenanceModule, RedisModule, ProvidersModule],
  providers: [ModelCatalogScheduler],
})
export class ModelCatalogSchedulerModule {}
