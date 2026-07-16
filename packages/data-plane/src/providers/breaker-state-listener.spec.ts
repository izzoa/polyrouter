// #21: the additive breaker-state observation seam — `onState` fires with the
// state observed at each admission decision (closed / open-skip / half_open
// probe), for all wrapper shapes, and can never affect the call path.
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  withBreaker,
  withBreakerStream,
  type BreakerConfig,
  type BreakerState,
} from './breaker';
import { ProviderCircuitOpenError } from './errors';
import type { NormalizedStreamEvent } from '../proxy/translate';

const cfg: BreakerConfig = {
  threshold: 1,
  cooldownMs: 1000,
  probeLeaseMs: 200,
  stateTtlMs: 10_000,
};

// eslint-disable-next-line @typescript-eslint/require-await -- AsyncGenerator by contract
async function* okStream(): AsyncGenerator<NormalizedStreamEvent> {
  yield { type: 'message_start', id: 'm', model: 'x', role: 'assistant' };
  yield { type: 'message_delta', stopReason: 'stop' };
}

describe('withBreaker/withBreakerStream — onState observation (#21)', () => {
  it('observes closed → open (skip) → half_open (probe) across the lifecycle', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg, now: () => now });
    const seen: BreakerState[] = [];
    const onState = (_p: string, s: BreakerState): void => {
      seen.push(s);
    };

    // 1: closed admission; the failing call trips the breaker (threshold 1).
    await expect(
      withBreaker(breaker, 'p', () => Promise.reject(new Error('boom')), undefined, onState),
    ).rejects.toThrow('boom');
    // 2: now open → admission skips.
    await expect(
      withBreaker(breaker, 'p', () => Promise.resolve('never'), undefined, onState),
    ).rejects.toThrow(ProviderCircuitOpenError);
    // 3: past the cooldown → the probe is admitted as half_open.
    now = 2000;
    await expect(
      withBreaker(breaker, 'p', () => Promise.resolve('ok'), undefined, onState),
    ).resolves.toBe('ok');

    expect(seen).toEqual(['closed', 'open', 'half_open']);
  });

  it('fires for the streaming wrapper too', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    const seen: Array<[string, BreakerState]> = [];
    const events: NormalizedStreamEvent[] = [];
    for await (const ev of withBreakerStream(breaker, 'p2', okStream, undefined, (p, s) =>
      seen.push([p, s]),
    )) {
      events.push(ev);
    }
    expect(events).toHaveLength(2);
    expect(seen).toEqual([['p2', 'closed']]);
  });

  it('a throwing listener never affects the call', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    await expect(
      withBreaker(
        breaker,
        'p3',
        () => Promise.resolve(42),
        undefined,
        () => {
          throw new Error('observer bug');
        },
      ),
    ).resolves.toBe(42);
  });
});
