// Probe patience (add-fallback-attempt-detail O1-C): widened probe bounds, the
// GRANTED lease lifecycle (admission grant → renewal-by-granted → strict TTL),
// admission info on both breaker wrappers, the mutable stream-watchdog bound,
// and buffered byte-liveness. Breaker tests drive a fake clock; stream tests
// use small REAL timers (the long-call-timeouts house pattern).
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  DEFAULT_BREAKER_CONFIG,
  withBreaker,
  type BreakerRedis,
  type BreakerStore,
  RedisBreakerStore,
} from './breaker';
import {
  PROBE_BOUND_CEILING_MS,
  PROBE_RECORD_TTL_HEADROOM_MS,
  PROBE_SETTLE_HEADROOM_MS,
  probePatienceOf,
} from './probe-patience';
import { ProviderError, type ProviderAdapter } from './index';
import { openRequest, type HttpClient, type HttpResponse } from './http';
import { openAttemptStream, runBufferedChain, type ChainAttempt } from '../proxy/core';
import { getAdapter } from '../proxy/translate';
import type {
  NormalizedRequest,
  NormalizedResponse,
  NormalizedStreamEvent,
} from '../proxy/translate';

const REQ: NormalizedRequest = { model: 'm', messages: [], params: {} };

describe('probePatienceOf — the widened-bound arithmetic', () => {
  it('doubles first-byte and derives the event bound above it (layer ordering)', () => {
    const p = probePatienceOf({ firstByteTimeoutMs: 30_000, idleTimeoutMs: 30_000, eventMarginMs: 500 });
    expect(p.firstByteTimeoutMs).toBe(60_000);
    expect(p.firstEventTimeoutMs).toBe(60_500); // widened first-byte + margin
    expect(p.idleTimeoutMs).toBe(60_000);
    expect(p.leaseMs).toBe(60_500 + PROBE_SETTLE_HEADROOM_MS); // widest + headroom
  });

  it('caps each widened bound at the 1 h ceiling — a near-ceiling override stays put', () => {
    const p = probePatienceOf({
      firstByteTimeoutMs: 3_000_000,
      idleTimeoutMs: 3_000_000,
      eventMarginMs: 500,
    });
    expect(p.firstByteTimeoutMs).toBe(PROBE_BOUND_CEILING_MS);
    expect(p.idleTimeoutMs).toBe(PROBE_BOUND_CEILING_MS);
    expect(p.firstEventTimeoutMs).toBe(PROBE_BOUND_CEILING_MS + 500); // margin still above
  });

  it('doubles an independently-resolved idle override independently, and the WIDEST bound sets the lease', () => {
    const p = probePatienceOf({ firstByteTimeoutMs: 30_000, idleTimeoutMs: 600_000, eventMarginMs: 500 });
    expect(p.idleTimeoutMs).toBe(1_200_000);
    expect(p.firstEventTimeoutMs).toBe(60_500);
    expect(p.leaseMs).toBe(1_200_000 + PROBE_SETTLE_HEADROOM_MS);
  });
});

/** A breaker on a controllable clock over one in-memory store. */
function clockBreaker(store: BreakerStore = new InMemoryBreakerStore()): {
  breaker: CircuitBreaker;
  tickTo: (ms: number) => void;
} {
  let now = 0;
  return {
    breaker: new CircuitBreaker(store, { now: () => now }),
    tickTo: (ms) => {
      now = ms;
    },
  };
}

async function tripOpen(breaker: CircuitBreaker, id: string): Promise<void> {
  for (let i = 0; i < DEFAULT_BREAKER_CONFIG.threshold; i += 1) {
    const { token } = await breaker.before(id);
    await breaker.complete(token, 'trip');
  }
}

