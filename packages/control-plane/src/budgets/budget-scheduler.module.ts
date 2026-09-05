import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DatabaseMaintenanceModule } from '../database/maintenance.module';
import { ProducersModule } from '../producers/producers.module';
import { RedisModule } from '../redis/redis.module';
import { BudgetScheduler } from './budget.scheduler';
import { BudgetsModule } from './budgets.module';

/**
 * The reconcile scheduler's own module (add-batch-inference D8/D19): the SOLE
 * counter writer, now also reconciling batch reservations — which needs the
 * persistence module's maintenance half, and a controller-bearing module never
 * imports that. Controller-free by construction; consumes the counter, cache and
 * config through `BudgetsModule`'s exports.
 */
@Module({
  imports: [BudgetsModule, DatabaseModule, DatabaseMaintenanceModule, ProducersModule, RedisModule],
  providers: [BudgetScheduler],
})
export class BudgetSchedulerModule {}
