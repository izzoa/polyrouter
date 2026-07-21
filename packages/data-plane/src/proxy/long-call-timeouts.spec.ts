// fix-long-call-timeouts: byte-liveness watchdog + dispatcher timeout
// derivation. Small REAL timers (tens of ms) — no fake-timer coupling.
import { dispatcherTimeoutOptions } from '@polyrouter/shared/server';
import { DISPATCHER_MARGIN_MS, dispatcherTimeouts } from '../providers/http-adapter';
import { ProviderError, type ProviderAdapter } from '../providers';
import { getAdapter } from './translate';
import { openStream } from './core';
import type { NormalizedRequest, NormalizedStreamEvent } from './translate';

const REQ: NormalizedRequest = { model: 'm', messages: [], params: {} };

/** A fake streaming provider whose event gaps and keepalive marks are scripted.
 * Abort-aware like the real adapters: a scripted sleep rejects on the call
 * signal so the watchdog's abort tears the stream down promptly. */
function providerOf(
  script: (
    onBytes: () => void,
    wait: (ms: number) => Promise<void>,
  ) => AsyncGenerator<NormalizedStreamEvent>,
): ProviderAdapter {
  return {
    protocol: 'openai_compatible',
    chat: () => Promise.reject(new Error('n/a')),
    chatStream: (_req: NormalizedRequest, ctx?: { signal?: AbortSignal; onBytes?: () => void }) => {
      const wait = (ms: number): Promise<void> =>
        new Promise((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          ctx?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      return script(ctx?.onBytes ?? (() => undefined), wait);
    },
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
  } as unknown as ProviderAdapter;
}

const first: NormalizedStreamEvent = { type: 'message_start', id: 'm', model: 'x', role: 'assistant' };
const stop: NormalizedStreamEvent = { type: 'message_delta', stopReason: 'stop' };

async function drain(frames: AsyncGenerator<string>): Promise<void> {
  for await (const f of frames) void f;
}

describe('byte liveness re-arms the stream watchdog (stream.ts:39 keepalive gap)', () => {
  it('a keepalive-fed silent gap far past the bound survives; the stream completes clean', async () => {
    const provider = providerOf(async function* (onBytes, wait) {
      yield first;
      // 5 × 60ms of "comment keepalives" (bytes, no events) against a 100ms
      // bound — 300ms total silence would have tripped the old fixed timer.
      for (let i = 0; i < 5; i += 1) {
        await wait(60);
        onBytes();
      }
      yield { type: 'text_delta', index: 0, text: 'answer' };
      yield stop;
    });
    const r = await openStream(provider, getAdapter('openai'), REQ, {
      firstEventTimeoutMs: 100,
      created: 1,
    });
    if (r.kind === 'error') throw new Error(`unexpected: ${r.error.message}`);
    await drain(r.frames);
    await expect(r.outcome).resolves.toMatchObject({ status: 'success' });
  });

  it('TRUE byte-silence still trips at the bound with the typed classification', async () => {
    const provider = providerOf(async function* (_onBytes, wait) {
      yield first;
      await wait(400); // no bytes, no events — must abort at ~100ms
      yield stop;
    });
    const r = await openStream(provider, getAdapter('openai'), REQ, {
      firstEventTimeoutMs: 100,
      created: 1,
    });
    if (r.kind === 'error') throw new Error('pre-commit unexpected');
    const started = Date.now();
    await drain(r.frames); // terminal error frame after the watchdog fires
    const outcome = await r.outcome;
    expect(outcome.status).toBe('error');
    expect(outcome.callerAborted).toBe(false);
    expect(outcome.error).toBeInstanceOf(ProviderError);
    expect(outcome.error?.kind).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(350); // fired near the bound, not the 400ms sleep
  });

  it('pre-first-event silence (no bytes) still times out pre-commit — fallback-eligible', async () => {
    const provider = providerOf(async function* (_onBytes, wait) {
      await wait(400);
      yield first;
    });
    const r = await openStream(provider, getAdapter('openai'), REQ, {
      firstEventTimeoutMs: 80,
      created: 1,
    });
    expect(r.kind).toBe('error'); // pre-commit → the chain may fall back
  });
});

describe('dispatcherTimeouts — derived above the widest typed bound', () => {
  it('headers clears first-byte; body clears max(idle, stream bound)', () => {
    const d = dispatcherTimeouts(30_000, 30_000, 30_500);
    expect(d.headersTimeoutMs).toBe(30_000 + DISPATCHER_MARGIN_MS);
    expect(d.bodyTimeoutMs).toBe(30_500 + DISPATCHER_MARGIN_MS);
  });

  it('firstByte ≫ idle: the STREAM bound wins the body derivation (undici can never beat it)', () => {
    // The clink r1-High-2 case: firstByte 30m, idle 30s — body must clear ~30m.
    const d = dispatcherTimeouts(1_800_000, 30_000, 1_800_500);
    expect(d.bodyTimeoutMs).toBe(1_800_500 + DISPATCHER_MARGIN_MS);
    expect(d.headersTimeoutMs).toBe(1_800_000 + DISPATCHER_MARGIN_MS);
  });

  it('an absent stream bound falls back to a safe ceiling (first-byte + max margin)', () => {
    const d = dispatcherTimeouts(30_000, 30_000);
    expect(d.bodyTimeoutMs).toBe(30_000 + 60_000 + DISPATCHER_MARGIN_MS);
  });

  it('dispatcherTimeoutOptions maps to undici Agent options; omission stays empty', () => {
    expect(dispatcherTimeoutOptions({ headersTimeoutMs: 35_000, bodyTimeoutMs: 95_000 })).toEqual({
      headersTimeout: 35_000,
      bodyTimeout: 95_000,
    });
    expect(dispatcherTimeoutOptions({})).toEqual({});
  });
});

import { CircuitBreaker, InMemoryBreakerStore, guardEventIdle } from '../providers';
import { openStreamChain, type ChainAttempt } from './core';

const attemptOf = (
  script: (
    onBytes: () => void,
    wait: (ms: number) => Promise<void>,
  ) => AsyncGenerator<NormalizedStreamEvent>,
  firstEventTimeoutMs?: number,
): ChainAttempt => ({
  providerId: `p-${Math.random().toString(36).slice(2, 8)}`,
  externalModelId: 'm',
  buildAdapter: () => Promise.resolve(providerOf(script)),
  ...(firstEventTimeoutMs !== undefined ? { firstEventTimeoutMs } : {}),
});

describe('per-attempt bounds in a MIXED chain (clink r1-High-1 pin)', () => {
  it('each member gets ITS OWN bound: the impatient primary falls back, the patient override serves', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore());
    // Member A inherits the chain-wide 100ms bound and stalls 300ms → pre-commit
    // timeout, fallback. Member B carries an 800ms override, needs 300ms → serves.
    const a = attemptOf(async function* (_b, wait) {
      await wait(300);
      yield first;
    });
    const b = attemptOf(async function* (_b, wait) {
      await wait(300);
      yield first;
      yield { type: 'text_delta', index: 0, text: 'served' };
      yield stop;
    }, 800);
    const r = await openStreamChain(breaker, [a, b], getAdapter('openai'), REQ, {
      firstEventTimeoutMs: 100,
      created: 1,
    });
    if (r.kind === 'error') throw new Error(`chain failed: ${r.error.message}`);
    expect(r.servedIndex).toBe(1);
    expect(r.failures).toHaveLength(1); // A timed out on ITS bound
    await drain(r.frames);
    await expect(r.outcome).resolves.toMatchObject({ status: 'success' });
  });

  it("a settled attempt's stale onBytes re-arms NOTHING for the committed member", async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore());
    let staleBytes: (() => void) | undefined;
    const a = attemptOf(async function* (onBytes, wait) {
      staleBytes = onBytes; // captured; A then times out and settles
      await wait(300);
      yield first;
    });
    const b = attemptOf(async function* (_b, wait) {
      yield first; // commits immediately on ITS 150ms bound
      // Then true silence — while A's STALE callback fires repeatedly. If stale
      // marks re-armed B's watchdog, this would survive; it must trip.
      const pump = setInterval(() => staleBytes?.(), 40);
      try {
        await wait(600);
      } finally {
        clearInterval(pump);
      }
      yield stop;
    }, 150);
    const r = await openStreamChain(breaker, [a, b], getAdapter('openai'), REQ, {
      firstEventTimeoutMs: 100,
      created: 1,
    });
    if (r.kind === 'error') throw new Error('expected a committed stream');
    await drain(r.frames);
    const outcome = await r.outcome;
    expect(outcome.status).toBe('error'); // stale liveness never crossed attempts
    expect(outcome.error?.kind).toBe('unavailable');
  });
});

