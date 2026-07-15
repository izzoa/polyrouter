import { AuthRateLimiter, matchRule } from './rate-limit';

interface FakeRedis {
  eval: (...args: unknown[]) => Promise<unknown>;
}

describe('auth rate limiter (session-auth)', () => {
  it('matches the real Better Auth 1.6 routes', () => {
    expect(matchRule('/api/auth/sign-in/email')?.max).toBe(10);
    expect(matchRule('/api/auth/sign-up/email')?.max).toBe(5);
    expect(matchRule('/api/auth/request-password-reset')?.max).toBe(3);
    expect(matchRule('/api/auth/reset-password')?.max).toBe(3);
    expect(matchRule('/api/auth/get-session')).toBeNull();
  });

  it('allows within the window and 429s past it (atomic count from Redis)', async () => {
    let count = 0;
    const redis: FakeRedis = {
      eval: () => {
        count += 1;
        return Promise.resolve([count, 60]);
      },
    };
    const limiter = new AuthRateLimiter(redis as never, () => undefined);
    const rule = matchRule('/api/auth/sign-in/email')!;
    const now = 1_000;
    for (let i = 0; i < rule.max; i++) {
      expect((await limiter.check('1.2.3.4', rule, now)).allowed).toBe(true);
    }
    const over = await limiter.check('1.2.3.4', rule, now);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBe(60);
  });

  it('falls back to a per-instance limiter on Redis outage (identical limits)', async () => {
    let errored = 0;
    const redis: FakeRedis = { eval: () => Promise.reject(new Error('down')) };
    const limiter = new AuthRateLimiter(redis as never, () => (errored += 1));
    const rule = matchRule('/api/auth/sign-up/email')!;
    const now = 5_000;
    for (let i = 0; i < rule.max; i++) {
      expect((await limiter.check('9.9.9.9', rule, now)).allowed).toBe(true);
    }
    expect((await limiter.check('9.9.9.9', rule, now)).allowed).toBe(false);
    // a different IP is independent, still allowed
    expect((await limiter.check('9.9.9.8', rule, now)).allowed).toBe(true);
    // window reset lets it through again
    expect((await limiter.check('9.9.9.9', rule, now + rule.windowSec * 1000 + 1)).allowed).toBe(
      true,
    );
    expect(errored).toBeGreaterThan(0);
  });
});
