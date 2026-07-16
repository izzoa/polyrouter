import { Body, Controller, Get, Header, Param, Patch, Query } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { ListModelsQueryDto, UpdateModelPricingDto } from './providers.dto';
import { ProvidersService, type SafeModel } from './providers.service';

/** `/api/models` — session-guarded, tenant-scoped (models owned through their
 * providers). List + filter for the dashboard and routing UI, plus custom/local
 * price editing (#18 §7.7); no credentials. */
@Controller('api/models')
export class ModelsController {
  constructor(private readonly svc: ProvidersService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListModelsQueryDto,
  ): Promise<SafeModel[]> {
    return this.svc.listModels(principal, query);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  updatePricing(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() dto: UpdateModelPricingDto,
  ): Promise<SafeModel> {
    return this.svc.updateModelPricing(principal, id, dto);
  }
}