describe('guardEventIdle — the Responses buffered facade watchdog (impl-Med-1)', () => {
  const openOf =
    (script: (ctx: { onBytes?: () => void; signal?: AbortSignal }) => AsyncGenerator<NormalizedStreamEvent>) =>
    (ctx: { onBytes?: () => void; signal?: AbortSignal }) =>
      script(ctx);

  it('keepalive bytes re-arm the idle bound; the fold completes', async () => {
    const events: NormalizedStreamEvent[] = [];
    const gen = guardEventIdle(
      openOf(async function* (ctx) {
        yield first;
        for (let i = 0; i < 5; i += 1) {
          await new Promise((r) => setTimeout(r, 60));
          ctx.onBytes?.();
        }
        yield { type: 'text_delta', index: 0, text: 'ok' };
        yield stop;
      }),
      100,
    );
    for await (const ev of gen) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(['message_start', 'text_delta', 'message_delta']);
  });

  it('true byte-silence trips at the bound with the typed unavailable', async () => {
    const gen = guardEventIdle(
      openOf(async function* (ctx) {
        yield first;
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 600);
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
        yield stop;
      }),
      100,
    );
    const started = Date.now();
    await expect(async () => {
      for await (const ev of gen) void ev;
    }).rejects.toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(450);
  });
});
