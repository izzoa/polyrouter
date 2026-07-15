import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { IDENTITY_PORT, userPrincipal, type IdentityPort } from '@polyrouter/shared/server';
import type { Request } from 'express';
import { loadAuthConfig } from './auth.config';
import { resolveAuthSecrets } from './auth.config';
import { prefixOf, verifyAgentKey } from '../agents/agent-keys';
import type { AuthedRequest } from './principal.decorator';

const TOUCH_INTERVAL_MS = 60_000;

/** Bearer agent-key verification for the `/v1` plane (invariant 7): prefix
 * lookup → constant-time HMAC compare, uniform 401s, and a coalesced,
 * fire-and-forget `last_used_at` stamp that never blocks or crashes. */
@Injectable()
export class AgentApiKeyGuard implements CanActivate {
  private readonly hmacSecret: string;
  private readonly lastTouch = new Map<string, number>();

  constructor(@Inject(IDENTITY_PORT) private readonly identity: IdentityPort) {
    const { auth, base } = loadAuthConfig();
    this.hmacSecret = resolveAuthSecrets(auth, base).apiKeyHmacSecret;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const key = this.extractKey(req);
    if (!key) throw new UnauthorizedException();

    const prefix = prefixOf(key);
    if (!prefix) throw new UnauthorizedException();

    const record = await this.identity.agentAuth.findByPrefix(prefix);
    if (!record || !verifyAgentKey(key, record.apiKeyHash, this.hmacSecret)) {
      throw new UnauthorizedException();
    }

    req.principal = userPrincipal(record.ownerUserId);
    (req as AuthedRequest & { agentId?: string }).agentId = record.id;
    this.coalescedTouch(record.id);
    return true;
  }

  /** Accept the key from `Authorization: Bearer` (OpenAI SDK) or `x-api-key`
   * (Anthropic SDK) so both are drop-in. Two credential headers that disagree
   * are treated as no valid key (401) — a request must present one identity. */
  private extractKey(req: Request): string | null {
    const bearer = this.bearerToken(req);
    const raw = req.headers['x-api-key'];
    const xApiKey = typeof raw === 'string' && raw.length > 0 ? raw : null;
    if (bearer !== null && xApiKey !== null) {
      return bearer === xApiKey ? bearer : null;
    }
    return bearer ?? xApiKey;
  }

  private bearerToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return null;
    return token;
  }

  /** At most one stamp per agent per interval; never awaited, never throws. */
  private coalescedTouch(agentId: string): void {
    const now = Date.now();
    const last = this.lastTouch.get(agentId) ?? 0;
    if (now - last < TOUCH_INTERVAL_MS) return;
    this.lastTouch.set(agentId, now);
    void this.identity.agentAuth.touchLastUsed(agentId).catch(() => {
      // advisory UI data — a failed stamp must never affect the request
    });
  }
}
