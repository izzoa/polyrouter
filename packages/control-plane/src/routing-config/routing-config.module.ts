import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ROUTING_CONFIG, loadRoutingConfig } from '../proxy/routing.config';
import { AutoLayersController } from './auto-layers.controller';
import { AutoLayersService } from './auto-layers.service';
import { RoutingConfigService } from './routing-config.service';
import { RulesController } from './rules.controller';
import { TiersController } from './tiers.controller';

/** Routing configuration (#9): the explicit-routing data the proxy (#10) reads
 * — tier CRUD, the ordered ≤5-model entry chain, and header rules. CRUD only,
 * tenant-scoped; no routing execution. Also owns the per-tenant auto-layer
 * preference (#20), which the proxy reads at request time; `ROUTING_CONFIG`
 * supplies the boot capability the preference is masked against. */
@Module({
  imports: [DatabaseModule],
  controllers: [TiersController, RulesController, AutoLayersController],
  providers: [
    RoutingConfigService,
    AutoLayersService,
    { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
  ],
})
export class RoutingConfigModule {}
