import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { ProducersModule } from '../producers/producers.module';
import { ObservabilityModule } from '../observability/observability.module';
import { BudgetsController } from './budgets.controller';
import { BudgetsCrudService } from './budgets.crud';
import { BudgetCache } from './budget-cache';
import { BudgetService } from './budget-service';
import { BudgetScheduler } from './budget.scheduler';
import { SpendCounter } from './spend-counter';
import { BUDGETS_CONFIG, resolveBudgetsConfig } from './budgets.config';

/**
 * Spend limits (#16). Owns the Redis spend counter (`SpendCounter`, dedicated
 * fail-fast connection), the block-check `BudgetService` (exported for the proxy),
 * the owner cache, CRUD, and the reconcile `BudgetScheduler` (the SOLE counter
 * writer, on its own `budget-eval` queue). Reconcile spend from the request-log
 * ledgers via `DatabaseModule`'s narrow `BUDGET_READER`; budget events go through
 * `ProducersModule`'s `NotificationProducers`. No writer/`SPEND_SINK` coupling —
 * `RecordingModule` is untouched.
 */
@Module({
  imports: [DatabaseModule, RedisModule, ProducersModule, ObservabilityModule],
  controllers: [BudgetsController],
  providers: [
    { provide: BUDGETS_CONFIG, useFactory: resolveBudgetsConfig },
    SpendCounter,
    BudgetCache,
    BudgetService,
    BudgetScheduler,
    BudgetsCrudService,
  ],
  exports: [BudgetService],
})
export class BudgetsModule {}
