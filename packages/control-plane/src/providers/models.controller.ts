import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { ListModelsQueryDto, UpdateModelPricingDto } from './providers.dto';
import { ProvidersService, type SafeModel } from './providers.service';

/** `/api/models` — session-guarded, tenant-scoped (models owned through their
 * providers). List + filter for the dashboard and routing UI, plus custom/local
 * price editing (#18 §7.7), and removal of a model the provider no longer lists
 * (add-live-subscription-models); no credentials. */
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

  /** Remove a model ONLY while its provider no longer lists it: 204 / 404 (not
   * yours, or gone) / 409 (still listed). Tier entries cascade; a `model:` rule
   * targeting it becomes an unresolved target. */
  @Delete(':id')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<void> {
    await this.svc.removeUnlistedModel(principal, id);
  }
}
