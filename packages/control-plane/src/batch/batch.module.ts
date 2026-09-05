import { Module } from '@nestjs/common';
import { createProviderAdapter } from '@polyrouter/data-plane';
import { AuthModule } from '../auth/auth.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { DatabaseModule } from '../database/database.module';
import { PricingModule } from '../pricing/pricing.module';
import { SubscriptionOauthModule } from '../subscription-oauth/subscription-oauth.module';
import { ProxyModule } from '../proxy/proxy.module';
import { BatchAdminController } from './batch-admin.controller';
import { BatchController } from './batch.controller';
import { BatchService } from './batch.service';
import {
  BATCH_ADAPTER_FACTORY,
  BATCH_CONFIG,
  BATCH_RUNTIME,
  loadBatchRuntime,
  resolveBatchConfig,
} from './batch.config';

/**
 * Batch inference (add-batch-inference): the agent-key-plane batch routes and
 * the submit/read/cancel service. Reads persistence through the scoped port only
 * (a request-handling module — the poller, which needs the maintenance half,
 * lives in its own controller-free module). `BATCH_ADAPTER_FACTORY` defaults to
 * the data-plane factory and is overridable in tests, like the proxy's.
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    BudgetsModule,
    PricingModule,
    SubscriptionOauthModule,
    // For the shared `StreamDrainRegistry` only — a results stream drains on
    // shutdown exactly like a proxied SSE stream.
    ProxyModule,
  ],
  controllers: [BatchController, BatchAdminController],
  providers: [
    BatchService,
    { provide: BATCH_CONFIG, useFactory: resolveBatchConfig },
    { provide: BATCH_RUNTIME, useFactory: loadBatchRuntime },
    { provide: BATCH_ADAPTER_FACTORY, useValue: createProviderAdapter },
  ],
  // `BATCH_CONFIG` is exported, not just provided: `BatchPollerModule` imports this
  // module and injects the config into `BatchPoller`. Providing without exporting kept it
  // private to this module, so the poller resolved it in the e2e harness — which declares
  // its own copy of all three tokens — and nowhere else. The production graph could not
  // boot at all, which is what `prod-topology.e2e-spec.ts` caught.
  exports: [BatchService, BATCH_CONFIG],
})
export class BatchModule {}
