import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { AgentOverrideDto, BodyCaptureUpdateDto } from './body-capture.dto';
import { BodyCaptureService, type BodyCaptureStatusView } from './body-capture.service';

/** `/api/body-capture` (add-body-capture) — the owner's capture control.
 * Session-guarded (global guard), owner-scoped through the service; the
 * selfhosted gate rejects any enable on a cloud instance. */
@Controller('api/body-capture')
export class BodyCaptureController {
  constructor(private readonly svc: BodyCaptureService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@CurrentPrincipal() principal: Principal): Promise<BodyCaptureStatusView> {
    return this.svc.status(principal);
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: BodyCaptureUpdateDto,
  ): Promise<BodyCaptureStatusView> {
    return this.svc.update(principal, dto);
  }

  @Post('purge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  purge(@CurrentPrincipal() principal: Principal): Promise<{ purged: number }> {
    return this.svc.purgeNow(principal);
  }

  @Patch('agents/:id/override')
  @Header('Cache-Control', 'no-store')
  async setOverride(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() dto: AgentOverrideDto,
  ): Promise<{ ok: true }> {
    await this.svc.setAgentOverride(principal, id, dto.override);
    return { ok: true };
  }
}
