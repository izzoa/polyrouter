/* eslint-disable @typescript-eslint/require-await, require-yield -- fake async generators in tests */
import {
  openStream,
  runBuffered,
  runBufferedChain,
  openStreamChain,
  fallbackEligible,
  type ChainAttempt,
} from './core';
import {
  getAdapter,
  type NormalizedStreamEvent,
  type NormalizedResponse,
  type SanitizedMessage,
} from './translate';
import {
  CallCancelledError,
  CircuitBreaker,
  InMemoryBreakerStore,
  ProviderCircuitOpenError,
  ProviderError,
  createOpenaiProviderAdapter,
  type HttpClient,
  type ProviderAdapter,
} from '../providers';

const OPTS = { firstEventTimeoutMs: 1000, created: 1_700_000_000 };

function providerFrom(
  gen: () => AsyncGenerator<NormalizedStreamEvent>,
  chat?: () => Promise<NormalizedResponse>,
): ProviderAdapter {
  return {
    protocol: 'openai_compatible',
    chat: chat ?? (() => Promise.reject(new Error('unused'))),
    chatStream: gen,
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
  } as unknown as ProviderAdapter;
}

async function collect(frames: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const f of frames) out += f;
  return out;
}

const START: NormalizedStreamEvent = {
  type: 'message_start',
  id: 'm1',
  model: 'gpt-4o',
  role: 'assistant',
};
const TEXT: NormalizedStreamEvent = { type: 'text_delta', index: 0, text: 'hi' };
const STOP: NormalizedStreamEvent = { type: 'message_delta', stopReason: 'stop' };
const END: NormalizedStreamEvent = { type: 'message_stop' };

describe('openStream — commit boundary', () => {
  const client = getAdapter('openai');

  it('commits and streams a clean completion (terminator, no error frame)', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield STOP;
      yield END;
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('stream');
    if (res.kind !== 'stream') throw new Error('unreachable');
    const out = await collect(res.frames);
    expect(out).toContain('"content":"hi"');
    expect(out).toContain('data: [DONE]');
    expect(out).not.toContain('"upstream_error"');
  });

  it('stays pre-commit when the first event is an error event', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'error', error: { type: 'overloaded', message: 'raw upstream detail' } };
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('error');
  });

  it('stays pre-commit when the upstream throws before the first event', async () => {
    const provider = providerFrom(async function* (): AsyncGenerator<NormalizedStreamEvent> {
      throw new ProviderError('rate_limit', 'boom');
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.kind).toBe('rate_limit');
  });

  it('stays pre-commit on an empty stream', async () => {
    const provider = providerFrom(async function* () {
      // yields nothing
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('error');
  });

  it('classifies a first-event error to its typed kind (not a blanket 503)', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.kind).toBe('rate_limit');
  });

  it('times out (and cancels the upstream) when no first event arrives', async () => {
    let cancelled = false;
    const stall = {
      protocol: 'openai_compatible',
      chat: () => Promise.reject(new Error('unused')),
      chatStream: async function* (_req: unknown, ctx?: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (ctx?.signal?.aborted) return resolve();
          ctx?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelled = true; // reached only because the timeout aborted us
      },
      listModels: () => Promise.resolve([]),
      testConnection: () => Promise.resolve({ ok: true, models: 0 }),
    } as unknown as ProviderAdapter;
    const res = await openStream(
      stall,
      client,
      { model: 'x', messages: [], params: {} },
      { firstEventTimeoutMs: 40, created: 1 },
    );
    expect(res.kind).toBe('error');
    expect(cancelled).toBe(true); // the upstream was aborted, not left hanging
  });

  it('emits a sanitized terminal error frame on a mid-stream failure (no swap, no raw detail)', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield { type: 'error', error: { type: 'overloaded', message: 'SECRET raw upstream detail' } };
    });
    const res = await openStream(provider, client, { model: 'x', messages: [], params: {} }, OPTS);
    expect(res.kind).toBe('stream');
    if (res.kind !== 'stream') throw new Error('unreachable');
    const out = await collect(res.frames);
    expect(out).toContain('"content":"hi"'); // content before the failure was delivered
    expect(out).toContain('"upstream_error"'); // terminal error frame
    expect(out).toContain('data: [DONE]');
    expect(out).not.toContain('SECRET'); // raw upstream text never leaks
  });
});

