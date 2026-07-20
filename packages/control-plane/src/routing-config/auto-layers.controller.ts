import { Body, Controller, Get, Header, HttpCode, Post, Put, Query } from '@nestjs/common';
import type { Principal, ThresholdCalibrationEventRowView } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { AutoLayersDto, CalibrationHistoryQueryDto } from './auto-layers.dto';
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

/** `/api/routing/calibration` (add-auto-threshold-calibration): the revert
 * action and the audit history. Session-guarded, owner-scoped through the
 * service; the calibrator itself never rides this surface. */
@Controller('api/routing/calibration')
export class CalibrationController {
  constructor(private readonly svc: AutoLayersService) {}

  /** Idempotent: reverting while already on instance defaults is a 200 no-op
   * (and appends no event). */
  @Post('revert')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revert(@CurrentPrincipal() principal: Principal): Promise<AutoLayersView> {
    return this.svc.revert(principal);
  }

  @Get('history')
  @Header('Cache-Control', 'no-store')
  history(
    @CurrentPrincipal() principal: Principal,
    @Query() q: CalibrationHistoryQueryDto,
  ): Promise<ThresholdCalibrationEventRowView[]> {
    return this.svc.history(principal, q.limit);
  }
}
