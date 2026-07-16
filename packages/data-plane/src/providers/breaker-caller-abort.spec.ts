// Caller-abort breaker neutrality: a CLIENT-gone teardown must never count
// against provider health, even when the adapters have already normalized the
// abort into a tripping-shaped ProviderError (the mid-body conversion) — while
// system-imposed timeouts (client still present) keep tripping.
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  withBreaker,
  withBreakerStream,
  type BreakerConfig,
} from './breaker';
import { CallCancelledError, ProviderCircuitOpenError, ProviderError } from './errors';
import type { NormalizedStreamEvent } from '../proxy/translate';

const cfg: BreakerConfig = {
  threshold: 1, // a single counted failure opens — the sharpest possible pin
  cooldownMs: 60_000,
  probeLeaseMs: 200,
  stateTtlMs: 60_000,
};

const convertedAbort = (): ProviderError =>
  new ProviderError('unavailable', 'provider request failed: terminated'); // the adapter's mid-body conversion

// eslint-disable-next-line @typescript-eslint/require-await -- AsyncGenerator by contract
async function* throwingStream(): AsyncGenerator<NormalizedStreamEvent> {
  yield { type: 'message_start', id: 'm', model: 'x', role: 'assistant' };
  throw convertedAbort();
}

async function admits(breaker: CircuitBreaker, pid: string): Promise<boolean> {
  try {
    await withBreaker(breaker, pid, () => Promise.resolve('ok'));
    return true;
  } catch (err) {
    if (err instanceof ProviderCircuitOpenError) return false;
    throw err;
  }
}

describe('withBreaker — caller-abort neutrality', () => {
  it('a converted caller-abort failure never counts (repeated past the threshold)', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    let opened = 0;
    for (let i = 0; i < 3; i += 1) {
      await expect(
        withBreaker(
          breaker,
          'p',
          () => Promise.reject(convertedAbort()),
          () => (opened += 1),
          undefined,
          () => true, // the client is gone
        ),
      ).rejects.toThrow('terminated');
    }
    expect(opened).toBe(0); // no justOpened → no provider_down
    expect(await admits(breaker, 'p')).toBe(true); // still closed
  });

  it('REGRESSION PIN: the same failure without the predicate still trips', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    let opened = 0;
    await expect(
      withBreaker(
        breaker,
        'p2',
        () => Promise.reject(convertedAbort()),
        () => (opened += 1),
      ),
    ).rejects.toThrow('terminated');
    expect(opened).toBe(1);
    expect(await admits(breaker, 'p2')).toBe(false); // open → skip
  });

  it('a system timeout (client still present) keeps tripping through the predicate', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    await expect(
      withBreaker(
        breaker,
        'p3',
        () => Promise.reject(new ProviderError('unavailable', 'upstream event timeout')),
        undefined,
        undefined,
        () => false, // the client did NOT abort — this was our deadline
      ),
    ).rejects.toThrow('timeout');
    expect(await admits(breaker, 'p3')).toBe(false); // tripped as before
  });
});

describe('withBreakerStream — caller-abort neutrality', () => {
  async function drain(gen: AsyncGenerator<NormalizedStreamEvent>): Promise<void> {
    for await (const ev of gen) void ev;
  }

  it('a mid-stream converted teardown with the client gone settles neutral', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    let opened = 0;
    await expect(
      drain(
        withBreakerStream(
          breaker,
          's1',
          throwingStream,
          () => (opened += 1),
          undefined,
          () => true,
        ),
      ),
    ).rejects.toThrow('terminated');
    expect(opened).toBe(0);
    expect(await admits(breaker, 's1')).toBe(true);
  });

  it('the same throw with the client present still trips', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    await expect(
      drain(withBreakerStream(breaker, 's2', throwingStream, undefined, undefined, () => false)),
    ).rejects.toThrow('terminated');
    expect(await admits(breaker, 's2')).toBe(false);
  });

  // E1.3: a system-imposed first/inter-event timeout surfaces as CallCancelledError
  // (core aborted the call while the client was still present). This is the exact
  // shape outcomeForError maps to 'neutral' — so it must be tripped explicitly.
  // eslint-disable-next-line @typescript-eslint/require-await -- AsyncGenerator by contract
  async function* cancelledStream(): AsyncGenerator<NormalizedStreamEvent> {
    yield { type: 'message_start', id: 'm', model: 'x', role: 'assistant' };
    throw new CallCancelledError();
  }

  it('a CallCancelledError with the client PRESENT (system timeout) trips', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    await expect(
      drain(withBreakerStream(breaker, 's3', cancelledStream, undefined, undefined, () => false)),
    ).rejects.toBeInstanceOf(CallCancelledError);
    expect(await admits(breaker, 's3')).toBe(false); // opened — NOT re-neutralized
  });

  it('a CallCancelledError with the client GONE stays neutral (8abd4b6 preserved)', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    let opened = 0;
    for (let i = 0; i < 3; i += 1) {
      await expect(
        drain(
          withBreakerStream(breaker, 's4', cancelledStream, () => (opened += 1), undefined, () => true),
        ),
      ).rejects.toBeInstanceOf(CallCancelledError);
    }
    expect(opened).toBe(0);
    expect(await admits(breaker, 's4')).toBe(true); // still closed
  });
});
