/* eslint-disable @typescript-eslint/require-await -- fake async generators in tests */
// add-provider-health-signals (tasks 5.2/5.3): the per-attempt settle hook and the
// discriminated completion source. A hook is carried PER ATTEMPT — two members of
// one provider each observe their own settlement — and fires only for a
// completion settled on the shared PRIMARY store.
import { openStreamChain, runBufferedChain, type ChainAttempt } from '../proxy/core';
import {
  getAdapter,
  type NormalizedResponse,
  type NormalizedStreamEvent,
} from '../proxy/translate';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  withBreaker,
  type BreakerSettleInfo,
  type BreakerStore,
} from './breaker';
import { ProviderError } from './errors';
import type { ProviderAdapter } from './adapter';

const client = getAdapter('openai');
const REQUEST = { model: 'x', messages: [], params: {} };

const response = (): NormalizedResponse => ({
  id: 'r',
  model: 'm',
  content: [{ type: 'text', text: 'ok' }],
  stopReason: 'stop',
});

function adapter(
  chat: () => Promise<NormalizedResponse>,
  stream?: () => AsyncGenerator<NormalizedStreamEvent>,
): ProviderAdapter {
  return {
    protocol: 'openai_compatible',
    chat,
    chatStream:
      stream ??
      async function* () {
        /* unused */
      },
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
  } as unknown as ProviderAdapter;
}

function recorder(): { hook: (i: BreakerSettleInfo) => void; seen: BreakerSettleInfo[] } {
  const seen: BreakerSettleInfo[] = [];
  return { hook: (i) => seen.push(i), seen };
}

