import {
  CircuitBreaker,
  InMemoryBreakerStore,
  withBreaker,
  withBreakerStream,
  type BreakerConfig,
  type BreakerStore,
} from './breaker';
import type { NormalizedStreamEvent } from './translate';

const cfg: BreakerConfig = {
  threshold: 3,
  cooldownMs: 1000,
  probeLeaseMs: 200,
  stateTtlMs: 10_000,
};

describe('BreakerStore.complete — justOpened (#15b)', () => {
  it('reports justOpened exactly on the closed→open transition', async () => {
    const store = new InMemoryBreakerStore();
    const gen = (await store.decide('p', 0, cfg)).generation;
    expect((await store.complete('p', gen, 'trip', 0, cfg)).justOpened).toBe(false); // 1
    expect((await store.complete('p', gen, 'trip', 0, cfg)).justOpened).toBe(false); // 2
    const opened = await store.complete('p', gen, 'trip', 0, cfg); // 3 → open
    expect(opened.justOpened).toBe(true);
    // already open → a further trip is not a fresh open
    expect((await store.complete('p', gen, 'trip', 0, cfg)).justOpened).toBe(false);
  });

  it('reports justOpened on a failed half-open probe, never on success/neutral', async () => {
    const store = new InMemoryBreakerStore();
    let a = await store.decide('p', 0, cfg);
    await store.complete('p', a.generation, 'trip', 0, cfg);
    await store.complete('p', a.generation, 'trip', 0, cfg);
    await store.complete('p', a.generation, 'trip', 0, cfg); // open
    a = await store.decide('p', 2000, cfg); // half-open probe admitted
    expect((await store.complete('p', a.generation, 'neutral', 2000, cfg)).justOpened).toBe(false);
    const reopened = await store.complete('p', a.generation, 'trip', 2000, cfg);
    expect(reopened.justOpened).toBe(true); // half_open → open
  });
});

describe('CircuitBreaker.complete — primary-store only (#15b)', () => {
  it('suppresses justOpened when admission fell back to the in-memory store', async () => {
    // A primary store whose decide throws → before() uses the fallback.
    const brokenPrimary: BreakerStore = {
      decide: () => Promise.reject(new Error('redis down')),
      complete: () => Promise.reject(new Error('redis down')),
    };
    const breaker = new CircuitBreaker(brokenPrimary, {
      config: { ...cfg, threshold: 1 },
      fallback: new InMemoryBreakerStore(),
    });
    let opened = 0;
    await expect(
      withBreaker(
        breaker,
        'p',
        () => Promise.reject(new Error('boom')),
        () => (opened += 1),
      ),
    ).rejects.toThrow('boom');
    expect(opened).toBe(0); // fallback open must not alert
  });
});

describe('withBreaker / withBreakerStream — onOpen (#15b)', () => {
  const breaker = () =>
    new CircuitBreaker(new InMemoryBreakerStore(), { config: { ...cfg, threshold: 1 } });

  it('fires onOpen once when the call opens the breaker, not on success', async () => {
    const b = breaker();
    const opened: string[] = [];
    await withBreaker(
      b,
      'p',
      () => Promise.resolve('ok'),
      (id) => opened.push(id),
    );
    expect(opened).toEqual([]); // success does not open
    await expect(
      withBreaker(
        b,
        'p',
        () => Promise.reject(new Error('boom')),
        (id) => opened.push(id),
      ),
    ).rejects.toThrow('boom');
    expect(opened).toEqual(['p']); // first trip (threshold 1) opens → one alert
  });

  it('a throwing onOpen never surfaces to the caller', async () => {
    const b = breaker();
    await expect(
      withBreaker(
        b,
        'p',
        () => Promise.reject(new Error('boom')),
        () => {
          throw new Error('listener blew up');
        },
      ),
    ).rejects.toThrow('boom'); // the original error, not the listener's
  });

  it('withBreakerStream fires onOpen on a truncated (tripping) stream', async () => {
    const b = breaker();
    const opened: string[] = [];
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* truncated(): AsyncGenerator<NormalizedStreamEvent> {
      // no terminal stop reason → truncation → trip → open (threshold 1)
      yield { type: 'message_start' } as NormalizedStreamEvent;
    }
    const it = withBreakerStream(b, 'p', truncated, (id) => opened.push(id));
    for await (const _ of it) {
      /* drain */
    }
    expect(opened).toEqual(['p']);
  });
});
