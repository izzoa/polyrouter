/**
 * Key-preset endpoints (add-key-subscription-presets, design D7). Session-guarded (global
 * guard), tenant-scoped through the service. TWO-segment literal paths on purpose: a
 * one-segment `GET /api/providers/key-presets` would compete with `ProvidersController`'s
 * `@Get(':id')` by cross-controller registration order. No per-principal rate limiter:
 * nothing here dials out or mints sessions, matching `POST /api/providers`.
 */
import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { clientIdentityView } from '../providers/client-identity';
import { toSafe, type SafeProvider } from '../providers/providers.service';
import { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import { KeyPresetConnectDto } from './subscription-presets.dto';
import { SubscriptionPresetsService, type KeyPresetDto } from './subscription-presets.service';

@Controller('api/providers')
export class KeyPresetsController {
  constructor(
    private readonly svc: SubscriptionPresetsService,
    private readonly oauth: SubscriptionOauthService,
  ) {}

  @Get('key-presets/available')
  listAvailable(): KeyPresetDto[] {
    return this.svc.listAvailable();
  }

  @Post('key-presets/connect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async connect(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: KeyPresetConnectDto,
  ): Promise<SafeProvider> {
    const row = await this.svc.connect(principal, dto);
    // A new row's switch is off, but a preset that declares an identity still names its
    // `clientIdentity`, so the SPA (which adds this response without a reload) can show the
    // Edit switch (design D7 step 6).
    return toSafe(row, clientIdentityView(this.oauth.availableClientIdentity(row)));
  }
}
