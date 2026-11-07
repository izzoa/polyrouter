import type { BreakerRedis } from '@polyrouter/data-plane';
import type { Redis } from 'ioredis';
import { BREAKER_REDIS_TIMEOUT_MS } from '../proxy/proxy.config';

/** ioredis `eval` bounded by a fail-fast deadline so a slow/down Redis
 * degrades to the in-memory fallback without stalling the request (#12).
 * Shared by the circuit breaker store and the plan-cooldown store
 * (classify-plan-quota-errors, design D6a/D7): both depend only on `eval`, so
 * this one race covers every operation either of them issues. */
export function boundedBreakerRedis(redis: Redis): BreakerRedis {
  return {
    eval: (script, numKeys, ...args) =>
      Promise.race([
        redis.eval(script, numKeys, ...args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('breaker redis timeout')), BREAKER_REDIS_TIMEOUT_MS),
        ),
      ]),
  };
}
