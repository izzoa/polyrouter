import type { Redis } from 'ioredis';

/** Atomic fixed-window: INCR, set expiry only on the first hit, return
 * [count, ttlSeconds]. Avoids the INCR-then-EXPIRE leak where a crash between
 * the two leaves a counter that never expires. */
const FIXED_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {c, ttl}
`;

export interface RateRule {
  /** path prefix this rule matches (Better Auth 1.6 routes). */
  prefix: string;
  max: number;
  windowSec: number;
  /** Redis key namespace (default `auth`). Lets the same limiter guard non-auth
   * surfaces (e.g. the per-channel test-send, E14.2) without colliding keys. */
  keyspace?: string;
}

/** Better Auth 1.6 route limits (codex round 2: real endpoint names). */
export const AUTH_RATE_RULES: RateRule[] = [
  { prefix: '/api/auth/sign-in', max: 10, windowSec: 60 },
  { prefix: '/api/auth/sign-up', max: 5, windowSec: 60 },
  { prefix: '/api/auth/request-password-reset', max: 3, windowSec: 300 },
  { prefix: '/api/auth/reset-password', max: 3, windowSec: 300 },
  // Public invite acceptance (user-administration): token-guessing gets the
  // same per-IP throttle discipline as the auth routes.
  { prefix: '/api/invites/accept', max: 5, windowSec: 60 },
  // Subscription-OAuth connect endpoints (add-subscription-oauth): they drive
  // outbound calls to a third-party token endpoint — per-IP throttled here, and
  // per-PRINCIPAL throttled again inside the controller.
  { prefix: '/api/providers/oauth', max: 10, windowSec: 60, keyspace: 'oauthc' },
];

export function matchRule(path: string): RateRule | null {
  // Case-insensitive (E9.2): an upper-case auth path must be throttled identically.
  const lower = path.toLowerCase();
  return AUTH_RATE_RULES.find((r) => lower.startsWith(r.prefix)) ?? null;
}

export interface RateDecision {
  allowed: boolean;
  retryAfterSec: number;
}

/** Per-instance fixed-window fallback used when Redis is unavailable. Same
 * limits; degrades global→per-instance counting, never fully open. */
class InProcessLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  hit(key: string, rule: RateRule, now: number): RateDecision {
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + rule.windowSec * 1000 });
      return { allowed: true, retryAfterSec: 0 };
    }
    w.count += 1;
    const retryAfterSec = Math.ceil((w.resetAt - now) / 1000);
    return { allowed: w.count <= rule.max, retryAfterSec };
  }

  /** Bounded cleanup so the map can't grow without limit. */
  sweep(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }
}

export class AuthRateLimiter {
  private readonly fallback = new InProcessLimiter();

  constructor(
    private readonly redis: Redis,
    private readonly onRedisError: (err: unknown) => void,
  ) {}

  async check(ip: string, rule: RateRule, now: number): Promise<RateDecision> {
    // `ip` is the identity component (a client IP for auth, a user id for a
    // per-user surface). Default keyspace `auth` keeps existing auth keys stable.
    const key = `rl:${rule.keyspace ?? 'auth'}:${rule.prefix}:${ip}`;
    try {
      const result = (await this.redis.eval(FIXED_WINDOW_LUA, 1, key, String(rule.windowSec))) as [
        number,
        number,
      ];
      const [count, ttl] = result;
      return { allowed: count <= rule.max, retryAfterSec: ttl > 0 ? ttl : rule.windowSec };
    } catch (err) {
      // Redis down → per-instance fallback with identical limits.
      this.onRedisError(err);
      this.fallback.sweep(now);
      return this.fallback.hit(key, rule, now);
    }
  }
}
