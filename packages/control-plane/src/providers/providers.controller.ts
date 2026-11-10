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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { loadConfig } from '@polyrouter/shared';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { resolveProxyBounds, type ProxyRawConfig } from '../proxy/proxy.config';
import { CreateProviderDto, UpdateProviderDto } from './providers.dto';
import type { PlanUsageHistory } from '../plan-usage/plan-usage-history';
import {
  PlanUsageCooldownException,
  ProvidersService,
  type ActionResult,
  type PlanUsageRefreshResult,
  type SafeProvider,
} from './providers.service';

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

  /** The INSTANCE timeout defaults (fix-long-call-timeouts) — non-secret, for
   * the provider form's honest inherit display. Declared BEFORE `:id` so the
   * literal path wins route matching. */
  @Get('timeout-defaults')
  @Header('Cache-Control', 'no-store')
  timeoutDefaults(): { firstByteTimeoutMs: number; idleTimeoutMs: number } {
    const bounds = resolveProxyBounds(loadConfig<ProxyRawConfig>());
    return { firstByteTimeoutMs: bounds.firstByteTimeoutMs, idleTimeoutMs: bounds.idleTimeoutMs };
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

  /** "Resume now" (classify-plan-quota-errors, design D10): lifts the provider's plan cooldown.
   * `204` when the shared record was deleted or was already absent; `404` for another tenant's
   * id (the owner-scoped lookup runs first); `503` when the shared store could not be reached,
   * never a `204` for a lift that did not happen. A two-segment path, so it cannot collide with
   * `@Get(':id')`. */
  @Delete(':id/plan-cooldown')
  @HttpCode(204)
  async liftPlanCooldown(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.svc.liftPlanCooldown(principal, id);
  }

  /** "Refresh usage" (add-subscription-quota-display, design D8): an attended, owner-scoped read
   * of a key plan's usage endpoint, once per shared cooldown. `200` carries `ok` (true, or false
   * with a kind and a fixed message) and the provider view; `404` another tenant's id (checked
   * first), `422` no enabled usage endpoint, `429` + `Retry-After` while the cooldown holds, `503`
   * when the shared store is unreachable. Writes no health record, breaker state or plan cooldown.
   * `no-store`: the answer is account usage. */
  @Post(':id/plan-usage/refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async refreshPlanUsage(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlanUsageRefreshResult> {
    try {
      return await this.svc.refreshPlanUsage(principal, id);
    } catch (err) {
      if (err instanceof PlanUsageCooldownException) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
      }
      throw err;
    }
  }

  /** The plan-usage history (add-subscription-usage-history, design D5): each window's samples
   * over its current span, oldest first. `404` for another tenant's id (the owner-scoped lookup
   * runs first); an empty `windows` list without samples. Calls no usage endpoint, claims no
   * cooldown. `no-store`: the answer is account usage. */
  @Get(':id/plan-usage/history')
  @Header('Cache-Control', 'no-store')
  planUsageHistory(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<PlanUsageHistory> {
    return this.svc.planUsageHistory(principal, id);
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