describe('the GRANTED probe lease (admission grant, renewal-by-granted, reclaim semantics)', () => {
  it('a widened probe is not reclaimed past the DEFAULT lease; reclaim after the granted lease is a generation-bumping probe admission', async () => {
    const { breaker, tickTo } = clockBreaker();
    await tripOpen(breaker, 'p'); // opens at t=0
    tickTo(30_000); // cooldown elapsed
    const probe = await breaker.before('p', 65_000);
    expect(probe.decision).toBe('allow');
    expect(probe.token.isProbe).toBe(true);
    expect(probe.token.leaseMs).toBe(65_000);

    // Silent past the DEFAULT 10 s lease: concurrent admissions still skip.
    tickTo(42_000);
    expect((await breaker.before('p')).decision).toBe('skip');
    tickTo(94_000); // still within the granted lease (expires at 95 000)
    expect((await breaker.before('p')).decision).toBe('skip');

    // Past the granted lease: the FIRST admission is a generation-bumping probe
    // RECLAIM — never a plain closed-state admission against a vanished record.
    tickTo(96_000);
    const reclaimed = await breaker.before('p');
    expect(reclaimed.decision).toBe('allow');
    expect(reclaimed.token.isProbe).toBe(true);
    expect(reclaimed.token.generation).toBeGreaterThan(probe.token.generation);
  });

  it('renewals extend by the GRANTED duration, never the default', async () => {
    const { breaker, tickTo } = clockBreaker();
    await tripOpen(breaker, 'p');
    tickTo(30_000);
    const probe = await breaker.before('p', 65_000); // lease expires at 95 000
    tickTo(60_000);
    await breaker.renewProbe(probe.token); // → expires at 60 000 + 65 000 = 125 000
    // A default-lease renewal (60 000 + 10 000) would already have been reclaimed here:
    tickTo(120_000);
    expect((await breaker.before('p')).decision).toBe('skip');
    tickTo(126_000);
    expect((await breaker.before('p')).token.isProbe).toBe(true); // reclaimed after the granted extension
  });

  it('an ordinary admission keeps the config lease, and a hung widened probe still trips and re-opens', async () => {
    const { breaker, tickTo } = clockBreaker();
    expect((await breaker.before('p')).token.leaseMs).toBe(DEFAULT_BREAKER_CONFIG.probeLeaseMs);
    await tripOpen(breaker, 'p');
    tickTo(30_000);
    const probe = await breaker.before('p', 65_000);
    // The probe's own typed timeout fires (hung provider): it trips → re-open.
    await breaker.complete(probe.token, 'trip');
    tickTo(31_000);
    expect((await breaker.before('p')).decision).toBe('skip'); // re-opened, cooldown running
  });
});

describe('per-call lease + strict TTL reach the Redis store as ARGVs (no script change)', () => {
  function fakeRedis(): { redis: BreakerRedis; calls: (string | number)[][] } {
    const calls: (string | number)[][] = [];
    return {
      calls,
      redis: {
        eval: (script: string, _n: number, ...args: (string | number)[]) => {
          calls.push(args);
          // DECIDE returns [decision, generation, isProbe]; RENEW returns 1.
          return Promise.resolve(script.includes('local decision') ? ['allow', 1, 1] : 1);
        },
      },
    };
  }

  it('a near-ceiling granted lease raises the record TTL to lease + headroom (record outlives lease)', async () => {
    const { redis, calls } = fakeRedis();
    const breaker = new CircuitBreaker(new RedisBreakerStore(redis));
    const granted = 3_600_500 + PROBE_SETTLE_HEADROOM_MS;
    const { token } = await breaker.before('p', granted);
    // eval args: [key, cooldownMs, probeLeaseMs, stateTtlMs]
    expect(calls[0]![2]).toBe(granted);
    expect(calls[0]![3]).toBe(granted + PROBE_RECORD_TTL_HEADROOM_MS);
    await breaker.renewProbe(token);
    // eval args: [key, tokenGeneration, probeLeaseMs, stateTtlMs]
    expect(calls[1]![2]).toBe(granted);
    expect(calls[1]![3]).toBe(granted + PROBE_RECORD_TTL_HEADROOM_MS);
  });

  it('an un-widened admission passes the config lease and TTL untouched', async () => {
    const { redis, calls } = fakeRedis();
    const breaker = new CircuitBreaker(new RedisBreakerStore(redis));
    await breaker.before('p');
    expect(calls[0]![2]).toBe(DEFAULT_BREAKER_CONFIG.probeLeaseMs);
    expect(calls[0]![3]).toBe(DEFAULT_BREAKER_CONFIG.stateTtlMs);
  });
});

describe('withBreaker hands its callback the admission (unary probe renewal)', () => {
  function spyStore(): { store: BreakerStore; renews: { leaseMs: number }[] } {
    const inner = new InMemoryBreakerStore();
    const renews: { leaseMs: number }[] = [];
    return {
      renews,
      store: {
        decide: (id, now, cfg) => inner.decide(id, now, cfg),
        complete: (id, gen, outcome, now, cfg) => inner.complete(id, gen, outcome, now, cfg),
        renew: (id, gen, now, cfg) => {
          renews.push({ leaseMs: cfg.probeLeaseMs });
          return inner.renew(id, gen, now, cfg);
        },
        reset: (id) => inner.reset(id),
      },
    };
  }

  it('a probe admission exposes isProbe + a throttled, granted-lease renewal; success closes', async () => {
    const { store, renews } = spyStore();
    let now = 0;
    const breaker = new CircuitBreaker(store, { now: () => now });
    await tripOpen(breaker, 'p');
    now = 30_000;
    let seen: { isProbe: boolean } | undefined;
    await withBreaker(
      breaker,
      'p',
      (admission) => {
        seen = { isProbe: admission.isProbe };
        admission.renewOnActivity(); // within the throttle window → no store op
        now = 55_000; // past leaseMs/3 (~21.7 s)
        admission.renewOnActivity(); // → renews by the GRANTED lease
        return Promise.resolve('ok');
      },
      undefined,
      undefined,
      undefined,
      65_000,
    );
    expect(seen).toEqual({ isProbe: true });
    expect(renews).toEqual([{ leaseMs: 65_000 }]);
    expect((await breaker.before('p')).token.isProbe).toBe(false); // probe success closed it
  });

  it('a closed-state admission reports isProbe false and its renewal is a no-op', async () => {
    const { store, renews } = spyStore();
    const breaker = new CircuitBreaker(store);
    await withBreaker(breaker, 'p', (admission) => {
      expect(admission.isProbe).toBe(false);
      admission.renewOnActivity();
      return Promise.resolve('ok');
    });
    expect(renews).toEqual([]);
  });
});

