import { Body, Controller, Delete, Get, Header, Param, Patch, Post } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { ChannelsService } from './channels.service';
import { CreateChannelDto, UpdateChannelDto } from './channels.dto';

/** Session-guarded (the global `SessionGuard` covers `/api`) notification-channel
 * CRUD + test-send (#15a, spec §9 Settings → Notifications). Responses are the
 * safe view — never the decrypted config. */
@Controller('api/notification-channels')
export class ChannelsController {
  constructor(private readonly svc: ChannelsService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.svc.list(principal);
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.svc.get(principal, id);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@CurrentPrincipal() principal: Principal, @Body() dto: CreateChannelDto) {
    return this.svc.create(principal, dto);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() dto: UpdateChannelDto,
  ) {
    return this.svc.update(principal, id, dto);
  }

  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.svc.remove(principal, id);
  }

  @Post(':id/test')
  @Header('Cache-Control', 'no-store')
  test(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.svc.testSend(principal, id);
  }
}
