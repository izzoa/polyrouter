import { Controller, Get, Inject, UnauthorizedException } from '@nestjs/common';
import { loadConfig, type BaseConfig } from '@polyrouter/shared';
import {
  IDENTITY_PORT,
  assertUserPrincipal,
  type IdentityPort,
  type Principal,
} from '@polyrouter/shared/server';
import { CurrentPrincipal, Public } from '../auth/principal.decorator';
import { enabledOauthProviders, type AuthConfig } from '../auth/auth.config';

/**
 * Dashboard identity + login bootstrap (#18). `GET /api/me` is the SPA's single
 * "am I authorized, and as whom" probe: the global `SessionGuard` resolves the
 * principal from a session cookie OR localhost auto-login (which issues no
 * cookie — so Better Auth `get-session` is null on self-host loopback, and this
 * endpoint is what the SPA relies on). `GET /api/login-config` is public and
 * named OUTSIDE the `/api/auth*` prefix (which the raw Better Auth middleware
 * intercepts before Nest); it tells the login gate which methods to render.
 */
@Controller('api')
export class AccountController {
  constructor(@Inject(IDENTITY_PORT) private readonly identity: IdentityPort) {}

  @Get('me')
  async me(@CurrentPrincipal() principal: Principal): Promise<{
    userId: string;
    email: string;
    name: string;
    role: string | null;
    mode: BaseConfig['MODE'];
  }> {
    assertUserPrincipal(principal);
    const id = await this.identity.getIdentity(principal.userId);
    if (id === null) throw new UnauthorizedException();
    return {
      userId: id.id,
      email: id.email,
      name: id.name,
      role: id.role,
      mode: loadConfig<BaseConfig>().MODE,
    };
  }

  @Get('login-config')
  @Public()
  loginConfig(): { mode: BaseConfig['MODE']; emailPassword: true; oauthProviders: string[] } {
    const cfg = loadConfig<AuthConfig & BaseConfig>();
    return { mode: cfg.MODE, emailPassword: true, oauthProviders: enabledOauthProviders(cfg) };
  }
}
