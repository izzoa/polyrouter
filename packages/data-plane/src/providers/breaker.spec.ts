import {
  CircuitBreaker,
  InMemoryBreakerStore,
  withBreaker,
  withBreakerStream,
  type BreakerConfig,
  type BreakerStore,
} from './breaker';
import { ProviderCircuitOpenError, ProviderError, CallCancelledError } from './errors';
import type { NormalizedStreamEvent } from '../proxy/translate';

const cfg: BreakerConfig = {
  threshold: 3,
  cooldownMs: 1000,
  probeLeaseMs: 200,
  stateTtlMs: 10_000,
};
const PID = 'prov-1';

function clockedBreaker(store: BreakerStore, clock: { t: number }, onError?: (e: unknown) => void) {
  return new CircuitBreaker(store, {
    config: cfg,
    now: () => clock.t,
    ...(onError !== undefined ? { onError } : {}),
  });
}

const unavailable = (): Promise<never> => Promise.reject(new ProviderError('unavailable', 'boom'));

async function tripN(breaker: CircuitBreaker, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await withBreaker(breaker, PID, unavailable).catch(() => undefined);
  }
}

describe('CircuitBreaker — shared store across two instances (one simulated Redis)', () => {
  it('opens on one instance and is skipped by the other; half-open probe closes both', async () => {
    const store = new InMemoryBreakerStore();
    const clock = { t: 0 };
    const a = clockedBreaker(store, clock);
    const b = clockedBreaker(store, clock);

    await tripN(a, cfg.threshold); // a opens the shared breaker

    // b sees it open and skips WITHOUT invoking the provider
    let invoked = false;
    await expect(
      withBreaker(b, PID, () => {
        invoked = true;
        return Promise.resolve('ok');
      }),
    ).rejects.toBeInstanceOf(ProviderCircuitOpenError);
    expect(invoked).toBe(false);

    // after cooldown, exactly one probe is admitted; its success closes both
    clock.t = 1000;
    const result = await withBreaker(b, PID, () => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    // now closed for a too
    expect(await withBreaker(a, PID, () => Promise.resolve('ok'))).toBe('ok');
  });

  it('admits exactly one concurrent half-open probe', async () => {
    const store = new InMemoryBreakerStore();
    const clock = { t: 0 };
    const a = clockedBreaker(store, clock);
    await tripN(a, cfg.threshold);
    clock.t = 1000;
    const admissions = await Promise.all([a.before(PID), a.before(PID), a.before(PID)]);
    const allowed = admissions.filter((x) => x.decision === 'allow');
    expect(allowed).toHaveLength(1);
    expect(allowed[0]?.token.isProbe).toBe(true);
  });
});

describe('CircuitBreaker — degrade when the shared store errors', () => {
  const failingStore: BreakerStore = {
    decide: () => Promise.reject(new Error('redis down')),
    complete: () => Promise.reject(new Error('redis down')),
    renew: () => Promise.reject(new Error('redis down')),
    reset: () => Promise.reject(new Error('redis down')),
  };

  it('falls back to a per-instance decision and never fails open', async () => {
    const errors: unknown[] = [];
    const breaker = clockedBreaker(failingStore, { t: 0 }, (e) => errors.push(e));
    // still enforces locally: trip the fallback to open, then it skips
    await tripN(breaker, cfg.threshold);
    await expect(withBreaker(breaker, PID, () => Promise.resolve('ok'))).rejects.toBeInstanceOf(
      ProviderCircuitOpenError,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('withBreaker — health follows whether the provider responded', () => {
  it('trips on tripping errors but not on bad_request', async () => {
    const store = new InMemoryBreakerStore();
    const breaker = clockedBreaker(store, { t: 0 });
    // bad_request many times → never opens (client fault, provider healthy)
    for (let i = 0; i < 10; i++) {
      await withBreaker(breaker, PID, () =>
        Promise.reject(new ProviderError('bad_request', 'nope')),
      ).catch(() => undefined);
    }
    expect((await breaker.before(PID)).decision).toBe('allow');
  });

  it('a caller cancellation is neutral', async () => {
    const store = new InMemoryBreakerStore();
    const breaker = clockedBreaker(store, { t: 0 });
    for (let i = 0; i < 10; i++) {
      await withBreaker(breaker, PID, () => Promise.reject(new CallCancelledError())).catch(
        () => undefined,
      );
    }
    expect((await breaker.before(PID)).decision).toBe('allow');
  });

  it('a bad_request during a half-open probe still closes the breaker', async () => {
    const store = new InMemoryBreakerStore();
    const clock = { t: 0 };
    const breaker = clockedBreaker(store, clock);
    await tripN(breaker, cfg.threshold); // open
    clock.t = 1000;
    // the probe hits a client fault — the provider responded, so it closes
    await withBreaker(breaker, PID, () =>
      Promise.reject(new ProviderError('bad_request', 'nope')),
    ).catch(() => undefined);
    expect((await breaker.before(PID)).decision).toBe('allow');
    // and it is closed, not a fresh probe
    expect((await breaker.before(PID)).token.isProbe).toBe(false);
  });
});

// eslint-disable-next-line @typescript-eslint/require-await -- sync events presented as an async generator
async function* fromEvents(
  events: readonly NormalizedStreamEvent[],
): AsyncGenerator<NormalizedStreamEvent> {
  for (const e of events) yield e;
}
async function drain(it: AsyncGenerator<NormalizedStreamEvent>): Promise<void> {
  for await (const _ of it) void _;
}

const TERMINATED: NormalizedStreamEvent[] = [
  { type: 'message_start', id: 'm', model: 'x', role: 'assistant' },
  { type: 'text_delta', index: 0, text: 'hi' },
  { type: 'message_delta', stopReason: 'stop' },
  { type: 'message_stop' },
];
const TRUNCATED: NormalizedStreamEvent[] = [
  { type: 'message_start', id: 'm', model: 'x', role: 'assistant' },
  { type: 'text_delta', index: 0, text: 'hi' },
  { type: 'message_stop' }, // #5 synthesizes this at EOF — no terminal stop reason
];

describe('withBreakerStream — truncation and stream-error classification', () => {
  it('a terminated stream is success; a truncated stream trips', async () => {
    const store = new InMemoryBreakerStore();
    const breaker = clockedBreaker(store, { t: 0 });
    // terminated streams never open the breaker
    for (let i = 0; i < 5; i++) {
      await drain(withBreakerStream(breaker, PID, () => fromEvents(TERMINATED)));
    }
    expect((await breaker.before(PID)).decision).toBe('allow');
    // truncated streams trip after threshold
    for (let i = 0; i < cfg.threshold; i++) {
      await drain(withBreakerStream(breaker, PID, () => fromEvents(TRUNCATED)));
    }
    expect((await breaker.before(PID)).decision).toBe('skip');
  });

  it('a streamed model error does not trip; an overloaded error does', async () => {
    const store = new InMemoryBreakerStore();
    const breaker = clockedBreaker(store, { t: 0 });
    const modelErr: NormalizedStreamEvent[] = [
      { type: 'message_start', id: 'm', model: 'x', role: 'assistant' },
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
    ];
    for (let i = 0; i < 10; i++) {
      await drain(withBreakerStream(breaker, PID, () => fromEvents(modelErr)));
    }
    expect((await breaker.before(PID)).decision).toBe('allow');

    const overloaded: NormalizedStreamEvent[] = [
      { type: 'message_start', id: 'm', model: 'x', role: 'assistant' },
      { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
    ];
    for (let i = 0; i < cfg.threshold; i++) {
      await drain(withBreakerStream(breaker, PID, () => fromEvents(overloaded)));
    }
    expect((await breaker.before(PID)).decision).toBe('skip');
  });

  it('consumer cancellation is neutral (does not trip)', async () => {
    const store = new InMemoryBreakerStore();
    const breaker = clockedBreaker(store, { t: 0 });
    for (let i = 0; i < 10; i++) {
      const it = withBreakerStream(breaker, PID, () => fromEvents(TERMINATED));
      await it.next(); // consume one event
      await it.return(undefined); // cancel early
    }
    expect((await breaker.before(PID)).decision).toBe('allow');
  });

  it('an overload error trips even when the consumer abandons right after it (#12 commit gate)', async () => {
    const store = new InMemoryBreakerStore();
    const breaker = clockedBreaker(store, { t: 0 });
    const overloaded: NormalizedStreamEvent[] = [
      { type: 'message_start', id: 'm', model: 'x', role: 'assistant' },
      { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
    ];
    for (let i = 0; i < cfg.threshold; i++) {
      const it = withBreakerStream(breaker, PID, () => fromEvents(overloaded));
      await it.next(); // message_start
      await it.next(); // error event — the outcome must settle BEFORE we abandon
      await it.return(undefined); // abandon (as the commit gate does on an error event)
    }
    expect((await breaker.before(PID)).decision).toBe('skip'); // tripped, not neutral
  });
});
