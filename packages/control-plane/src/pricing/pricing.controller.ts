import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  IDENTITY_PORT,
  assertUserPrincipal,
  type IdentityPort,
  type ModelPriceRow,
  type Principal,
} from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { OverrideDto, RefreshDto } from './pricing.dto';
import { PRICING_SCHEDULER_CONFIG } from './pricing-refresh.scheduler';
import type { PricingSchedulerConfig } from './pricing.config';
import {
  PRICING_RUNTIME,
  PricingService,
  type PricingRuntime,
  type RefreshInput,
} from './pricing.service';

/** `/api/pricing` (#8) — reads need a session; mutations require an admin on a
 * self-hosted instance (the catalog is global reference data; cloud disables
 * them). All mutations only append effective-dated versions. */
@Controller('api/pricing')
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(PRICING_RUNTIME) private readonly runtime: PricingRuntime,
    @Inject(PRICING_SCHEDULER_CONFIG) private readonly schedCfg: PricingSchedulerConfig,
  ) {}

  @Get()
  list(@CurrentPrincipal() _p: Principal): Promise<ModelPriceRow[]> {
    return this.pricing.listCatalog(new Date());
  }

  /** Catalog status (add-pricing-refresh-ui): session-read — global,
   * non-secret metadata; the scheduler trio lets the panel say exactly why a
   * schedule is or isn't running. */
  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(): Promise<{
    entryCount: number;
    newest: { source: string; validFrom: string; appliedAt: string } | null;
    lastRefresh: { at: string; added: number; skipped: number } | null;
    scheduler: {
      configuredEnabled: boolean;
      modePermitted: boolean;
      effectiveEnabled: boolean;
      cron: string;
    };
  }> {
    const meta = await this.pricing.status(new Date());
    const modePermitted = this.runtime.mode === 'selfhosted';
    return {
      ...meta,
      scheduler: {
        configuredEnabled: this.schedCfg.configuredEnabled,
        modePermitted,
        effectiveEnabled: this.schedCfg.configuredEnabled && modePermitted,
        cron: this.schedCfg.cron,
      },
    };
  }

  @Get(':modelKey')
  async get(
    @CurrentPrincipal() _p: Principal,
    @Param('modelKey') modelKey: string,
    @Query('at') at?: string,
  ): Promise<ModelPriceRow> {
    const ts = at !== undefined ? new Date(at) : new Date();
    if (Number.isNaN(ts.getTime())) throw new BadRequestException('invalid `at` timestamp');
    const row = await this.pricing.priceAt(modelKey, ts);
    if (row === null) throw new NotFoundException();
    return row;
  }

  @Post(':modelKey/override')
  @HttpCode(200)
  async override(
    @CurrentPrincipal() principal: Principal,
    @Param('modelKey') modelKey: string,
    @Body() dto: OverrideDto,
  ): Promise<{ added: number }> {
    await this.requireAdmin(principal);
    const added = await this.pricing.override(modelKey, dto, new Date());
    return { added };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: RefreshDto,
  ): Promise<{ added: number }> {
    await this.requireAdmin(principal);
    const input: RefreshInput = {
      source: dto.source,
      ...(dto.entries !== undefined ? { entries: dto.entries } : {}),
    };
    const added = await this.pricing.refresh(input, new Date());
    return { added };
  }

  /** Global-catalog mutations: admin AND self-host only (cloud is managed
   * out-of-band, so a cloud tenant-admin can't rewrite everyone's prices). */
  private async requireAdmin(principal: Principal): Promise<void> {
    if (this.runtime.mode !== 'selfhosted') {
      throw new ForbiddenException('pricing catalog mutations are disabled in cloud mode');
    }
    assertUserPrincipal(principal);
    if (!(await this.identity.isAdmin(principal.userId))) {
      throw new ForbiddenException('admin required');
    }
  }
}
