import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PricingService } from './pricing.service';

/** Seeds the bundled pricing catalog after migrations, before serving (#8).
 * Goes through the same locked `applyVersions` — idempotent, monotonic,
 * override-respecting, multi-instance-race-safe (advisory lock). */
@Injectable()
export class PricingBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('PricingBootstrap');
  constructor(private readonly pricing: PricingService) {}

  async onApplicationBootstrap(): Promise<void> {
    const added = await this.pricing.seed();
    if (added > 0) this.logger.log(`Seeded ${String(added)} bundled price version(s)`);
  }
}
