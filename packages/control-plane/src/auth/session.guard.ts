import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IDENTITY_PORT,
  userPrincipal,
  type IdentityPort,
  type Principal,
} from '@polyrouter/shared/server';
import type { BaseConfig } from '@polyrouter/shared';
import { AUTH_INSTANCE } from './auth.tokens';
import { autoLoginEligible } from './auto-login';
import { isApiPath } from '../planes';
import { loadAuthConfig } from './auth.config';
import { PUBLIC_KEY, type AuthedRequest } from './principal.decorator';
import type { AuthInstance } from './better-auth';

/** Protects `/api/**` (bound in the module, not global — `/v1` is the
 * agent-key plane). Resolves the session → tenant principal, or applies
 * hardened localhost auto-login on a loopback-bound self-host instance. */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly base: BaseConfig;
  private readonly dashboardOrigin: string;

  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_INSTANCE) private readonly auth: AuthInstance,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
  ) {
    const { auth: authCfg, base } = loadAuthConfig();
    this.base = base;
    this.dashboardOrigin = authCfg.DASHBOARD_ORIGIN;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    // Plane-scoped: the session guard governs `/api` only. `/v1` is the
    // agent-key plane (its routes carry AgentApiKeyGuard); a session cookie is
    // inert there. `/api/auth/*` is handled by the mounted Better Auth handler
    // before Nest routing, so it never reaches here.
    if (!isApiPath(req.path)) return true;

    const principal = await this.resolvePrincipal(req);
    if (principal === null) throw new UnauthorizedException();
    req.principal = principal;
    return true;
  }

  /**
   * Resolve the authorized principal for a request, or `null` if it is not
   * authorized. THE single authorization path — `canActivate` uses it, and the
   * dashboard event stream re-runs it periodically to revalidate a long-lived
   * connection (phase2-add-dashboard-event-stream). Sharing one code path is what
   * makes "revalidation applies the same rules as the guard, including loopback
   * auto-login" true by construction rather than by careful duplication.
   */
  async resolvePrincipal(req: AuthedRequest): Promise<Principal | null> {
    const session = await this.auth.getSession(req.headers);
    if (session) {
      // Disabled users are denied fail-closed even with an otherwise-valid
      // session (user-administration; their session rows are also deleted on
      // disable, so this is defense-in-depth for the race window).
      if (await this.identity.isDisabled(session.user.id)) return null;
      return userPrincipal(session.user.id);
    }

    // No session: hardened localhost auto-login (self-host only).
    if (
      autoLoginEligible(req, {
        mode: this.base.MODE,
        bindAddress: this.base.BIND_ADDRESS,
        dashboardOrigin: this.dashboardOrigin,
      })
    ) {
      const adminId = await this.identity.findAdminUserId();
      if (adminId) return userPrincipal(adminId);
    }

    return null;
  }
}
