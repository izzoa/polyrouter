import { Controller, Get, Query } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { ListModelsQueryDto } from './providers.dto';
import { ProvidersService, type SafeModel } from './providers.service';

/** `/api/models` — session-guarded, tenant-scoped (models owned through their
 * providers). List + filter for the dashboard and routing UI; no credentials. */
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
}