describe('openStream — outcome (usage capture for #11)', () => {
  const client = getAdapter('openai');
  const REQ = { model: 'x', messages: [], params: {} };

  it('captures merged usage + output chars on a clean completion', async () => {
    const provider = providerFrom(async function* () {
      yield {
        type: 'message_start',
        id: 'm',
        model: 'gpt-4o',
        role: 'assistant',
        usage: { inputTokens: 10 },
      };
      yield { type: 'text_delta', index: 0, text: 'hello' };
      yield { type: 'message_delta', stopReason: 'stop', usage: { outputTokens: 7 } };
      yield { type: 'message_stop' };
    });
    const res = await openStream(provider, client, REQ, OPTS);
    if (res.kind !== 'stream') throw new Error('unreachable');
    await collect(res.frames);
    const o = await res.outcome;
    expect(o.status).toBe('success');
    expect(o.usage).toMatchObject({ inputTokens: 10, outputTokens: 7 }); // merged, not summed
    expect(o.outputChars).toBe(5); // 'hello'
  });

  it('settles outcome as error on a mid-stream failure', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield { type: 'error', error: { type: 'overloaded', message: 'x' } };
    });
    const res = await openStream(provider, client, REQ, OPTS);
    if (res.kind !== 'stream') throw new Error('unreachable');
    await collect(res.frames);
    expect((await res.outcome).status).toBe('error');
  });

  it('the post-commit outcome CARRIES the classified error with its sanitized diagnostic (add-request-error-detail)', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield {
        type: 'error',
        error: { type: 'overloaded', message: 'x' },
        // As yielded by the adapter stage: sanitized message + allowlisted id.
        diagnostic: {
          providerMessage: 'Overloaded, retry later' as SanitizedMessage,
          requestId: 'req_9',
        },
      };
    });
    const res = await openStream(provider, client, REQ, OPTS);
    if (res.kind !== 'stream') throw new Error('unreachable');
    await collect(res.frames);
    const o = await res.outcome;
    expect(o.status).toBe('error');
    expect(o.error?.kind).toBe('unavailable');
    expect(o.error?.providerMessage).toBe('Overloaded, retry later');
    expect(o.error?.requestId).toBe('req_9');
  });

  it('a disconnect DURING the terminal-frame suspension keeps the causal error settle (A-3)', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield { type: 'error', error: { type: 'overloaded', message: 'x' } };
    });
    const res = await openStream(provider, client, REQ, OPTS);
    if (res.kind !== 'stream') throw new Error('unreachable');
    // Pull manually until the terminal error frame arrives — the generator is
    // then suspended AT the terminal yield, with the outcome already settled.
    for (;;) {
      const r = await res.frames.next();
      if (r.done) throw new Error('stream ended before the terminal frame');
      if (r.value.includes('upstream_error')) break;
    }
    await res.frames.return(undefined); // the client disconnects RIGHT here
    const o = await res.outcome;
    expect(o.status).toBe('error');
    expect(o.callerAborted).toBe(false); // the earlier causal settle won — not mislabeled
    expect(o.error?.kind).toBe('unavailable');
  });

  it('settles outcome as error on an immediate pre-iteration return() (client disconnect)', async () => {
    const provider = providerFrom(async function* () {
      yield START;
      yield TEXT;
      yield STOP;
      yield END;
    });
    const res = await openStream(provider, client, REQ, OPTS);
    if (res.kind !== 'stream') throw new Error('unreachable');
    await res.frames.return(undefined); // never called next()
    const o = await res.outcome;
    expect(o.status).toBe('error');
    expect(o.error).toBeUndefined(); // a caller abort is not a provider fault
  });
});

describe('fallbackEligible', () => {
  it('continues on retryable/circuit-open, stops on bad_request/cancellation', () => {
    expect(fallbackEligible(new ProviderError('rate_limit', 'x'))).toBe(true);
    expect(fallbackEligible(new ProviderError('unavailable', 'x'))).toBe(true);
    expect(fallbackEligible(new ProviderError('unknown_model', 'x'))).toBe(true);
    expect(fallbackEligible(new ProviderCircuitOpenError('p'))).toBe(true);
    expect(fallbackEligible(new ProviderError('bad_request', 'x'))).toBe(false);
    expect(fallbackEligible(new CallCancelledError())).toBe(false);
  });
});

