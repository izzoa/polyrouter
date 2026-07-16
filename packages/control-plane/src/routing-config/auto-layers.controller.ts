import { Body, Controller, Get, Header, Put } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { AutoLayersDto } from './auto-layers.dto';
import { AutoLayersService, type AutoLayersView } from './auto-layers.service';

/** `/api/routing/auto-layers` — the tenant's auto-routing preference (#20).
 * Session-guarded (global guard), owner-scoped through the service. `GET`
 * reports effective + capability; `PUT` is a full replacement (both booleans). */
@Controller('api/routing/auto-layers')
export class AutoLayersController {
  constructor(private readonly svc: AutoLayersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@CurrentPrincipal() principal: Principal): Promise<AutoLayersView> {
    return this.svc.get(principal);
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  set(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: AutoLayersDto,
  ): Promise<AutoLayersView> {
    return this.svc.set(principal, dto);
  }
}