describe('the walkers plumb probe patience end to end', () => {
  const client = getAdapter('openai');
  const resp = (): NormalizedResponse => ({
    id: 'r',
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'stop',
  });

  it('runBufferedChain: buildAdapter receives the admission; the call gets the renewal as onBytes; probe success closes', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { now: () => now });
    await tripOpen(breaker, 'p1');
    now = 30_000;
    let adapterAdmission: { isProbe: boolean } | undefined;
    let chatCtx: { onBytes?: () => void } | undefined;
    const attempt: ChainAttempt = {
      providerId: 'p1',
      externalModelId: 'a',
      probeLeaseMs: 65_000,
      buildAdapter: (admission) => {
        adapterAdmission = admission !== undefined ? { isProbe: admission.isProbe } : undefined;
        return Promise.resolve({
          protocol: 'openai_compatible',
          chat: (_r: NormalizedRequest, ctx?: { onBytes?: () => void }) => {
            chatCtx = ctx;
            return Promise.resolve(resp());
          },
          chatStream: async function* () {
            /* unused */
          },
          listModels: () => Promise.resolve([]),
          testConnection: () => Promise.resolve({ ok: true, models: 0 }),
        } as unknown as ProviderAdapter);
      },
    };
    const r = await runBufferedChain(
      breaker,
      [attempt],
      client,
      REQ,
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(true);
    expect(adapterAdmission).toEqual({ isProbe: true });
    expect(typeof chatCtx?.onBytes).toBe('function');
    expect((await breaker.before('p1')).token.isProbe).toBe(false); // closed by the probe's success
  });

  it('openAttemptStream: a bound widened after arming re-arms the fired watchdog for the remainder', async () => {
    const first: NormalizedStreamEvent = {
      type: 'message_start',
      id: 'm',
      model: 'x',
      role: 'assistant',
    };
    const factory = (signal: AbortSignal) =>
      (async function* (): AsyncGenerator<NormalizedStreamEvent> {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 120);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
        yield first;
        yield { type: 'message_delta', stopReason: 'stop' };
      })();

    // Control: at the base 60 ms bound, the 120 ms first event times out typed.
    const control = await openAttemptStream((signal) => factory(signal), client, {
      firstEventTimeoutMs: 60,
      created: 1,
    });
    expect(control.kind).toBe('error');
    if (control.kind === 'error') {
      expect((control.error as ProviderError).message).toBe('upstream event timeout');
    }

    // Widened: the SAME base bound grows to 250 ms shortly after arming (as a
    // probe admission would) — the fired timer re-arms and the stream commits.
    const bound = { ms: 60 };
    setTimeout(() => {
      bound.ms = 250;
    }, 10);
    const widened = await openAttemptStream((signal) => factory(signal), client, {
      firstEventTimeoutMs: 60,
      firstEventBound: bound,
      created: 1,
    });
    expect(widened.kind).toBe('stream');
    if (widened.kind === 'stream') await widened.frames.return(undefined);
  });
});

describe('buffered byte-liveness feeds the onBytes hook through the idle guard', () => {
  it('each body chunk of a buffered read invokes CallContext.onBytes (standard HTTP path)', async () => {
    const chunks = ['{"ok"', ':true', '}'].map((s) => new TextEncoder().encode(s));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
    const res: HttpResponse = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body,
      text: () => Promise.reject(new Error('unused')),
      json: () => Promise.reject(new Error('unused')),
    };
    const httpClient: HttpClient = () => Promise.resolve(res);
    const onBytes = jest.fn();
    const opened = await openRequest(
      httpClient,
      'https://example.test/v1/chat',
      { method: 'POST', headers: {} },
      1_000,
      { onBytes },
      1_000,
    );
    const text = await opened.res.text();
    opened.dispose();
    expect(text).toBe('{"ok":true}');
    expect(onBytes.mock.calls.length).toBeGreaterThanOrEqual(chunks.length);
  });
});