describe('runBufferedChain', () => {
  const client = getAdapter('openai');
  const newBreaker = (): CircuitBreaker => new CircuitBreaker(new InMemoryBreakerStore());
  const resp = (): NormalizedResponse => ({
    id: 'r',
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'stop',
  });
  const bufAttempt = (
    providerId: string,
    externalModelId: string,
    chat: () => Promise<NormalizedResponse>,
  ): ChainAttempt => ({
    providerId,
    externalModelId,
    buildAdapter: () =>
      Promise.resolve({
        protocol: 'openai_compatible',
        chat,
        chatStream: async function* () {
          /* unused */
        },
        listModels: () => Promise.resolve([]),
        testConnection: () => Promise.resolve({ ok: true, models: 0 }),
      } as unknown as ProviderAdapter),
  });

  it('falls through a retryable failure to the next member and records the trail', async () => {
    const attempts = [
      bufAttempt('p1', 'a', () => Promise.reject(new ProviderError('rate_limit', 'slow'))),
      bufAttempt('p2', 'b', () => Promise.resolve(resp())),
    ];
    const r = await runBufferedChain(
      newBreaker(),
      attempts,
      client,
      { model: 'x', messages: [], params: {} },
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.servedIndex).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.error.kind).toBe('rate_limit');
  });

  it('stops the walk on a bad_request (no fallback)', async () => {
    let secondCalled = false;
    const attempts = [
      bufAttempt('p1', 'a', () => Promise.reject(new ProviderError('bad_request', 'nope'))),
      bufAttempt('p2', 'b', () => {
        secondCalled = true;
        return Promise.resolve(resp());
      }),
    ];
    const r = await runBufferedChain(
      newBreaker(),
      attempts,
      client,
      { model: 'x', messages: [], params: {} },
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(false);
    expect(secondCalled).toBe(false);
    if (!r.ok) expect(r.callerAborted).toBe(false); // a provider/bad_request fault, not a caller abort
  });

  // A-3: the loop-STOP is on the composite work signal (so a cheap-tier deadline halts
  // the chain), but `callerAborted` must reflect only a real CLIENT abort (the pure
  // predicate) — otherwise a deadline would be recorded `cancelled` and suppress cascade
  // escalation. These pin the discriminator at the loop-top exit.
  it('a deadline abort (composite signal tripped, caller present) is NOT callerAborted', async () => {
    const deadline = new AbortController();
    deadline.abort(); // the composite (client-or-deadline) signal is already tripped
    const r = await runBufferedChain(
      newBreaker(),
      [bufAttempt('p1', 'a', () => Promise.resolve(resp()))],
      client,
      { model: 'x', messages: [], params: {} },
      { created: 1, isCallerAbort: () => false }, // client still present — only the deadline fired
      deadline.signal,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.callerAborted).toBe(false); // escalation-eligible, not a cancellation
  });

  it('a real client abort (pure predicate true) IS callerAborted', async () => {
    const gone = new AbortController();
    gone.abort();
    const r = await runBufferedChain(
      newBreaker(),
      [bufAttempt('p1', 'a', () => Promise.resolve(resp()))],
      client,
      { model: 'x', messages: [], params: {} },
      { created: 1, isCallerAbort: () => true }, // client disconnected
      gone.signal,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.callerAborted).toBe(true);
  });
});

