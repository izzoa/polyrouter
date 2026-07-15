import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Put } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { CreateTierDto, ReplaceEntriesDto, UpdateTierDto } from './routing-config.dto';
import { RoutingConfigService, type SafeEntry, type SafeTier } from './routing-config.service';

/** `/api/routing/tiers` — session-guarded (global guard), tenant-scoped through
 * the service. Includes the nested ordered-entry chain under `:tierId/entries`. */
@Controller('api/routing/tiers')
export class TiersController {
  constructor(private readonly svc: RoutingConfigService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<SafeTier[]> {
    return this.svc.listTiers(principal);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@CurrentPrincipal() principal: Principal, @Body() dto: CreateTierDto): Promise<SafeTier> {
    return this.svc.createTier(principal, dto);
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<SafeTier> {
    return this.svc.getTier(principal, id);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() dto: UpdateTierDto,
  ): Promise<SafeTier> {
    return this.svc.updateTier(principal, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ deleted: boolean }> {
    return this.svc.deleteTier(principal, id);
  }

  @Get(':tierId/entries')
  listEntries(
    @CurrentPrincipal() principal: Principal,
    @Param('tierId') tierId: string,
  ): Promise<SafeEntry[]> {
    return this.svc.listEntries(principal, tierId);
  }

  // Replace the whole ordered chain atomically (assign / reorder / unassign /
  // set-primary in one call); position 0 is the primary.
  @Put(':tierId/entries')
  @Header('Cache-Control', 'no-store')
  replaceEntries(
    @CurrentPrincipal() principal: Principal,
    @Param('tierId') tierId: string,
    @Body() dto: ReplaceEntriesDto,
  ): Promise<SafeEntry[]> {
    return this.svc.replaceEntries(principal, tierId, dto.modelIds);
  }
}
