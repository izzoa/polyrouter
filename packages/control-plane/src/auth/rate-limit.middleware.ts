import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import type { NextFunction, Request, Response } from 'express';
import { loadAuthConfig } from './auth.config';
import { clientIp } from './client-ip';
import { AuthRateLimiter, matchRule } from './rate-limit';

/** Throttles the Better Auth sign-in/sign-up/reset routes ahead of the auth
 * handler. Atomic Redis window; per-instance fallback on outage. */
@Injectable()
export class AuthRateLimitMiddleware implements NestMiddleware {
  private readonly limiter: AuthRateLimiter;
  private readonly trustedCidrs: string[];
  private readonly selfhosted: boolean;
  private redisWarned = false;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    const { auth, base } = loadAuthConfig();
    this.trustedCidrs = auth.TRUSTED_PROXY_CIDRS;
    this.selfhosted = base.MODE === 'selfhosted';
    this.limiter = new AuthRateLimiter(redis, (err) => {
      if (!this.redisWarned) {
        this.redisWarned = true;
        const scope = this.selfhosted ? 'fail-open per-instance' : 'DEGRADED per-instance (cloud)';
        console.error(`[auth] rate-limiter Redis unavailable — ${scope} fallback active`, err);
      }
    });
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const rule = matchRule(req.path);
    if (!rule) {
      next();
      return;
    }
    const ip = clientIp(req, this.trustedCidrs);
    const decision = await this.limiter.check(ip, rule, Date.now());
    if (decision.allowed) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(decision.retryAfterSec));
    res
      .status(429)
      .json({ statusCode: 429, message: 'Too many requests', error: 'Too Many Requests' });
  }
}