describe('per-attempt settle hook (add-provider-health-signals)', () => {
  it('two members of the SAME provider each get their own hook, exactly once, with their own outcome', async () => {
    const first = recorder();
    const second = recorder();
    const attempts: ChainAttempt[] = [
      {
        providerId: 'p1',
        externalModelId: 'a',
        buildAdapter: () =>
          Promise.resolve(adapter(() => Promise.reject(new ProviderError('auth', 'no')))),
        onSettle: first.hook,
      },
      {
        providerId: 'p1',
        externalModelId: 'b',
        buildAdapter: () => Promise.resolve(adapter(() => Promise.resolve(response()))),
        onSettle: second.hook,
      },
    ];
    const r = await runBufferedChain(
      new CircuitBreaker(new InMemoryBreakerStore()),
      attempts,
      client,
      REQUEST,
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(true);
    expect(first.seen).toEqual([
      expect.objectContaining({ outcome: 'trip', kind: 'auth', applied: true, justOpened: false }),
    ]);
    expect(second.seen).toEqual([
      expect.objectContaining({ outcome: 'success', kind: null, applied: true }),
    ]);
    expect(second.seen[0]!.seq).toBeGreaterThan(first.seen[0]!.seq);
  });

  it('the opening failure reports justOpened with its kind', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
      config: { threshold: 2, cooldownMs: 60_000, probeLeaseMs: 1_000, stateTtlMs: 300_000 },
    });
    const seen: BreakerSettleInfo[] = [];
    for (let i = 0; i < 2; i += 1) {
      await withBreaker(
        breaker,
        'p1',
        () => Promise.reject(new ProviderError('insufficient_funds', 'dry')),
        undefined,
        undefined,
        undefined,
        undefined,
        (info) => seen.push(info),
      ).catch(() => undefined);
    }
    expect(seen.map((s) => s.justOpened)).toEqual([false, true]);
    expect(seen[1]).toMatchObject({ outcome: 'trip', kind: 'insufficient_funds', applied: true });
  });

  it('a non-ProviderError failure reports kind unavailable', async () => {
    const seen: BreakerSettleInfo[] = [];
    await withBreaker(
      new CircuitBreaker(new InMemoryBreakerStore()),
      'p1',
      () => Promise.reject(new Error('socket hang up')),
      undefined,
      undefined,
      undefined,
      undefined,
      (info) => seen.push(info),
    ).catch(() => undefined);
    expect(seen).toEqual([expect.objectContaining({ outcome: 'trip', kind: 'unavailable' })]);
  });

  it('the fallback store and a primary-store fault emit nothing; a fault reports source fault', async () => {
    const failing: BreakerStore = {
      decide: () => Promise.reject(new Error('redis down')),
      complete: () => Promise.reject(new Error('redis down')),
      renew: () => Promise.resolve(),
      reset: () => Promise.resolve(),
    };
    // decide fails → the per-instance FALLBACK admits; its completion is not shared.
    const viaFallback = recorder();
    await withBreaker(
      new CircuitBreaker(failing, { onError: () => undefined }),
      'p1',
      () => Promise.resolve('ok'),
      undefined,
      undefined,
      undefined,
      undefined,
      viaFallback.hook,
    );
    expect(viaFallback.seen).toEqual([]);

    // decide succeeds on the primary but complete FAULTS → no hook, source 'fault'.
    const primaryThenFault: BreakerStore = {
      decide: () => Promise.resolve({ decision: 'allow', generation: 1, isProbe: false }),
      complete: () => Promise.reject(new Error('redis down mid-call')),
      renew: () => Promise.resolve(),
      reset: () => Promise.resolve(),
    };
    const breaker = new CircuitBreaker(primaryThenFault, { onError: () => undefined });
    const faulted = recorder();
    await withBreaker(
      breaker,
      'p1',
      () => Promise.resolve('ok'),
      undefined,
      undefined,
      undefined,
      undefined,
      faulted.hook,
    );
    expect(faulted.seen).toEqual([]);
    const { token } = await breaker.before('p1');
    expect(await breaker.complete(token, 'success')).toMatchObject({
      source: 'fault',
      applied: false,
    });
  });

  it('a throwing hook changes no routing outcome', async () => {
    const r = await runBufferedChain(
      new CircuitBreaker(new InMemoryBreakerStore()),
      [
        {
          providerId: 'p1',
          externalModelId: 'a',
          buildAdapter: () => Promise.resolve(adapter(() => Promise.resolve(response()))),
          onSettle: () => {
            throw new Error('observer bug');
          },
        },
      ],
      client,
      REQUEST,
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(true);
  });

  it('a circuit-open skip settles nothing', async () => {
    const store = new InMemoryBreakerStore();
    const breaker = new CircuitBreaker(store, {
      config: { threshold: 1, cooldownMs: 60_000, probeLeaseMs: 1_000, stateTtlMs: 300_000 },
    });
    await withBreaker(breaker, 'p1', () =>
      Promise.reject(new ProviderError('unavailable', 'x')),
    ).catch(() => undefined);
    const skipped = recorder();
    const r = await runBufferedChain(
      breaker,
      [
        {
          providerId: 'p1',
          externalModelId: 'a',
          buildAdapter: () => Promise.resolve(adapter(() => Promise.resolve(response()))),
          onSettle: skipped.hook,
        },
      ],
      client,
      REQUEST,
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(false);
    expect(skipped.seen).toEqual([]);
  });

  describe('streaming settlement', () => {
    const START: NormalizedStreamEvent = {
      type: 'message_start',
      id: 'm1',
      model: 'm',
      role: 'assistant',
    };
    const TEXT: NormalizedStreamEvent = { type: 'text_delta', index: 0, text: 'hi' };
    const STOP: NormalizedStreamEvent = { type: 'message_delta', stopReason: 'stop' };
    const END: NormalizedStreamEvent = { type: 'message_stop' };
    const OPTS = { firstEventTimeoutMs: 1000, created: 1 };

    async function drain(
      gen: () => AsyncGenerator<NormalizedStreamEvent>,
    ): Promise<BreakerSettleInfo[]> {
      const rec = recorder();
      const r = await openStreamChain(
        new CircuitBreaker(new InMemoryBreakerStore()),
        [
          {
            providerId: 'p1',
            externalModelId: 'a',
            buildAdapter: () =>
              Promise.resolve(adapter(() => Promise.reject(new Error('n/a')), gen)),
            onSettle: rec.hook,
          },
        ],
        client,
        REQUEST,
        OPTS,
      );
      if (r.kind === 'stream') {
        for await (const _f of r.frames) {
          /* drain */
        }
        await r.outcome;
      }
      return rec.seen;
    }

    it('a terminal stop settles success with no kind', async () => {
      const seen = await drain(async function* () {
        yield START;
        yield TEXT;
        yield STOP;
        yield END;
      });
      expect(seen).toEqual([
        expect.objectContaining({ outcome: 'success', kind: null, applied: true }),
      ]);
    });

    it('an in-band error event settles with its kind', async () => {
      const seen = await drain(async function* () {
        yield { type: 'error', error: { type: 'overloaded', message: 'busy' } };
      });
      expect(seen).toEqual([expect.objectContaining({ outcome: 'trip', kind: 'unavailable' })]);
    });

    it('a truncated stream (no terminal stop) settles as an untyped trip', async () => {
      const seen = await drain(async function* () {
        yield START;
        yield TEXT;
      });
      expect(seen).toEqual([expect.objectContaining({ outcome: 'trip', kind: 'unavailable' })]);
    });
  });

  it('a stale completion or renewal against a MISSING in-memory record creates nothing (Redis parity)', async () => {
    const store = new InMemoryBreakerStore();
    const cfg = { threshold: 5, cooldownMs: 30_000, probeLeaseMs: 1_000, stateTtlMs: 300_000 };
    expect(await store.complete('ghost', 7, 'trip', 1_000, cfg)).toMatchObject({ applied: false });
    await store.renew('ghost', 7, 1_000, cfg);
    // The next admission seeds from ITS OWN clock — no phantom record from t=1000.
    expect((await store.decide('ghost', 2_000, cfg)).generation).toBe(2_000);
  });
});
