import { Controller, Get, Query } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { AnalyticsService } from './analytics.service';
import {
  BreakdownQueryDto,
  RequestsQueryDto,
  SummaryQueryDto,
  TimeseriesQueryDto,
} from './analytics.dto';

/** `/api/analytics` — session-guarded, tenant-scoped aggregations over the request
 * log (#17, spec §9). Powers the dashboard's Observe pages (#19). Read-only. */
@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get('summary')
  summary(@CurrentPrincipal() principal: Principal, @Query() q: SummaryQueryDto) {
    return this.svc.summary(principal, q);
  }

  @Get('timeseries')
  timeseries(@CurrentPrincipal() principal: Principal, @Query() q: TimeseriesQueryDto) {
    return this.svc.timeseries(principal, q);
  }

  @Get('breakdown')
  breakdown(@CurrentPrincipal() principal: Principal, @Query() q: BreakdownQueryDto) {
    return this.svc.breakdown(principal, q);
  }

  @Get('requests')
  requests(@CurrentPrincipal() principal: Principal, @Query() q: RequestsQueryDto) {
    return this.svc.listRequests(principal, q);
  }
}
