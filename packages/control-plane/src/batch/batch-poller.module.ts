import { Module } from '@nestjs/common';
import { BudgetsModule } from '../budgets/budgets.module';
import { DatabaseModule } from '../database/database.module';
import { DatabaseMaintenanceModule } from '../database/maintenance.module';
import { EventsBusModule } from '../events/events-bus.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ProducersModule } from '../producers/producers.module';
import { RedisModule } from '../redis/redis.module';
import { BatchModule } from './batch.module';
import { BatchPoller } from './batch.poller';
import { BatchSettlement } from './batch-settlement';

/**
 * The batch poller's own module (add-batch-inference D19): controller-free, so it
 * may import the persistence module's maintenance half — a request-handling
 * module never does. It consumes `BatchService` (the adapter seam) and the
 * budget service through their modules' exports.
 */
@Module({
  imports: [
    BatchModule,
    DatabaseModule,
    DatabaseMaintenanceModule,
    BudgetsModule,
    ProducersModule,
    ObservabilityModule,
    EventsBusModule,
    RedisModule,
  ],
  providers: [BatchPoller, BatchSettlement],
  exports: [BatchSettlement],
})
export class BatchPollerModule {}
