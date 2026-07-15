import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RoutingConfigService } from './routing-config.service';
import { RulesController } from './rules.controller';
import { TiersController } from './tiers.controller';

/** Routing configuration (#9): the explicit-routing data the proxy (#10) reads
 * — tier CRUD, the ordered ≤5-model entry chain, and header rules. CRUD only,
 * tenant-scoped; no routing execution. */
@Module({
  imports: [DatabaseModule],
  controllers: [TiersController, RulesController],
  providers: [RoutingConfigService],
})
export class RoutingConfigModule {}
