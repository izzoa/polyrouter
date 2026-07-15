import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { loadPricingConfig } from './pricing.config';
import { fetchLiteLlmCatalog } from './litellm-fetch';
import { PricingBootstrap } from './pricing.bootstrap';
import { PricingController } from './pricing.controller';
import {
  PRICING_FETCH,
  PRICING_RUNTIME,
  PricingService,
  type PricingRuntime,
} from './pricing.service';

/** Pricing catalog (#8): the effective-dated catalog service + seed-on-boot +
 * management API. `PRICING_RUNTIME` resolves the LiteLLM refresh URL/limits +
 * mode from config; `PRICING_FETCH` is the guarded fetch (overridable in tests). */
@Module({
  imports: [DatabaseModule],
  controllers: [PricingController],
  providers: [
    PricingService,
    PricingBootstrap,
    { provide: PRICING_FETCH, useValue: fetchLiteLlmCatalog },
    {
      provide: PRICING_RUNTIME,
      useFactory: (): PricingRuntime => {
        const { pricing, base } = loadPricingConfig();
        return {
          mode: base.MODE,
          refreshUrl: pricing.PRICING_REFRESH_URL,
          timeoutMs: pricing.PRICING_FETCH_TIMEOUT_MS,
          maxBytes: pricing.PRICING_MAX_BYTES,
        };
      },
    },
  ],
  exports: [PricingService],
})
export class PricingModule {}
