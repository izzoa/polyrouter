import { Controller, Delete, Get, Header, Param, Query } from '@nestjs/common';
import type { InflightSnapshot, Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { InflightRegistry } from '../inflight/inflight-registry';
import { AnalyticsService } from './analytics.service';
import {
  AutoQueryDto,
  BreakdownQueryDto,
  RequestsQueryDto,
  SummaryQueryDto,
  TimeseriesQueryDto,
} from './analytics.dto';

/** `/api/analytics` — session-guarded, tenant-scoped aggregations over the request
 * log (#17, spec §9). Powers the dashboard's Observe pages (#19). Read-only. */
@Controller('api/analytics')
export class AnalyticsController {
  constructor(
    private readonly svc: AnalyticsService,
    private readonly inflight: InflightRegistry,
  ) {}

  @Get('summary')
  summary(@CurrentPrincipal() principal: Principal, @Query() q: SummaryQueryDto) {
    return this.svc.summary(principal, q);
  }

  @Get('timeseries')
  timeseries(@CurrentPrincipal() principal: Principal, @Query() q: TimeseriesQueryDto) {
    return this.svc.timeseries(principal, q);
  }

  @Get('auto')
  auto(@CurrentPrincipal() principal: Principal, @Query() q: AutoQueryDto) {
    return this.svc.autoPerformance(principal, q);
  }

  @Get('breakdown')
  breakdown(@CurrentPrincipal() principal: Principal, @Query() q: BreakdownQueryDto) {
    return this.svc.breakdown(principal, q);
  }

  @Get('requests')
  requests(@CurrentPrincipal() principal: Principal, @Query() q: RequestsQueryDto) {
    return this.svc.listRequests(principal, q);
  }

  /** add-inflight-requests: the live in-flight snapshot for the Overview card —
   * owner-scoped, bounded, `no-store`; `{items:[],available:false}` when the
   * registry is down/hung, never a 5xx and never a stall. */
  @Get('inflight')
  @Header('Cache-Control', 'no-store')
  inflightSnapshot(@CurrentPrincipal() principal: Principal): Promise<InflightSnapshot> {
    return this.inflight.list(principal);
  }

  /** add-body-capture: the inspector's lazily-fetched payloads — decrypt-on-
   * read, owner-scoped, 404 when none. Content NEVER rides the listing. */
  @Get('requests/:id/bodies')
  @Header('Cache-Control', 'no-store')
  requestBodies(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.svc.requestBodies(principal, id);
  }

  @Delete('requests/:id/bodies')
  @Header('Cache-Control', 'no-store')
  deleteRequestBodies(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.svc.deleteRequestBodies(principal, id);
  }
}
