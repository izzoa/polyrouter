import { Body, Controller, Delete, Get, Header, Param, Patch, Post } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { CreateRuleDto, UpdateRuleDto } from './routing-config.dto';
import { RoutingConfigService, type SafeRule } from './routing-config.service';

/** `/api/routing/rules` — session-guarded (global guard), tenant-scoped through
 * the service. `list` returns rules in the proxy's (#10) evaluation order. */
@Controller('api/routing/rules')
export class RulesController {
  constructor(private readonly svc: RoutingConfigService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<SafeRule[]> {
    return this.svc.listRules(principal);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateRuleDto,
  ): Promise<SafeRule> {
    return this.svc.createRule(principal, dto);
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<SafeRule> {
    return this.svc.getRule(principal, id);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() dto: UpdateRuleDto,
  ): Promise<SafeRule> {
    return this.svc.updateRule(principal, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ deleted: boolean }> {
    return this.svc.deleteRule(principal, id);
  }
}
