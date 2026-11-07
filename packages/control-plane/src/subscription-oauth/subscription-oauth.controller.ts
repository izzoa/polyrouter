/**
 * Connect endpoints (add-subscription-oauth). Session-guarded (global guard),
 * tenant-scoped through the service; per-IP throttled by the global rate-limit rule
 * for `/api/providers/oauth` and per-PRINCIPAL throttled here. Responses carry
 * `Cache-Control: no-store` (they reference credential-bearing flows). The completion
 * binds to the same principal AND the same login session that started the flow — the
 * login-session key is a hash of the Better Auth session cookie (no secret stored).
 */
import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  Optional,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { PlanUsageRecorder, PlanUsageStore } from '@polyrouter/data-plane';
import { REDIS_CLIENT, type Principal } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import type { Request } from 'express';
import { AuthRateLimiter, type RateRule } from '../auth/rate-limit';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { clientIdentityView } from '../providers/client-identity';
import { clearPlanUsageSnapshot } from '../plan-usage/plan-usage-clear';
import { PLAN_USAGE_RECORDER, PLAN_USAGE_STORE } from '../plan-usage/plan-usage.tokens';
import { planUsageSourcesFor } from '../plan-usage/plan-usage-sources';
import { toSafe, type SafeProvider } from '../providers/providers.service';
import { OauthCompleteDto, OauthStartDto } from './subscription-oauth.dto';
import { SubscriptionOauthService, type StartResult } from './subscription-oauth.service';

const PER_PRINCIPAL_RULE: RateRule = {
  prefix: 'oauth-principal',
  max: 10,
  windowSec: 60,
  keyspace: 'oauthp',
};

/** Stable within one login session; changes across logins. Hash only — the cookie
 * value itself is never stored or logged. Localhost auto-login has no cookie → a
 * fixed marker (single-user loopback context). */
export function authSessionKeyFrom(req: Request): string {
  const cookies = (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.toLowerCase().includes('session_token'))
    .sort()
    .join(';');
  if (cookies === '') return 'auto-login';
  return createHash('sha256').update(cookies).digest('base64url');
}

@Controller('api/providers')
export class SubscriptionOauthController {
  private readonly principalLimiter: AuthRateLimiter;
  private readonly logger = new Logger(SubscriptionOauthController.name);

  constructor(
    private readonly svc: SubscriptionOauthService,
    @Inject(REDIS_CLIENT) redis: Redis,
    // add-subscription-quota-display (design D8): a completed (re)connect discards the row's
    // plan-usage snapshot. Optional so hand-wired harnesses still compile.
    @Optional()
    @Inject(PLAN_USAGE_STORE)
    private readonly planUsageStore?: PlanUsageStore,
    @Optional()
    @Inject(PLAN_USAGE_RECORDER)
    private readonly planUsageRecorder?: PlanUsageRecorder,
  ) {
    this.principalLimiter = new AuthRateLimiter(redis, () => undefined);
  }

  private async throttlePrincipal(principal: Principal): Promise<void> {
    const key = principal.kind === 'user' ? `user:${principal.userId}` : `org:${principal.orgId}`;
    const d = await this.principalLimiter.check(key, PER_PRINCIPAL_RULE, Date.now());
    if (!d.allowed) {
      throw new HttpException('too many connect attempts — try again shortly', 429);
    }
  }

  @Get('oauth/presets')
  listPresets(): Array<{
    id: string;
    displayName: string;
    clientIdentity: { label: string } | null;
  }> {
    return this.svc.listEnabledPresets();
  }

  @Post('oauth/start')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async start(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Body() dto: OauthStartDto,
  ): Promise<StartResult> {
    await this.throttlePrincipal(principal);
    return this.svc.start(principal, authSessionKeyFrom(req), {
      preset: dto.preset,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.imitateClientIdentity !== undefined
        ? { imitateClientIdentity: dto.imitateClientIdentity }
        : {}),
    });
  }

  @Post('oauth/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async complete(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Body() dto: OauthCompleteDto,
  ): Promise<SafeProvider> {
    await this.throttlePrincipal(principal);
    const row = await this.svc.complete(principal, authSessionKeyFrom(req), {
      sessionId: dto.sessionId,
      pasted: dto.pasted,
    });
    // A reconnect may bring another account, so the row's plan-usage snapshot is discarded and its
    // generation raised: awaited (the complete's write has committed by now), bounded, logged, and
    // never failing the reply (design D8). A token refresh never gets here.
    if (planUsageSourcesFor(row, this.svc.identityBindingFor(row)) !== null) {
      await clearPlanUsageSnapshot(
        this.planUsageStore,
        this.planUsageRecorder,
        row.id,
        this.logger,
      );
    }
    // An OAuth row carries no plan-error dialect, so it has no cooldown (null, no store call), and
    // the reply keeps toSafe's null plan usage (the page reloads its list after a reconnect).
    return toSafe(row, clientIdentityView(this.svc.availableClientIdentity(row)), null);
  }

  // Path lives under `oauth/` so the per-IP throttle rule prefix covers it too
  // (codex round 3): /api/providers/oauth/reauthorize/:id.
  @Post('oauth/reauthorize/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reauthorize(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<StartResult> {
    await this.throttlePrincipal(principal);
    return this.svc.startReauthorize(principal, authSessionKeyFrom(req), id);
  }
}
