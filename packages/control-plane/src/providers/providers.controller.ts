import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { CreateProviderDto, UpdateProviderDto } from './providers.dto';
import { ProvidersService, type ActionResult, type SafeProvider } from './providers.service';

/** `/api/providers` — session-guarded (global guard), tenant-scoped through the
 * service. Credentials are encrypted at rest and never returned; action results
 * are sanitized. */
@Controller('api/providers')
export class ProvidersController {
  constructor(private readonly svc: ProvidersService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<SafeProvider[]> {
    return this.svc.list(principal);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateProviderDto,
  ): Promise<SafeProvider> {
    return this.svc.create(principal, dto);
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<SafeProvider> {
    return this.svc.get(principal, id);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() dto: UpdateProviderDto,
  ): Promise<SafeProvider> {
    return this.svc.update(principal, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ deleted: boolean }> {
    return this.svc.remove(principal, id);
  }

  @Post(':id/test-connection')
  @HttpCode(200)
  testConnection(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<ActionResult> {
    return this.svc.testConnection(principal, id);
  }

  @Post(':id/sync-models')
  @HttpCode(200)
  syncModels(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<ActionResult> {
    return this.svc.syncModels(principal, id);
  }
}