describe('openStreamChain', () => {
  const client = getAdapter('openai');
  const newBreaker = (): CircuitBreaker => new CircuitBreaker(new InMemoryBreakerStore());
  const streamAttempt = (
    providerId: string,
    gen: () => AsyncGenerator<NormalizedStreamEvent>,
  ): ChainAttempt => ({
    providerId,
    externalModelId: providerId,
    buildAdapter: () =>
      Promise.resolve({
        protocol: 'openai_compatible',
        chat: () => Promise.reject(new Error('unused')),
        chatStream: gen,
        listModels: () => Promise.resolve([]),
        testConnection: () => Promise.resolve({ ok: true, models: 0 }),
      } as unknown as ProviderAdapter),
  });

  it('falls back pre-commit and commits the next member', async () => {
    const attempts = [
      streamAttempt('p1', async function* () {
        throw new ProviderError('rate_limit', 'slow');
      }),
      streamAttempt('p2', async function* () {
        yield START;
        yield TEXT;
        yield STOP;
        yield END;
      }),
    ];
    const r = await openStreamChain(
      newBreaker(),
      attempts,
      client,
      { model: 'x', messages: [], params: {} },
      OPTS,
    );
    expect(r.kind).toBe('stream');
    if (r.kind !== 'stream') throw new Error('unreachable');
    expect(r.servedIndex).toBe(1);
    expect(r.failures).toHaveLength(1);
    const out = await collect(r.frames);
    expect(out).toContain('data: [DONE]');
    expect(out).not.toContain('"upstream_error"'); // clean stream, no terminal error
  });

  // E1.3 composition: a hung-at-connect member whose stream is aborted by a
  // system timeout (CallCancelledError, caller still present) must TRIP its
  // breaker through the openStreamChain → withBreakerStream wiring, so the next
  // request skips it fast instead of paying the timeout again.
  it('a system-timeout (caller present) trips the breaker so the provider is skipped next time', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
      config: { threshold: 1, cooldownMs: 60_000, probeLeaseMs: 200, stateTtlMs: 60_000 },
    });
    const hung = streamAttempt('phung', async function* () {
      throw new CallCancelledError(); // core aborted the hung call; the client never left
    });
    const optsSystemAbort = { ...OPTS, isCallerAbort: () => false };

    const first = await openStreamChain(
      breaker,
      [hung],
      client,
      { model: 'x', messages: [], params: {} },
      optsSystemAbort,
    );
    expect(first.kind).toBe('error'); // no fallback member → chain fails

    // Second request: the breaker is now open, so admission throws
    // ProviderCircuitOpenError BEFORE the member's stream body runs — the hung
    // upstream is never touched again. If the breaker had wrongly stayed closed
    // (the re-neutralization bug), the body would run and set this true.
    let bodyRan = false;
    const guarded = streamAttempt('phung', async function* () {
      bodyRan = true;
      throw new CallCancelledError();
    });
    const second = await openStreamChain(
      breaker,
      [guarded],
      client,
      { model: 'x', messages: [], params: {} },
      optsSystemAbort,
    );
    expect(second.kind).toBe('error');
    expect(bodyRan).toBe(false); // skipped fast — breaker is open
  });

  // E1.3 adapter→core timing (clink finding 4, case i): when a provider accepts
  // the connection but never returns headers, the ADAPTER's own first-byte timer
  // (40ms) must fire before core's first-event timer (40+500ms) and throw the
  // typed `unavailable` ProviderError — which trips the breaker — rather than
  // core aborting first into a (would-be neutral) CallCancelledError.
  it("the adapter's first-byte timeout wins pre-headers, yielding a tripping `unavailable`", async () => {
    const neverHeaders: HttpClient = (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        init.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    const hungAdapter = (): ProviderAdapter =>
      createOpenaiProviderAdapter(
        {
          protocol: 'openai_compatible',
          baseUrl: 'http://provider.invalid/v1',
          credential: 'k',
          kind: 'api_key',
          mode: 'selfhosted',
          firstByteTimeoutMs: 40, // adapter bound < core first-event bound (540)
        },
        { httpClient: neverHeaders },
      );
    const attempt = {
      providerId: 'phdr',
      externalModelId: 'phdr',
      buildAdapter: () => Promise.resolve(hungAdapter()),
    };
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
      config: { threshold: 1, cooldownMs: 60_000, probeLeaseMs: 200, stateTtlMs: 60_000 },
    });
    // caller present (client did NOT abort); core bound is 540ms so the adapter's
    // 40ms timer must win.
    const opts = { firstEventTimeoutMs: 540, created: 1, isCallerAbort: () => false };

    const started = Date.now();
    const r = await openStreamChain(
      breaker,
      [attempt],
      client,
      { model: 'x', messages: [], params: {} },
      opts,
    );
    const elapsed = Date.now() - started;
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.error.kind).toBe('unavailable');
      // The ADAPTER's timer won (its message), not core's ('upstream event timeout').
      expect(r.error.message).toMatch(/first-byte/);
    }
    expect(elapsed).toBeLessThan(300); // fired at ~40ms (adapter), nowhere near core's 540ms

    // The unavailable tripped the breaker: a second attempt is skipped fast (body never built).
    let built = false;
    const guard = {
      providerId: 'phdr',
      externalModelId: 'phdr',
      buildAdapter: () => {
        built = true;
        return Promise.resolve(hungAdapter());
      },
    };
    await openStreamChain(breaker, [guard], client, { model: 'x', messages: [], params: {} }, opts);
    expect(built).toBe(false);
  }, 10_000);
});

describe('runBuffered', () => {
  it('serializes the IR response to the client wire', async () => {
    const response: NormalizedResponse = {
      id: 'r1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
    };
    const provider = providerFrom(
      async function* () {
        /* unused */
      },
      () => Promise.resolve(response),
    );
    const result = await runBuffered(
      provider,
      getAdapter('openai'),
      { model: 'x', messages: [], params: {} },
      { created: 1 },
    );
    expect((result.wire as { object: string }).object).toBe('chat.completion');
    expect(result.response.content).toHaveLength(1); // IR exposed for #11 usage capture
  });
});
