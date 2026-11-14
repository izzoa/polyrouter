/* eslint-disable @typescript-eslint/require-await, require-yield -- fake async generators in tests */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SsrfError } from '@polyrouter/shared/server';
import {
  openStream,
  runBuffered,
  runBufferedChain,
  openStreamChain,
  fallbackEligible,
  attemptBilling,
  chainBillingEvidence,
  type AttemptBilling,
  type AttemptFailure,
  type BufferedChainResult,
  type ChainAttempt,
  type StreamChainResult,
} from './core';
import { walkUnbilled } from '../recording';
import {
  getAdapter,
  type NormalizedRequest,
  type NormalizedStreamEvent,
  type NormalizedResponse,
  type SanitizedMessage,
} from './translate';
import {
  CallCancelledError,
  CircuitBreaker,
  DEFAULT_BREAKER_CONFIG,
  InMemoryBreakerStore,
  InMemoryPlanCooldownStore,
  PROVIDER_ERROR_KINDS,
  ProviderCircuitOpenError,
  ProviderError,
  classifyNetworkError,
  classifyResponse,
  createGuardedHttpClient,
  createOpenaiProviderAdapter,
  type HttpClient,
  type HttpResponse,
  type PlanCooldown,
  type PlanCooldownInput,
  type PlanCooldownStore,
  type ProviderAdapter,
  type ProviderConfig,
} from '../providers';
import { errorResponse } from '../providers/testkit.testkit';

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
  // fix-bad-request-dead-end: `bad_request` moved OUT of the stop set. A 400 in a
  // router describes the model polyrouter chose, not a defect in the caller's request.
  it('walks the chain on a bad_request — the router cannot establish it is the caller', () => {
    expect(fallbackEligible(new ProviderError('bad_request', 'context too long'))).toBe(true);
  });

  it('continues on retryable/circuit-open, stops on the two non-retryable kinds', () => {
    expect(fallbackEligible(new ProviderError('rate_limit', 'x'))).toBe(true);
    expect(fallbackEligible(new ProviderError('unavailable', 'x'))).toBe(true);
    expect(fallbackEligible(new ProviderError('unknown_model', 'x'))).toBe(true);
    expect(fallbackEligible(new ProviderCircuitOpenError('p'))).toBe(true);
    expect(fallbackEligible(new CallCancelledError())).toBe(false);
  });

  // fix-4xx-error-taxonomy: an account-level rejection, a moderation refusal, and an
  // unrecognized 4xx all describe ONE provider's state, not a defect in the caller's
  // request — the chain must walk on. A 451 is the one deliberate exception.
  it.each(['insufficient_funds', 'content_policy', 'permission', 'upstream_rejected'] as const)(
    'walks the chain on %s',
    (kind) => {
      expect(fallbackEligible(new ProviderError(kind, 'x'))).toBe(true);
    },
  );

  it('stops on policy_block — the router CAN try another member and must not', () => {
    expect(fallbackEligible(new ProviderError('policy_block', 'x'))).toBe(false);
  });

  // fix-bad-request-dead-end: the transport byte bound's guarantee. Walking on would
  // re-drain a second over-cap body on the next member, so one hostile-but-address-safe
  // endpoint could be made to flood once per chain member. This stop is resource
  // protection, NOT a judgement that the caller's request was malformed — it must not
  // be collapsed into the `policy_block` branch or into any "caller's fault" test.
  it('stops on oversized_response — walking would re-drain a second over-cap body', () => {
    expect(fallbackEligible(new ProviderError('oversized_response', 'over cap'))).toBe(false);
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

  // fix-bad-request-dead-end: this is the change's headline, and the inversion of what
  // this test used to assert. A 400 from a ROUTER-chosen member is evidence that THIS
  // model refused, not that the request is malformed — so the chain is tried.
  it('walks the chain on a bad_request and a later member serves', async () => {
    let secondCalled = false;
    const attempts = [
      bufAttempt('p1', 'a', () =>
        Promise.reject(new ProviderError('bad_request', 'context length exceeded')),
      ),
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
    expect(r.ok).toBe(true);
    expect(secondCalled).toBe(true);
    if (r.ok) {
      expect(r.servedIndex).toBe(1);
      // the refusing member enters the trail — the record of WHY the chain moved
      expect(r.failures.map((f) => f.error.kind)).toEqual(['bad_request']);
    }
  });

  // The client-named path, byte-identical by CONSTRUCTION rather than by a rule: a
  // single-element chain has no next member, so eligibility changes nothing on the wire.
  it('a single-element chain failing bad_request makes exactly one call', async () => {
    let calls = 0;
    const attempts = [
      bufAttempt('p1', 'a', () => {
        calls += 1;
        return Promise.reject(new ProviderError('bad_request', 'nope'));
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
    expect(calls).toBe(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('bad_request');
      expect(r.callerAborted).toBe(false);
    }
  });

  // fix-bad-request-dead-end: the byte bound's regression guard at the WALK level, not
  // just the classifier level. Written in the same change that makes `bad_request`
  // fallback-eligible, so if the two ever get collapsed again this fails loudly.
  it('stops the walk on an oversized_response — no second over-cap body is drained', async () => {
    let secondCalled = false;
    const attempts = [
      bufAttempt('p1', 'a', () =>
        Promise.reject(new ProviderError('oversized_response', 'provider response body exceeds')),
      ),
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
    if (!r.ok) expect(r.error.kind).toBe('oversized_response');
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

/** A chain walker's error result, whichever walker produced it. */
type WalkError =
  Extract<BufferedChainResult, { ok: false }> | Extract<StreamChainResult, { kind: 'error' }>;

// keep-cheap-leg-attempt-trail (design D3): the walk records the member its OWN deadline
// cut off — the cascade cheap leg's composite signal fired while the client was present —
// before or after response headers, and nothing else: not a caller abort, not a member the
// deadline beat to dispatch, not a provider answer that carried a status, and not an
// unrelated failure the deadline merely overtook while the breaker settled.
// record-route-legs (design D3) runs the same cases against BOTH walkers — the streaming
// walker gains the deadline marker too — and adds how each walk ENDS.
describe.each(['buffered', 'stream'] as const)(
  '%s walker — a member cut off by the walk’s own deadline',
  (mode) => {
    const client = getAdapter('openai');
    const REQ = { model: 'x', messages: [], params: {} };
    const resp = (): NormalizedResponse => ({
      id: 'r',
      model: 'm',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
    });
    type Chat = (signal: AbortSignal) => Promise<NormalizedResponse>;
    /** A member whose call receives the attempt's signal, like a real adapter does: the
     * buffered `chat` runs `chat`; `chatStream` runs it too and, once it resolves, streams
     * a clean answer — so one behaviour drives both walkers. The optional hooks run during
     * adapter build (before dispatch) and on breaker settlement. */
    const member = (
      providerId: string,
      chat: Chat,
      hooks: { onBuild?: () => void; onSettle?: () => void } = {},
    ): ChainAttempt => ({
      providerId,
      externalModelId: `${providerId}-model`,
      buildAdapter: () => {
        hooks.onBuild?.();
        return Promise.resolve({
          protocol: 'openai_compatible',
          chat: (_req: NormalizedRequest, opts: { signal: AbortSignal }) => chat(opts.signal),
          chatStream: async function* (_req: NormalizedRequest, opts: { signal: AbortSignal }) {
            await chat(opts.signal);
            yield START;
            yield TEXT;
            yield STOP;
            yield END;
          },
          listModels: () => Promise.resolve([]),
          testConnection: () => Promise.resolve({ ok: true, models: 0 }),
        } as unknown as ProviderAdapter);
      },
      ...(hooks.onSettle !== undefined ? { onSettle: hooks.onSettle } : {}),
    });
    /** The adapter's in-flight behaviour while the deadline fires: it hangs until the walk's
     * signal aborts, then rejects with what the http adapter throws for that phase. */
    const hangThen =
      (onAbort: () => Error, fire: { abort(): void }): Chat =>
      (signal) =>
        new Promise((_resolve, reject) => {
          // The adapter's own entry check (`http.ts`): an already-aborted call never leaves.
          if (signal.aborted) {
            reject(new CallCancelledError());
            return;
          }
          signal.addEventListener('abort', () => reject(onAbort()), { once: true });
          setTimeout(() => fire.abort(), 0); // the deadline fires while the call is in flight
        });
    const beforeHeaders = (): Error => new CallCancelledError();
    const afterHeaders = (): Error =>
      new ProviderError('unavailable', 'provider request failed: aborted');
    const walk = async (
      attempts: readonly ChainAttempt[],
      signal: AbortSignal,
      isCallerAbort?: () => boolean,
    ): Promise<BufferedChainResult | StreamChainResult> => {
      const breaker = new CircuitBreaker(new InMemoryBreakerStore());
      const abortCtx = isCallerAbort !== undefined ? { isCallerAbort } : {};
      if (mode === 'buffered') {
        return runBufferedChain(
          breaker,
          attempts,
          client,
          REQ,
          { created: 1, ...abortCtx },
          signal,
        );
      }
      const r = await openStreamChain(breaker, attempts, client, REQ, {
        ...OPTS,
        signal,
        ...abortCtx,
      });
      if (r.kind === 'stream') await collect(r.frames);
      return r;
    };
    const failed = (r: BufferedChainResult | StreamChainResult): WalkError => {
      if ('ok' in r) {
        if (r.ok) throw new Error('expected the walk to fail');
        return r;
      }
      if (r.kind === 'stream') throw new Error('expected the walk to fail');
      return r;
    };

    // record-route-legs (codex review of the implementation): the caller state that decides
    // a non-retryable stop is the one seen when the call rejected. A client that leaves while
    // the breaker settles a genuine provider failure must not turn it into a cancel.
    it.each([
      [
        'policy_block, HTTP 451',
        (): Error => new ProviderError('policy_block', 'legal', { status: 451 }),
      ],
      ['oversized_response', (): Error => new ProviderError('oversized_response', 'too big')],
    ])(
      'a client leaving while the breaker settles a genuine %s stop is not a cancel',
      async (_name, fault) => {
        const gone = new AbortController();
        const r = failed(
          await walk(
            [member('p1', () => Promise.reject(fault()), { onSettle: () => gone.abort() })],
            gone.signal,
            () => gone.signal.aborted,
          ),
        );
        expect(gone.signal.aborted).toBe(true); // the client did leave, during settlement
        expect(r.callerAborted).toBe(false);
        expect(r.ended).toBe('stopped');
        expect(r.stopped).toEqual({ index: 0, sent: true });
        expect(r.failures).toHaveLength(0);
      },
    );

    it('records a cut BEFORE response headers as a dispatched, uncertain deadline entry', async () => {
      const deadline = new AbortController();
      const r = failed(
        await walk([member('p1', hangThen(beforeHeaders, deadline))], deadline.signal, () => false),
      );
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]).toMatchObject({
        index: 0,
        dispatched: true,
        billing: 'uncertain',
        stop: 'deadline',
      });
      expect(r.failures[0]!.error.kind).toBe('unavailable');
      expect(r.failures[0]!.error.status).toBeUndefined();
      expect(r.error).toBe(r.failures[0]!.error);
      expect(r.callerAborted).toBe(false); // still escalation-eligible
      // The attempt's billing class rides its entry now, never twice (design D8).
      expect(r.terminalBilling).toBeUndefined();
      // record-route-legs (design D3): the walk names the member it was attempting.
      expect(r.ended).toBe('deadline');
      expect(r.stopped).toEqual({ index: 0, sent: true });
    });

    it('keeps the billing evidence of a before-headers cut exactly as it was (design D8)', async () => {
      const deadline = new AbortController();
      const r = failed(
        await walk([member('p1', hangThen(beforeHeaders, deadline))], deadline.signal, () => false),
      );
      // Before this change: no entry, `terminalBilling: 'uncertain'` → the same evidence.
      expect(chainBillingEvidence(r)).toEqual(['uncertain']);
      expect(walkUnbilled(chainBillingEvidence(r))).toBe(false);
    });

    it('marks a cut AFTER response headers (an aborted body read) the same way', async () => {
      const deadline = new AbortController();
      const r = failed(
        await walk([member('p1', hangThen(afterHeaders, deadline))], deadline.signal, () => false),
      );
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]).toMatchObject({ index: 0, dispatched: true, stop: 'deadline' });
      expect(r.failures[0]!.error.status).toBeUndefined();
      expect(r.callerAborted).toBe(false);
      // record-route-legs (design D3): the cut ends the walk AT ONCE — never `exhausted`
      // on the only member — and the attempt's class rides its entry alone.
      expect(r.ended).toBe('deadline');
      expect(r.stopped).toEqual({ index: 0, sent: true });
      expect(r.terminalBilling).toBeUndefined();
    });

    it('marks only the member that was cut, after an earlier member’s quick 429', async () => {
      const deadline = new AbortController();
      const r = failed(
        await walk(
          [
            member('p1', () =>
              Promise.reject(new ProviderError('rate_limit', 'slow', { status: 429 })),
            ),
            member('p2', hangThen(beforeHeaders, deadline)),
          ],
          deadline.signal,
          () => false,
        ),
      );
      expect(r.failures.map((f) => [f.index, f.error.kind, f.stop])).toEqual([
        [0, 'rate_limit', undefined],
        [1, 'unavailable', 'deadline'],
      ]);
      expect(r.failures[0]).not.toHaveProperty('stop');
      expect(r.ended).toBe('deadline');
      expect(r.stopped).toEqual({ index: 1, sent: true });
    });

    it.each([
      ['before headers', beforeHeaders],
      ['after headers', afterHeaders],
    ])('never marks a CALLER abort (%s)', async (_phase, onAbort) => {
      const gone = new AbortController();
      const r = failed(
        await walk([member('p1', hangThen(onAbort, gone))], gone.signal, () => gone.signal.aborted),
      );
      expect(r.failures.some((f) => f.stop !== undefined)).toBe(false);
      expect(r.callerAborted).toBe(true);
      // A caller cancel never enters the trail — before headers as before this change, and
      // now after them too (record-route-legs design D3: the member did not fail).
      expect(r.failures).toHaveLength(0);
      expect(r.terminalBilling).toBe('uncertain');
      expect(r.ended).toBe('cancelled');
      expect(r.stopped).toEqual({ index: 0, sent: true });
    });

    it('records nothing for a member the deadline beat to dispatch (fired during its build)', async () => {
      const deadline = new AbortController();
      let sentCalls = 0;
      const r = failed(
        await walk(
          [
            member('p1', () =>
              Promise.reject(new ProviderError('rate_limit', 'slow', { status: 429 })),
            ),
            member(
              'p2',
              (signal) => {
                sentCalls += 1;
                // the adapter's entry check: the call never leaves
                return signal.aborted
                  ? Promise.reject(new CallCancelledError())
                  : Promise.resolve(resp());
              },
              { onBuild: () => deadline.abort() },
            ),
          ],
          deadline.signal,
          () => false,
        ),
      );
      expect(sentCalls).toBe(1); // reached the adapter's entry check, which refused
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]!.index).toBe(0);
      expect(r.failures[0]).not.toHaveProperty('stop');
      expect(r.terminalBilling).toBe('uncertain'); // the not-sent member's stop, as before
      expect(r.callerAborted).toBe(false);
      expect(r.ended).toBe('deadline'); // the client is still present
      expect(r.stopped).toEqual({ index: 1, sent: false }); // reached, never sent
    });

    it('never marks a walk that has no caller-abort predicate', async () => {
      const deadline = new AbortController();
      const r = failed(
        await walk([member('p1', hangThen(beforeHeaders, deadline))], deadline.signal),
      );
      expect(r.failures).toHaveLength(0);
      expect(r.terminalBilling).toBe('uncertain');
      // Without the predicate neither a deadline nor a client can be named: the walker
      // reports the cancellation as the stop it was (record-route-legs design D3).
      expect(r.callerAborted).toBe(false);
      expect(r.ended).toBe('stopped');
      expect(r.stopped).toEqual({ index: 0, sent: true });
    });

    it('keeps a provider answer that carries a status, even when the deadline fired first', async () => {
      const deadline = new AbortController();
      const r = failed(
        await walk(
          [
            member('p1', () => {
              deadline.abort();
              return Promise.reject(
                new ProviderError('unavailable', 'upstream 503', { status: 503 }),
              );
            }),
          ],
          deadline.signal,
          () => false,
        ),
      );
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]!.error.status).toBe(503);
      expect(r.failures[0]).not.toHaveProperty('stop');
      // It genuinely failed, so the last member's walk is exhausted (design D3).
      expect(r.ended).toBe('exhausted');
      expect(r).not.toHaveProperty('stopped');
    });

    it('never marks a local refusal (not sent), even when the deadline fired first', async () => {
      const deadline = new AbortController();
      const r = failed(
        await walk(
          [
            member('p1', () => {
              deadline.abort();
              return Promise.reject(new ProviderError('credential', 'token refresh failed'));
            }),
          ],
          deadline.signal,
          () => false,
        ),
      );
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]!.billing).toBe('not_sent');
      expect(r.failures[0]).not.toHaveProperty('stop');
      expect(r.ended).toBe('exhausted');
      expect(r).not.toHaveProperty('stopped');
    });

    // codex proposal review: `withBreaker` awaits its settlement before rethrowing, so a
    // deadline can fire AFTER an unrelated failure and BEFORE the walker's catch reads the
    // signal. The snapshot taken when the call rejected keeps that failure unmarked.
    it.each([
      [
        'a status-less network failure',
        (): Error => new ProviderError('unavailable', 'ECONNREFUSED'),
        'exhausted',
      ],
      [
        'an SSRF refusal',
        (): Error => new SsrfError('blocked_ip', 'resolves to a blocked address'),
        'stopped',
      ],
    ] as const)(
      'never relabels %s the deadline overtook during breaker settlement',
      async (_name, fault, end) => {
        const deadline = new AbortController();
        const r = failed(
          await walk(
            [member('p1', () => Promise.reject(fault()), { onSettle: () => deadline.abort() })],
            deadline.signal,
            () => false,
          ),
        );
        expect(deadline.signal.aborted).toBe(true); // the deadline did fire, during settlement
        expect(r.failures.some((f) => f.stop !== undefined)).toBe(false);
        // …and the end is the failure's own, never `deadline` (record-route-legs design D3).
        expect(r.ended).toBe(end);
      },
    );

    it('never marks a non-retryable stop other than a cancellation', async () => {
      const deadline = new AbortController();
      const r = failed(
        await walk(
          [
            member('p1', () => {
              deadline.abort();
              return Promise.reject(new ProviderError('oversized_response', 'body exceeds'));
            }),
          ],
          deadline.signal,
          () => false,
        ),
      );
      expect(r.failures).toHaveLength(0); // the terminal stop never enters the trail, as before
      expect(r.error.kind).toBe('oversized_response');
      expect(r.terminalBilling).toBe('uncertain');
      // A real failure no abort explains (record-route-legs design D3).
      expect(r.ended).toBe('stopped');
      expect(r.stopped).toEqual({ index: 0, sent: true });
    });

    it('never marks a walk whose signal is the caller’s own (the primary and escalation walks)', async () => {
      const caller = new AbortController();
      const r = failed(
        await walk(
          [
            member('p1', hangThen(afterHeaders, caller)),
            member('p2', hangThen(beforeHeaders, caller)),
          ],
          caller.signal,
          () => caller.signal.aborted,
        ),
      );
      expect(r.failures.some((f) => f.stop !== undefined)).toBe(false);
      expect(r.callerAborted).toBe(true);
      // record-route-legs (design D3): p1 was in flight when the client left — it did not
      // fail, so it is no entry (it used to be pushed as `unavailable`) and the walk ends
      // at once, naming it.
      expect(r.failures).toHaveLength(0);
      expect(r.ended).toBe('cancelled');
      expect(r.stopped).toEqual({ index: 0, sent: true });
    });

    // record-route-legs (design D3): how a walk that served nothing ENDS, and the member it
    // was attempting. Every case also pins the billing evidence against what the walk
    // recorded before this change (`pre`): `walkUnbilled` must give the same answer.
    describe('how the walk ends (record-route-legs design D3)', () => {
      const rejectWith =
        (fault: () => Error): Chat =>
        () =>
          Promise.reject(fault());
      const quick429 = (): Error => new ProviderError('rate_limit', 'slow', { status: 429 });
      const upstream503 = (): Error =>
        new ProviderError('unavailable', 'upstream 503', { status: 503 });
      const serves: Chat = () => Promise.resolve(resp());
      /** A member the walk must never reach: any build is counted. */
      const untouched = (providerId: string, built: { n: number }): ChainAttempt =>
        member(providerId, serves, {
          onBuild: () => {
            built.n += 1;
          },
        });
      const sameUnbilled = (r: WalkError, pre: readonly AttemptBilling[]): void => {
        expect(walkUnbilled(chainBillingEvidence(r))).toBe(walkUnbilled(pre));
      };
      /** A caller predicate whose answer flips on every read. */
      const flipping = (): (() => boolean) => {
        let reads = 0;
        return () => {
          reads += 1;
          return reads % 2 === 0;
        };
      };
      /** ONE read decides both: `cancelled` exactly when the caller is gone, and
       * `deadline` only while it is present. */
      const fromOneRead = (r: WalkError): void => {
        expect(r.ended === 'cancelled').toBe(r.callerAborted);
        if (r.ended === 'deadline') expect(r.callerAborted).toBe(false);
      };

      it.each([
        ['a client cancel', true, 'cancelled'],
        ['the walk’s own deadline', false, 'deadline'],
      ] as const)('%s found at the loop start names no member', async (_n, gone, end) => {
        const ac = new AbortController();
        ac.abort();
        const built = { n: 0 };
        const r = failed(await walk([untouched('p0', built)], ac.signal, () => gone));
        expect(built.n).toBe(0);
        expect(r.ended).toBe(end);
        expect(r).not.toHaveProperty('stopped');
        expect(r.callerAborted).toBe(gone);
        expect(r.failures).toEqual([]);
        expect(r.terminalBilling).toBe('not_sent');
        expect(chainBillingEvidence(r)).toEqual(['not_sent']);
        sameUnbilled(r, ['not_sent']);
      });

      it('a loop-start abort with no caller predicate ends cancelled, not flagged', async () => {
        const ac = new AbortController();
        ac.abort();
        const r = failed(await walk([member('p0', serves)], ac.signal));
        expect(r.ended).toBe('cancelled');
        expect(r.callerAborted).toBe(false); // as before: no predicate, no caller abort
        expect(r).not.toHaveProperty('stopped');
      });

      it.each([
        ['before headers', 'a middle', true],
        ['before headers', 'the last', false],
        ['after headers', 'a middle', true],
        ['after headers', 'the last', false],
      ] as const)(
        'a deadline cut %s on %s member ends the walk at once and names it',
        async (phase, _position, middle) => {
          const deadline = new AbortController();
          const built = { n: 0 };
          const r = failed(
            await walk(
              [
                member('p0', rejectWith(quick429)),
                member(
                  'p1',
                  hangThen(phase === 'before headers' ? beforeHeaders : afterHeaders, deadline),
                ),
                ...(middle ? [untouched('p2', built)] : []),
              ],
              deadline.signal,
              () => false,
            ),
          );
          expect(r.ended).toBe('deadline'); // never `exhausted`, even on the last member
          expect(r.stopped).toEqual({ index: 1, sent: true });
          expect(built.n).toBe(0);
          // The member's only entry is RT-2's: naming it as the stopper adds no second one.
          expect(r.failures.map((f) => [f.index, f.stop])).toEqual([
            [0, undefined],
            [1, 'deadline'],
          ]);
          expect(r.error).toBe(r.failures[1]!.error);
          expect(r.callerAborted).toBe(false);
          expect(r.terminalBilling).toBeUndefined();
          expect(chainBillingEvidence(r)).toEqual(['rejected', 'uncertain']);
          // Before: a post-headers cut was pushed and the walk ended at the next loop start
          // (`not_sent`) or exhausted; the streaming walker kept a pre-headers cut as its
          // uncertain terminal.
          sameUnbilled(
            r,
            phase === 'after headers' && middle
              ? ['rejected', 'uncertain', 'not_sent']
              : ['rejected', 'uncertain'],
          );
        },
      );

      it.each(['before headers', 'after headers'] as const)(
        'a client cancel %s names the member in flight and adds no entry for it',
        async (phase) => {
          const gone = new AbortController();
          const built = { n: 0 };
          const r = failed(
            await walk(
              [
                member('p0', rejectWith(quick429)),
                member(
                  'p1',
                  hangThen(phase === 'before headers' ? beforeHeaders : afterHeaders, gone),
                ),
                untouched('p2', built),
              ],
              gone.signal,
              () => gone.signal.aborted,
            ),
          );
          expect(r.ended).toBe('cancelled');
          expect(r.stopped).toEqual({ index: 1, sent: true });
          expect(r.failures.map((f) => f.index)).toEqual([0]); // the in-flight member did not fail
          expect(built.n).toBe(0);
          expect(r.callerAborted).toBe(true);
          expect(r.terminalBilling).toBe('uncertain');
          expect(chainBillingEvidence(r)).toEqual(['rejected', 'uncertain']);
          sameUnbilled(
            r,
            phase === 'before headers'
              ? ['rejected', 'uncertain']
              : ['rejected', 'uncertain', 'not_sent'],
          );
        },
      );

      it('a client cancel that lands with the walk’s own deadline still ends cancelled', async () => {
        const walkSignal = new AbortController();
        let clientGone = false;
        const both = {
          abort: (): void => {
            clientGone = true;
            walkSignal.abort();
          },
        };
        const r = failed(
          await walk(
            [member('p0', hangThen(afterHeaders, both))],
            walkSignal.signal,
            () => clientGone,
          ),
        );
        expect(r.ended).toBe('cancelled'); // never `deadline`
        expect(r.stopped).toEqual({ index: 0, sent: true });
        expect(r.failures).toEqual([]);
        expect(r.callerAborted).toBe(true);
        sameUnbilled(r, ['uncertain']); // before: pushed, then exhausted
      });

      it.each([
        ['an upstream 503', upstream503, 'rejected', 'the client leaves', true, 'cancelled'],
        ['an upstream 503', upstream503, 'rejected', 'the deadline fires', false, 'deadline'],
        [
          'a local refusal',
          (): Error => new ProviderError('credential', 'token refresh failed'),
          'not_sent',
          'the client leaves',
          true,
          'cancelled',
        ],
      ] as const)(
        '%s as %s is pushed, and the next loop start ends the walk naming no member',
        async (_f, fault, billing, _w, gone, end) => {
          const ac = new AbortController();
          const built = { n: 0 };
          const r = failed(
            await walk(
              [
                member('p0', () => {
                  ac.abort();
                  return Promise.reject(fault());
                }),
                untouched('p1', built),
              ],
              ac.signal,
              () => gone && ac.signal.aborted,
            ),
          );
          expect(r.failures.map((f) => [f.index, f.billing, f.stop])).toEqual([
            [0, billing, undefined],
          ]);
          expect(built.n).toBe(0);
          expect(r.ended).toBe(end);
          expect(r).not.toHaveProperty('stopped');
          expect(r.callerAborted).toBe(gone);
          expect(r.terminalBilling).toBe('not_sent');
          sameUnbilled(r, [billing, 'not_sent']);
        },
      );

      it.each([
        ['an upstream 503', upstream503, 'rejected'],
        [
          'a local refusal',
          (): Error => new ProviderError('credential', 'token refresh failed'),
          'not_sent',
        ],
      ] as const)(
        '%s on the last member as the client leaves ends the walk exhausted',
        async (_f, fault, billing) => {
          const gone = new AbortController();
          const r = failed(
            await walk(
              [
                member('p0', rejectWith(quick429)),
                member('p1', () => {
                  gone.abort();
                  return Promise.reject(fault());
                }),
              ],
              gone.signal,
              () => gone.signal.aborted,
            ),
          );
          expect(r.failures.map((f) => [f.index, f.billing])).toEqual([
            [0, 'rejected'],
            [1, billing],
          ]);
          expect(r.ended).toBe('exhausted');
          expect(r).not.toHaveProperty('stopped');
          expect(r.callerAborted).toBe(true);
          // The terminal error IS the last entry, so a final leg marks it terminal.
          expect(r.error).toBe(r.failures[1]!.error);
          expect(r.terminalBilling).toBeUndefined();
          sameUnbilled(r, ['rejected', billing]);
        },
      );

      it('a loop-start abort takes its flag and its end from one caller read', async () => {
        const ac = new AbortController();
        ac.abort();
        const r = failed(await walk([member('p0', serves)], ac.signal, flipping()));
        expect(['cancelled', 'deadline']).toContain(r.ended);
        fromOneRead(r);
      });

      it('an abort that beat dispatch takes its flag and its end from one caller read', async () => {
        const ac = new AbortController();
        const r = failed(
          await walk(
            [
              member(
                'p0',
                (signal) =>
                  signal.aborted
                    ? Promise.reject(new CallCancelledError())
                    : Promise.resolve(resp()),
                { onBuild: () => ac.abort() },
              ),
            ],
            ac.signal,
            flipping(),
          ),
        );
        expect(r.stopped).toEqual({ index: 0, sent: false });
        expect(['cancelled', 'deadline']).toContain(r.ended);
        fromOneRead(r);
      });

      it.each([
        [
          'policy_block',
          (): Error => new ProviderError('policy_block', 'blocked', { status: 451 }),
          'rejected',
        ],
        [
          'oversized_response',
          (): Error => new ProviderError('oversized_response', 'body exceeds'),
          'uncertain',
        ],
      ] as const)(
        'a %s at member 1 ends the walk stopped there, sent',
        async (kind, fault, billing) => {
          const built = { n: 0 };
          const r = failed(
            await walk(
              [
                member('p0', rejectWith(quick429)),
                member('p1', rejectWith(fault)),
                untouched('p2', built),
              ],
              new AbortController().signal,
              () => false,
            ),
          );
          expect(r.ended).toBe('stopped');
          expect(r.stopped).toEqual({ index: 1, sent: true });
          expect(r.error.kind).toBe(kind); // the stopper's own error, never a trail entry
          expect(r.failures.map((f) => f.index)).toEqual([0]);
          expect(built.n).toBe(0);
          expect(r.callerAborted).toBe(false);
          expect(r.terminalBilling).toBe(billing);
          sameUnbilled(r, ['rejected', billing]);
        },
      );

      it.each([
        ['the client’s cancel', true, 'cancelled'],
        ['the walk’s own deadline', false, 'deadline'],
      ] as const)('%s during member 1’s build names it unsent', async (_n, gone, end) => {
        const ac = new AbortController();
        let entered = 0;
        const r = failed(
          await walk(
            [
              member('p0', rejectWith(quick429)),
              member(
                'p1',
                (signal) => {
                  entered += 1;
                  return signal.aborted
                    ? Promise.reject(new CallCancelledError())
                    : Promise.resolve(resp());
                },
                { onBuild: () => ac.abort() },
              ),
            ],
            ac.signal,
            () => gone && ac.signal.aborted,
          ),
        );
        expect(entered).toBe(1); // the adapter's entry check refused it: never sent
        expect(r.ended).toBe(end);
        expect(r.stopped).toEqual({ index: 1, sent: false });
        expect(r.failures.map((f) => f.index)).toEqual([0]);
        expect(r.callerAborted).toBe(gone);
        expect(r.terminalBilling).toBe('uncertain'); // as before
        sameUnbilled(r, ['rejected', 'uncertain']);
      });

      it('a cancellation no abort explains ends the walk stopped, as `unavailable`', async () => {
        const r = failed(
          await walk(
            [
              member('p0', rejectWith(quick429)),
              member(
                'p1',
                rejectWith(() => new CallCancelledError()),
              ),
            ],
            new AbortController().signal,
            () => false,
          ),
        );
        expect(r.ended).toBe('stopped');
        expect(r.stopped).toEqual({ index: 1, sent: true });
        expect(r.error.kind).toBe('unavailable');
        expect(r.failures.map((f) => f.index)).toEqual([0]); // a stopper is never an entry
        expect(r.callerAborted).toBe(false);
        expect(r.terminalBilling).toBe('uncertain');
        sameUnbilled(r, ['rejected', 'uncertain']);
      });

      it('a walk whose every member failed ends exhausted, naming no member', async () => {
        const r = failed(
          await walk(
            [member('p0', rejectWith(quick429)), member('p1', rejectWith(upstream503))],
            new AbortController().signal,
            () => false,
          ),
        );
        expect(r.ended).toBe('exhausted');
        expect(r).not.toHaveProperty('stopped');
        expect(r.failures.map((f) => f.index)).toEqual([0, 1]);
        expect(r.error).toBe(r.failures[1]!.error);
        expect(r.terminalBilling).toBeUndefined();
        sameUnbilled(r, ['rejected', 'rejected']);
      });

      it('an empty chain ends exhausted', async () => {
        const r = failed(await walk([], new AbortController().signal, () => false));
        expect(r.ended).toBe('exhausted');
        expect(r).not.toHaveProperty('stopped');
        expect(r.terminalBilling).toBe('not_sent');
        sameUnbilled(r, ['not_sent']);
      });

      it('a served walk reports no end and no stopping member', async () => {
        const chains: (readonly ChainAttempt[])[] = [
          [member('p0', serves)],
          [member('p0', rejectWith(quick429)), member('p1', serves)],
        ];
        for (const chain of chains) {
          const r = await walk(chain, new AbortController().signal, () => false);
          expect('ok' in r ? r.ok : r.kind === 'stream').toBe(true);
          expect(r).not.toHaveProperty('ended');
          expect(r).not.toHaveProperty('stopped');
        }
      });

      // The breaker settles before the walker's catch runs: a client that leaves DURING
      // settlement, after an unrelated status-less failure, must not turn that failure into
      // an in-flight cancel — the snapshot taken when the call rejected decides.
      it('a client that leaves during breaker settlement leaves an unrelated failure pushed', async () => {
        const gone = new AbortController();
        const built = { n: 0 };
        const r = failed(
          await walk(
            [
              member(
                'p0',
                rejectWith(() => new ProviderError('unavailable', 'ECONNREFUSED')),
                {
                  onSettle: () => gone.abort(),
                },
              ),
              untouched('p1', built),
            ],
            gone.signal,
            () => gone.signal.aborted,
          ),
        );
        expect(gone.signal.aborted).toBe(true); // the client did leave, during settlement
        expect(r.failures.map((f) => [f.index, f.billing, f.stop])).toEqual([
          [0, 'uncertain', undefined],
        ]);
        expect(built.n).toBe(0);
        expect(r.ended).toBe('cancelled'); // found at the next loop start
        expect(r).not.toHaveProperty('stopped');
        expect(r.callerAborted).toBe(true);
        sameUnbilled(r, ['uncertain', 'not_sent']);
      });
    });
  },
);

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

  // fix-bad-request-dead-end + invariant 3: pre-commit, a `bad_request` now WALKS.
  // After the first token the member is committed and the same kind must terminate the
  // stream instead — proven here by a second member that would have served and is
  // never built. The retained markers ride the terminal error so the row stays
  // diagnosable, and the committed member contributes no attempt entry.
  it('a post-commit bad_request terminates without a swap; pre-commit it walks', async () => {
    let secondBuilt = false;
    const committed = [
      streamAttempt('p1', async function* () {
        yield START;
        yield TEXT; // <- committed here
        yield {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'too long' },
          diagnostic: {
            kind: 'bad_request' as const,
            providerMessage: '[validation message withheld]' as SanitizedMessage,
            markers: ['context_length_exceeded'],
          },
        };
      }),
      {
        ...streamAttempt('p2', async function* () {
          yield START;
          yield TEXT;
          yield STOP;
          yield END;
        }),
        buildAdapter: () => {
          secondBuilt = true;
          return Promise.reject(new Error('must never be built after commit'));
        },
      } as ChainAttempt,
    ];
    const r = await openStreamChain(
      newBreaker(),
      committed,
      client,
      { model: 'x', messages: [], params: {} },
      OPTS,
    );
    if (r.kind !== 'stream') throw new Error('expected a committed stream');
    const out = await collect(r.frames);
    const o = await r.outcome;
    expect(o.status).toBe('error');
    expect(o.error?.kind).toBe('bad_request');
    expect(o.error?.markers).toEqual(['context_length_exceeded']);
    expect(secondBuilt).toBe(false); // invariant 3 — no swap after the first token
    expect(out).toContain('upstream_error'); // a terminal frame, not a silent switch
    expect(r.failures).toEqual([]); // the committed member is not an attempt entry
  });

  // The pre-commit twin of the above: the SAME kind, before any token, now walks.
  it('walks pre-commit on a bad_request and the next member commits', async () => {
    const attempts = [
      streamAttempt('p1', async function* () {
        throw new ProviderError('bad_request', 'nope');
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
    if (r.kind === 'stream') expect(r.servedIndex).toBe(1);
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

  // fix-4xx-error-taxonomy. The chain-walk end of the carried kind: an in-band error
  // whose marker lives ONLY in `code` must walk on with the right kind. Against the
  // pre-change wiring the kind would be re-derived from the generic outward type.
  it.each(['insufficient_funds', 'content_policy', 'permission'] as const)(
    'walks the chain pre-commit on a carried %s kind',
    async (carried) => {
      const attempts = [
        streamAttempt('p1', async function* () {
          yield {
            type: 'error',
            error: { type: 'error', message: 'refused' },
            diagnostic: { kind: carried },
          } as NormalizedStreamEvent;
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
      expect(r.failures[0]?.error.kind).toBe(carried);
    },
  );

  // The one carried kind that must NOT walk on: routing around a legal denial is the
  // circumvention `policy_block` exists to prevent.
  it('stops the walk pre-commit on a carried policy_block', async () => {
    let secondDispatched = false;
    const attempts = [
      streamAttempt('p1', async function* () {
        yield {
          type: 'error',
          error: { type: 'error', message: 'blocked' },
          diagnostic: { kind: 'policy_block' },
        } as NormalizedStreamEvent;
      }),
      streamAttempt('p2', async function* () {
        secondDispatched = true;
        yield START;
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
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.error.kind).toBe('policy_block');
    expect(secondDispatched).toBe(false);
  });

  // Invariant 3 is untouched: the SAME event after the first token is terminal, and
  // no model is swapped behind bytes the client already has.
  it('a POST-commit carried credit error terminates the stream without swapping', async () => {
    let secondDispatched = false;
    const attempts = [
      streamAttempt('p1', async function* () {
        yield START;
        yield TEXT;
        yield {
          type: 'error',
          error: { type: 'error', message: 'out of credit' },
          diagnostic: { kind: 'insufficient_funds' },
        } as NormalizedStreamEvent;
      }),
      streamAttempt('p2', async function* () {
        secondDispatched = true;
        yield START;
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
    expect(r.kind).toBe('stream'); // committed on the first token
    if (r.kind !== 'stream') throw new Error('unreachable');
    expect(r.servedIndex).toBe(0);
    const out = await collect(r.frames);
    expect(out).toContain('upstream_error'); // terminal frame, not a silent swap
    expect(secondDispatched).toBe(false);
  });

  // record-route-legs (design D3) + invariant 3: the walker's `sent` and rejection
  // snapshots only READ flags. A committed stream is handed back at its FIRST event —
  // while the upstream still holds the rest — and its frames are byte-identical to the
  // single-attempt commit gate's for the same events.
  it('a committed stream’s frames and commit point are unchanged by the walk-end snapshots', async () => {
    const req = { model: 'x', messages: [], params: {} };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let pulledPastFirst = false;
    const r = await openStreamChain(
      newBreaker(),
      [
        streamAttempt('p1', async function* () {
          throw new ProviderError('rate_limit', 'slow'); // pre-commit: still falls back
        }),
        streamAttempt('p2', async function* () {
          yield START;
          await gate; // the upstream holds everything after its first event
          pulledPastFirst = true;
          yield TEXT;
          yield STOP;
          yield END;
        }),
      ],
      client,
      req,
      { ...OPTS, signal: new AbortController().signal, isCallerAbort: () => false },
    );
    if (r.kind !== 'stream') throw new Error('expected a committed stream');
    expect(pulledPastFirst).toBe(false); // committed on the first event, not later
    expect(r.servedIndex).toBe(1);
    expect(r.failures.map((f) => f.index)).toEqual([0]);
    expect(r).not.toHaveProperty('ended');
    expect(r).not.toHaveProperty('stopped');
    release();
    const out = await collect(r.frames);
    const ref = await openStream(
      providerFrom(async function* () {
        yield START;
        yield TEXT;
        yield STOP;
        yield END;
      }),
      client,
      req,
      OPTS,
    );
    if (ref.kind !== 'stream') throw new Error('expected a committed stream');
    expect(out).toBe(await collect(ref.frames));
    expect((await r.outcome).status).toBe('success');
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

describe('output-cap clamps + walk-stop boundaries (add-output-cap-guardrails)', () => {
  const client = getAdapter('openai');
  const newBreaker = (threshold = 5): CircuitBreaker =>
    new CircuitBreaker(new InMemoryBreakerStore(), {
      config: { ...DEFAULT_BREAKER_CONFIG, threshold },
    });
  const ok = (): NormalizedResponse => ({
    id: 'r',
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'stop',
  });
  const capAttempt = (
    providerId: string,
    externalModelId: string,
    chat: (req: { params: { maxOutputTokens?: number } }) => Promise<NormalizedResponse>,
    maxOutputTokens?: number,
  ): ChainAttempt => ({
    providerId,
    externalModelId,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
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
  const REQ = { model: 'x', messages: [], params: { maxOutputTokens: 100_000 } };

  it('a clamped attempt dispatches ITS OWN cap; an unclamped attempt passes the ask verbatim', async () => {
    const seen: (number | undefined)[] = [];
    const record = (req: { params: { maxOutputTokens?: number } }) => {
      seen.push(req.params.maxOutputTokens);
      return Promise.reject(new ProviderError('rate_limit', 'next'));
    };
    const attempts = [
      capAttempt('p1', 'head', record),
      capAttempt('p2', 'tail-a', record, 4_096),
      capAttempt(
        'p3',
        'tail-b',
        (req) => {
          seen.push(req.params.maxOutputTokens);
          return Promise.resolve(ok());
        },
        16_384,
      ),
    ];
    const r = await runBufferedChain(
      newBreaker(),
      attempts,
      client,
      REQ,
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([100_000, 4_096, 16_384]); // verbatim head, per-member tail clamps
    for (const f of r.ok ? r.failures : []) expect(f.dispatched).not.toBe(false);
  });

  // fix-bad-request-dead-end INVERTS this: the retained dead end add-output-cap-
  // guardrails recorded ("the tail is NOT consulted") is closed. An unknown-cap head
  // member whose provider rejects the oversized value now falls back, so the clamped
  // tail CAN serve what the head could not — and nothing inspected the rejection body
  // to get there, which is what the original deferral was protecting against.
  it('a head bad_request now reaches the clamped tail, which serves', async () => {
    let tailCalled = false;
    const attempts = [
      capAttempt('p1', 'head', () =>
        Promise.reject(new ProviderError('bad_request', 'cap too big')),
      ),
      capAttempt(
        'p2',
        'tail',
        () => {
          tailCalled = true;
          return Promise.resolve(ok());
        },
        16_384,
      ),
    ];
    const r = await runBufferedChain(
      newBreaker(),
      attempts,
      client,
      REQ,
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(true);
    expect(tailCalled).toBe(true);
    if (r.ok) expect(r.servedIndex).toBe(1);
  });

  // …while the OTHER two stops still hold at the same boundary: deferral never turns a
  // non-retryable stop into a tail consultation, whichever kind produced it.
  it.each(['policy_block', 'oversized_response'] as const)(
    'a head %s still stops the walk — the clamped tail is NOT consulted',
    async (kind) => {
      let tailCalled = false;
      const attempts = [
        capAttempt('p1', 'head', () => Promise.reject(new ProviderError(kind, 'stop'))),
        capAttempt(
          'p2',
          'tail',
          () => {
            tailCalled = true;
            return Promise.resolve(ok());
          },
          16_384,
        ),
      ];
      const r = await runBufferedChain(
        newBreaker(),
        attempts,
        client,
        REQ,
        { created: 1 },
        new AbortController().signal,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe(kind);
      expect(tailCalled).toBe(false);
    },
  );

  it('a client cancellation stops the walk — no tail, callerAborted', async () => {
    let tailCalled = false;
    const attempts = [
      capAttempt('p1', 'head', () => Promise.reject(new CallCancelledError())),
      capAttempt(
        'p2',
        'tail',
        () => {
          tailCalled = true;
          return Promise.resolve(ok());
        },
        16_384,
      ),
    ];
    const r = await runBufferedChain(
      newBreaker(),
      attempts,
      client,
      REQ,
      { created: 1, isCallerAbort: () => true },
      new AbortController().signal,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.callerAborted).toBe(true);
    expect(tailCalled).toBe(false);
  });

  it('a circuit-open head skip flows to the clamped tail and is marked dispatched:false', async () => {
    const attempts = [
      capAttempt('p1', 'head-a', () => Promise.reject(new ProviderError('unavailable', 'down'))),
      // Same provider: the threshold-1 breaker is now open — skipped without dispatch.
      capAttempt('p1', 'head-b', () => Promise.reject(new Error('never built'))),
      capAttempt(
        'p2',
        'tail',
        (req) => {
          expect(req.params.maxOutputTokens).toBe(16_384);
          return Promise.resolve(ok());
        },
        16_384,
      ),
    ];
    const r = await runBufferedChain(
      newBreaker(1),
      attempts,
      client,
      REQ,
      { created: 1 },
      new AbortController().signal,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.servedIndex).toBe(2);
      expect(r.failures.map((f) => f.dispatched)).toEqual([true, false]); // real failure vs circuit skip
    }
  });

  it('streaming: a pre-commit retryable head failure reaches the clamped tail; the clamp rides the stream request', async () => {
    const seen: (number | undefined)[] = [];
    const failing: ChainAttempt = {
      providerId: 'p1',
      externalModelId: 'head',
      buildAdapter: () =>
        Promise.resolve({
          protocol: 'openai_compatible',
          chat: () => Promise.reject(new Error('unused')),
          chatStream: async function* (req: { params: { maxOutputTokens?: number } }) {
            seen.push(req.params.maxOutputTokens);
            throw new ProviderError('rate_limit', 'pre-commit');
          },
          listModels: () => Promise.resolve([]),
          testConnection: () => Promise.resolve({ ok: true, models: 0 }),
        } as unknown as ProviderAdapter),
    };
    const clamped: ChainAttempt = {
      providerId: 'p2',
      externalModelId: 'tail',
      maxOutputTokens: 8_192,
      buildAdapter: () =>
        Promise.resolve({
          protocol: 'openai_compatible',
          chat: () => Promise.reject(new Error('unused')),
          chatStream: async function* (req: { params: { maxOutputTokens?: number } }) {
            seen.push(req.params.maxOutputTokens);
            yield START;
            yield TEXT;
            yield STOP;
            yield END;
          },
          listModels: () => Promise.resolve([]),
          testConnection: () => Promise.resolve({ ok: true, models: 0 }),
        } as unknown as ProviderAdapter),
    };
    const r = await openStreamChain(newBreaker(), [failing, clamped], client, REQ, {
      ...OPTS,
      signal: new AbortController().signal,
    });
    expect(r.kind).toBe('stream');
    if (r.kind === 'stream') {
      await collect(r.frames);
      expect(r.servedIndex).toBe(1);
      expect(r.failures[0]?.dispatched).toBe(true);
    }
    expect(seen).toEqual([100_000, 8_192]);
  });
});

// ---------------------------------------------------------------------------
// Billing evidence (zero-cost-unbilled-errors). The chain walkers classify each
// attempt at the catch boundary where the RAW error is still visible, so a request
// no provider ran can later be recorded as not billed. These pin the D1 table, the
// terminal-evidence rules, and — through the REAL producers, not hand-built errors
// — that no locally synthesized failure ever carries an upstream status.
// ---------------------------------------------------------------------------

describe('attemptBilling — design D1 table (zero-cost-unbilled-errors)', () => {
  const flattened = (): ProviderError =>
    new ProviderError('unavailable', 'upstream request failed');

  it('a circuit-open skip is not_sent', () => {
    expect(attemptBilling(new ProviderCircuitOpenError('p1'), flattened())).toBe('not_sent');
  });

  it('an SSRF refusal is not_sent although its mapped error looks exactly like a timeout', () => {
    const mapped = flattened(); // what toProviderError makes of any non-ProviderError throw
    expect(mapped.status).toBeUndefined();
    expect(
      attemptBilling(new SsrfError('blocked_ip', 'resolves to a blocked address'), mapped),
    ).toBe('not_sent');
    // The same mapped error WITHOUT the raw SSRF class is an unknown failure — the raw
    // class is the only discriminator, which is why classification lives at the catch.
    expect(attemptBilling(new Error('socket hang up'), mapped)).toBe('uncertain');
  });

  it('a credential-kind failure is not_sent, with or without a status', () => {
    const bare = new ProviderError('credential', 'reauthorize required');
    const withStatus = new ProviderError('credential', 'idp unavailable', { status: 503 });
    expect(attemptBilling(bare, bare)).toBe('not_sent');
    expect(attemptBilling(withStatus, withStatus)).toBe('not_sent');
  });

  it('a caller cancel is uncertain — an attempt was in flight', () => {
    expect(attemptBilling(new CallCancelledError(), flattened())).toBe('uncertain');
    // The raw class outranks the status rule: a cancel is never read as a provider answer,
    // even if a mapped shape ever carried a status alongside it.
    const odd = new ProviderError('unavailable', 'x', { status: 499 });
    expect(attemptBilling(new CallCancelledError(), odd)).toBe('uncertain');
  });

  it.each([
    [429, 'rate_limit'],
    [400, 'bad_request'],
    [503, 'unavailable'],
    [451, 'policy_block'],
    [401, 'auth'],
    [402, 'insufficient_funds'],
    [404, 'unavailable'],
  ] as const)('an upstream %s response is rejected', (status, kind) => {
    const e = classifyResponse(status, '');
    expect(e.status).toBe(status);
    expect(e.kind).toBe(kind);
    expect(attemptBilling(e, e)).toBe('rejected');
  });

  it('a 3xx redirect refusal (status-bearing, as providers/http.ts builds it) is rejected', () => {
    const e = new ProviderError('unavailable', 'provider redirected (302)', { status: 302 });
    expect(attemptBilling(e, e)).toBe('rejected');
  });

  // The status decides, never the kind: every kind WITHOUT a status is a local or
  // transport failure the provider may still be running, and every kind WITH one is
  // an answered rejection. Iterating the canonical list means a new kind cannot slip in.
  it.each(PROVIDER_ERROR_KINDS)(
    'kind %s: status-less is uncertain, status-bearing is rejected',
    (kind) => {
      const bare = new ProviderError(kind, 'x');
      const answered = new ProviderError(kind, 'x', { status: 500 });
      if (kind === 'credential') {
        expect(attemptBilling(bare, bare)).toBe('not_sent');
        expect(attemptBilling(answered, answered)).toBe('not_sent');
        return;
      }
      expect(attemptBilling(bare, bare)).toBe('uncertain');
      expect(attemptBilling(answered, answered)).toBe('rejected');
    },
  );

  it('an unrecognised raw throw is uncertain', () => {
    expect(attemptBilling(new TypeError('boom'), flattened())).toBe('uncertain');
    expect(
      attemptBilling(Object.assign(new Error('aborted'), { name: 'AbortError' }), flattened()),
    ).toBe('uncertain');
  });
});

describe('chainBillingEvidence', () => {
  const failure = (index: number, billing?: AttemptBilling): AttemptFailure => ({
    index,
    error: new ProviderError('unavailable', 'x'),
    ...(billing !== undefined ? { billing } : {}),
  });

  it('lists every pushed failure in order, then the terminal attempt', () => {
    expect(
      chainBillingEvidence({
        failures: [failure(0, 'rejected'), failure(1, 'not_sent'), failure(2, 'uncertain')],
        terminalBilling: 'rejected',
      }),
    ).toEqual(['rejected', 'not_sent', 'uncertain', 'rejected']);
  });

  it('adds nothing when no terminal evidence is present', () => {
    expect(
      chainBillingEvidence({ failures: [failure(0, 'not_sent'), failure(1, 'rejected')] }),
    ).toEqual(['not_sent', 'rejected']);
    expect(chainBillingEvidence({ failures: [] })).toEqual([]);
  });

  // Fail-safe: a failure built without a class must not vanish from the evidence — it
  // reads as uncertain, so the walk can only be billed, never wrongly zeroed.
  it('reads a failure that carries no class as uncertain (never drops it)', () => {
    const evidence = chainBillingEvidence({
      failures: [failure(0, 'rejected'), failure(1), failure(2, 'not_sent')],
    });
    expect(evidence).toEqual(['rejected', 'uncertain', 'not_sent']);
    expect(walkUnbilled(evidence)).toBe(false);
  });
});

type WalkMode = 'buffered' | 'stream';

interface Walked {
  readonly error: ProviderError;
  readonly failures: readonly AttemptFailure[];
  readonly terminalBilling: AttemptBilling | undefined;
  readonly callerAborted: boolean;
}

interface WalkOptions {
  readonly signal?: AbortSignal;
  readonly isCallerAbort?: () => boolean;
  readonly firstEventTimeoutMs?: number;
}

/** Run one chain through the walker under test and return its (necessarily error)
 * result in a mode-neutral shape, so every billing case runs against BOTH walkers. */
async function walkChain(
  mode: WalkMode,
  attempts: readonly ChainAttempt[],
  over: WalkOptions = {},
): Promise<Walked> {
  // Threshold 1: a tripping failure opens its provider, so a later member of the
  // SAME provider is a genuine circuit-open skip raised by the real breaker.
  const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
    config: { ...DEFAULT_BREAKER_CONFIG, threshold: 1 },
  });
  const client = getAdapter('openai');
  const req = { model: 'x', messages: [], params: {} };
  const signal = over.signal ?? new AbortController().signal;
  const isCallerAbort = over.isCallerAbort;
  if (mode === 'buffered') {
    const r = await runBufferedChain(
      breaker,
      attempts,
      client,
      req,
      { created: 1, ...(isCallerAbort !== undefined ? { isCallerAbort } : {}) },
      signal,
    );
    if (r.ok) throw new Error('expected the walk to fail');
    return {
      error: r.error,
      failures: r.failures,
      terminalBilling: r.terminalBilling,
      callerAborted: r.callerAborted,
    };
  }
  const r = await openStreamChain(breaker, attempts, client, req, {
    firstEventTimeoutMs: over.firstEventTimeoutMs ?? 1000,
    created: 1,
    signal,
    ...(isCallerAbort !== undefined ? { isCallerAbort } : {}),
  });
  if (r.kind === 'stream') throw new Error('expected the walk to fail');
  return {
    error: r.error,
    failures: r.failures,
    terminalBilling: r.terminalBilling,
    callerAborted: r.callerAborted,
  };
}

/** A member that fails with `fault` (a value, or a thunk run at dispatch time) — and,
 * for `SKIP`, one that must never be built because its provider's circuit is open. */
const SKIP = Symbol('circuit-open skip');
type Fault = Error | (() => Error) | typeof SKIP;

function faultAttempt(providerId: string, fault: Fault): ChainAttempt {
  const fail = (): Promise<never> => {
    if (fault === SKIP) return Promise.reject(new Error('a skipped member must never be built'));
    return Promise.reject(typeof fault === 'function' ? fault() : fault);
  };
  return {
    providerId,
    externalModelId: providerId,
    buildAdapter: () =>
      fault === SKIP
        ? fail()
        : Promise.resolve({
            protocol: 'openai_compatible',
            chat: fail,
            chatStream: async function* () {
              await fail();
            },
            listModels: () => Promise.resolve([]),
            testConnection: () => Promise.resolve({ ok: true, models: 0 }),
          } as unknown as ProviderAdapter),
  };
}

/** Members named p0, p1, …; a SKIP reuses the PREVIOUS member's provider so the
 * breaker (threshold 1) that member just tripped actually skips it. */
function faultChain(faults: readonly Fault[]): ChainAttempt[] {
  const ids: string[] = [];
  faults.forEach((f, i) => ids.push(f === SKIP ? ids[i - 1]! : `p${String(i)}`));
  return faults.map((f, i) => faultAttempt(ids[i]!, f));
}

describe.each(['buffered', 'stream'] as const)(
  'billing evidence on the %s chain walker (zero-cost-unbilled-errors)',
  (mode) => {
    const rate429 = (): ProviderError => classifyResponse(429, '');
    const unavail503 = (): ProviderError => classifyResponse(503, '');
    const bad400 = (): ProviderError => classifyResponse(400, '');
    const credential = (): ProviderError => new ProviderError('credential', 'reauthorize required');
    const eventTimeout = (): ProviderError =>
      new ProviderError('unavailable', 'upstream event timeout');
    const network = (): ProviderError =>
      classifyNetworkError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );

    interface Case {
      readonly name: string;
      readonly faults: readonly Fault[];
      /** `billing` of each pushed failure, in order. */
      readonly billing: readonly AttemptBilling[];
      /** `dispatched` of each pushed failure — must be unchanged by this change. */
      readonly dispatched: readonly boolean[];
      readonly terminal?: AttemptBilling;
      readonly unbilled: boolean;
    }

    const cases: readonly Case[] = [
      {
        name: 'an uncertain FIRST member keeps the walk billed',
        faults: [network(), rate429(), credential()],
        billing: ['uncertain', 'rejected', 'not_sent'],
        dispatched: [true, true, true],
        unbilled: false,
      },
      {
        name: 'an uncertain MIDDLE member keeps the walk billed',
        faults: [rate429(), eventTimeout(), unavail503()],
        billing: ['rejected', 'uncertain', 'rejected'],
        dispatched: [true, true, true],
        unbilled: false,
      },
      {
        name: 'an uncertain LAST member keeps the walk billed',
        faults: [rate429(), bad400(), eventTimeout()],
        billing: ['rejected', 'rejected', 'uncertain'],
        dispatched: [true, true, true],
        unbilled: false,
      },
      {
        name: 'rejections, a circuit skip and a credential failure fold to unbilled',
        faults: [unavail503(), SKIP, rate429(), credential()],
        billing: ['rejected', 'not_sent', 'rejected', 'not_sent'],
        dispatched: [true, false, true, true],
        unbilled: true,
      },
      {
        name: 'a lone credential failure is not_sent with no terminal evidence',
        faults: [credential()],
        billing: ['not_sent'],
        dispatched: [true],
        unbilled: true,
      },
      {
        name: 'a non-retryable 451 stop carries its class and never enters failures',
        faults: [rate429(), SKIP, classifyResponse(451, '')],
        billing: ['rejected', 'not_sent'],
        dispatched: [true, false],
        terminal: 'rejected',
        unbilled: true,
      },
      {
        name: 'a non-retryable oversized_response (no status) is an uncertain terminal',
        faults: [rate429(), new ProviderError('oversized_response', 'body exceeds the cap')],
        billing: ['rejected'],
        dispatched: [true],
        terminal: 'uncertain',
        unbilled: false,
      },
      {
        name: 'an in-flight caller cancel (CallCancelledError) is an uncertain terminal',
        faults: [unavail503(), rate429(), new CallCancelledError()],
        billing: ['rejected', 'rejected'],
        dispatched: [true, true],
        terminal: 'uncertain',
        unbilled: false,
      },
      {
        name: 'an SSRF refusal at a later position is a not_sent terminal',
        faults: [
          unavail503(),
          rate429(),
          new SsrfError('blocked_ip', 'resolves to a blocked address'),
        ],
        billing: ['rejected', 'rejected'],
        dispatched: [true, true],
        terminal: 'not_sent',
        unbilled: true,
      },
      {
        name: 'an unrecognised raw throw is an uncertain terminal',
        faults: [rate429(), new TypeError('boom')],
        billing: ['rejected'],
        dispatched: [true],
        terminal: 'uncertain',
        unbilled: false,
      },
    ];

    it.each(cases)('$name', async (c) => {
      const w = await walkChain(mode, faultChain(c.faults));
      expect(w.failures.map((f) => f.billing)).toEqual(c.billing);
      expect(w.failures.map((f) => f.dispatched)).toEqual(c.dispatched);
      expect(w.terminalBilling).toBe(c.terminal);
      expect(walkUnbilled(chainBillingEvidence(w))).toBe(c.unbilled);
    });

    it('an SSRF terminal maps to a status-less `unavailable` — only the raw class made it not_sent', async () => {
      const w = await walkChain(
        mode,
        faultChain([rate429(), new SsrfError('not_https', 'http is only allowed here')]),
      );
      expect(w.error.kind).toBe('unavailable');
      expect(w.error.status).toBeUndefined();
      expect(w.terminalBilling).toBe('not_sent');
    });

    it('a non-retryable stop leaves the terminal attempt out of failures', async () => {
      const w = await walkChain(mode, faultChain([rate429(), SKIP, classifyResponse(451, '')]));
      expect(w.failures.map((f) => f.index)).toEqual([0, 1]); // the 451 at index 2 is the terminal
      expect(w.error.kind).toBe('policy_block');
    });

    it('an empty chain carries not_sent as its terminal evidence', async () => {
      const w = await walkChain(mode, []);
      expect(w.failures).toEqual([]);
      expect(w.error.message).toBe('no chain members');
      expect(w.terminalBilling).toBe('not_sent');
      expect(chainBillingEvidence(w)).toEqual(['not_sent']);
      expect(walkUnbilled(chainBillingEvidence(w))).toBe(true);
    });

    it('an abort before the first member dispatches carries not_sent', async () => {
      const gone = new AbortController();
      gone.abort();
      let dispatched = false;
      const w = await walkChain(
        mode,
        [
          faultAttempt('p0', () => {
            dispatched = true;
            return new Error('must not dispatch');
          }),
        ],
        { signal: gone.signal, isCallerAbort: () => true },
      );
      expect(dispatched).toBe(false);
      expect(w.callerAborted).toBe(true);
      expect(w.failures).toEqual([]);
      expect(w.terminalBilling).toBe('not_sent');
      expect(walkUnbilled(chainBillingEvidence(w))).toBe(true);
    });

    // The abort lands DURING member 1 (of 3), after it already failed: the next member
    // is never dispatched, so the stop itself is not_sent — and the executed members
    // still count, in their own classes.
    it.each([
      ['a client abort', true],
      ['a cheap-tier deadline abort', false],
    ] as const)(
      '%s before the NEXT member dispatches carries not_sent after the executed ones',
      async (_n, client) => {
        const ac = new AbortController();
        let third = false;
        const w = await walkChain(
          mode,
          [
            faultAttempt('p0', rate429()),
            faultAttempt('p1', () => {
              ac.abort();
              return unavail503();
            }),
            faultAttempt('p2', () => {
              third = true;
              return new Error('must not dispatch');
            }),
          ],
          { signal: ac.signal, isCallerAbort: () => client },
        );
        expect(third).toBe(false);
        expect(w.callerAborted).toBe(client);
        expect(w.failures.map((f) => f.billing)).toEqual(['rejected', 'rejected']);
        expect(w.terminalBilling).toBe('not_sent');
        expect(chainBillingEvidence(w)).toEqual(['rejected', 'rejected', 'not_sent']);
        expect(walkUnbilled(chainBillingEvidence(w))).toBe(true);
      },
    );

    it('an abort after an UNCERTAIN member still folds billed', async () => {
      const ac = new AbortController();
      const w = await walkChain(
        mode,
        [
          faultAttempt('p0', () => {
            ac.abort();
            return eventTimeout();
          }),
          faultAttempt('p1', new Error('must not dispatch')),
        ],
        { signal: ac.signal, isCallerAbort: () => true },
      );
      // record-route-legs (design D3): the status-less member the client left in flight is
      // an in-flight cancel — not a failure entry; its class rides `terminalBilling` and the
      // walk ends at once (was `['uncertain', 'not_sent']`). Billed either way.
      expect(w.failures).toEqual([]);
      expect(chainBillingEvidence(w)).toEqual(['uncertain']);
      expect(walkUnbilled(chainBillingEvidence(w))).toBe(false);
    });
  },
);

// The synthesized "cancelled" error the loop-start abort returns has no attempt behind
// it: it is classified by the terminal rule, not by its (status-less) shape.
describe('the loop-start cancelled error is local (zero-cost-unbilled-errors)', () => {
  it.each(['buffered', 'stream'] as const)('%s: carries no status', async (mode) => {
    const gone = new AbortController();
    gone.abort();
    const w = await walkChain(mode, [faultAttempt('p0', new Error('unused'))], {
      signal: gone.signal,
      isCallerAbort: () => true,
    });
    expect(w.error.message).toBe('cancelled');
    expect(w.error.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The invariant this change leans on: a status exists ONLY when the provider
// answered. Every locally synthesized failure below is produced by its REAL source
// (core, the adapter, the guarded client) — not a hand-built look-alike — so a
// future local error that gains a status flips a row here instead of silently
// zeroing a request that a provider may have billed.
// ---------------------------------------------------------------------------

describe('locally synthesized failures stay uncertain; provider answers are rejected (zero-cost-unbilled-errors)', () => {
  const REAL_CFG = {
    protocol: 'openai_compatible' as const,
    baseUrl: 'https://api.openai.example/v1',
    credential: 'sk-test',
    kind: 'api_key' as const,
    mode: 'cloud' as const,
    firstByteTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
  };
  const realAttempt = (
    providerId: string,
    httpClient: HttpClient,
    over: Partial<ProviderConfig> = {},
  ): ChainAttempt => ({
    providerId,
    externalModelId: 'm',
    buildAdapter: () =>
      Promise.resolve(createOpenaiProviderAdapter({ ...REAL_CFG, ...over }, { httpClient })),
  });

  const neverHeaders: HttpClient = (_url, init) =>
    new Promise((_resolve, reject) => {
      const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener('abort', abort, { once: true });
    });

  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const bodyResponse = (body: ReadableStream<Uint8Array>): HttpResponse => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({}),
  });
  /** 200 headers, one chunk, then silence — a wedged body. Honors the abort the way
   * undici does (the read errors), so a watchdog that fires can actually unwind. */
  const stalledBody: HttpClient = (_url, init) => {
    let sent = false;
    return Promise.resolve(
      bodyResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const onAbort = (): void =>
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (init.signal?.aborted) onAbort();
            else init.signal?.addEventListener('abort', onAbort, { once: true });
          },
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(enc('{"partial":'));
              return undefined;
            }
            return new Promise<void>(() => {});
          },
        }),
      ),
    );
  };
  const oversizedBody: HttpClient = () => {
    let i = 0;
    return Promise.resolve(
      bodyResponse(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i < 10) {
              controller.enqueue(enc('x'.repeat(20)));
              i += 1;
            } else controller.close();
          },
        }),
      ),
    );
  };
  const connectionRefused: HttpClient = () =>
    Promise.reject(
      Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:443'), { code: 'ECONNREFUSED' }),
    );

  interface Setup {
    readonly attempts: readonly ChainAttempt[];
    readonly over?: WalkOptions;
  }
  interface LocalRow {
    readonly name: string;
    readonly modes: readonly WalkMode[];
    readonly setup: (mode: WalkMode) => Setup;
    readonly message?: RegExp;
  }

  const streamGen = (
    providerId: string,
    gen: (req: unknown, ctx?: { signal?: AbortSignal }) => AsyncGenerator<NormalizedStreamEvent>,
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

  const rows: readonly LocalRow[] = [
    {
      name: 'a first-byte timeout (adapter)',
      modes: ['buffered', 'stream'],
      setup: () => ({ attempts: [realAttempt('p0', neverHeaders, { firstByteTimeoutMs: 40 })] }),
      message: /first-byte/,
    },
    {
      name: 'a first-event timeout (core)',
      modes: ['stream'],
      setup: () => ({
        attempts: [
          streamGen('p0', async function* (_req: unknown, ctx?: { signal?: AbortSignal }) {
            // Never yields; core's watchdog must fire, then unwind through the abort.
            await new Promise<void>((resolve) => {
              if (ctx?.signal?.aborted) return resolve();
              ctx?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          }),
        ],
        over: { firstEventTimeoutMs: 40 },
      }),
      message: /upstream event timeout/,
    },
    {
      name: 'a buffered body idle timeout (adapter)',
      modes: ['buffered'],
      setup: () => ({ attempts: [realAttempt('p0', stalledBody, { idleTimeoutMs: 40 })] }),
      message: /idle timeout/,
    },
    {
      // The streamed body has no adapter idle guard pre-first-token; core's watchdog owns it.
      name: 'a wedged 200 stream body (core watchdog over the real adapter)',
      modes: ['stream'],
      setup: () => ({
        attempts: [realAttempt('p0', stalledBody)],
        over: { firstEventTimeoutMs: 60 },
      }),
      message: /upstream event timeout/,
    },
    {
      name: 'upstream produced no output (core)',
      modes: ['stream'],
      setup: () => ({
        attempts: [
          streamGen('p0', async function* () {
            /* ends without a single event */
          }),
        ],
      }),
      message: /produced no output/,
    },
    {
      name: 'oversized_response (transport drain)',
      modes: ['buffered'],
      setup: () => ({ attempts: [realAttempt('p0', oversizedBody, { maxResponseBytes: 64 })] }),
      message: /exceeds/,
    },
    {
      name: 'a network fault',
      modes: ['buffered', 'stream'],
      setup: () => ({ attempts: [realAttempt('p0', connectionRefused)] }),
      message: /provider connection failed/,
    },
    {
      name: 'a pre-first-token in-stream error event',
      modes: ['stream'],
      setup: () => ({
        attempts: [
          streamGen('p0', async function* () {
            yield { type: 'error', error: { type: 'overloaded', message: 'try later' } };
          }),
        ],
      }),
    },
    {
      name: 'a pre-first-token in-stream error event carrying a provider kind',
      modes: ['stream'],
      setup: () => ({
        attempts: [
          streamGen('p0', async function* () {
            yield {
              type: 'error',
              error: { type: 'error', message: 'out of credit' },
              diagnostic: { kind: 'insufficient_funds' },
            } as NormalizedStreamEvent;
          }),
        ],
      }),
    },
    {
      name: 'a client cancel while the attempt is in flight',
      modes: ['buffered', 'stream'],
      setup: () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 25);
        return {
          attempts: [realAttempt('p0', neverHeaders)],
          over: { signal: ac.signal, isCallerAbort: () => ac.signal.aborted },
        };
      },
    },
  ];

  describe.each(['buffered', 'stream'] as const)('%s walker', (mode) => {
    it.each(rows.filter((r) => r.modes.includes(mode)))('$name is uncertain', async (row) => {
      const { attempts, over } = row.setup(mode);
      // The failing member sits at an UNEQUAL position (behind a rejected one), so a
      // classifier that only ever looks at the head of the chain cannot pass.
      const chain = [faultAttempt('pre', classifyResponse(429, '')), ...attempts];
      const w = await walkChain(mode, chain, over);
      expect(w.error.status).toBeUndefined(); // synthesized locally: no upstream status
      if (row.message !== undefined) expect(w.error.message).toMatch(row.message);
      const evidence = chainBillingEvidence(w);
      expect(evidence).toEqual(['rejected', 'uncertain']);
      expect(walkUnbilled(evidence)).toBe(false);
      for (const f of w.failures) expect(f.dispatched).toBe(true);
    });

    // The EXCEPTIONS: local, and provably never sent — each stamped by the walker, not
    // inferred from the (status-less) error shape.
    it('an SSRF refusal by the real guarded client is not_sent', async () => {
      const guarded = createGuardedHttpClient({ mode: 'cloud', providerKind: 'api_key' });
      const w = await walkChain(mode, [
        faultAttempt('pre', classifyResponse(503, '')),
        realAttempt('p1', guarded, { baseUrl: 'http://10.0.0.1/v1' }),
      ]);
      expect(w.error.status).toBeUndefined();
      expect(chainBillingEvidence(w)).toEqual(['rejected', 'not_sent']);
      expect(walkUnbilled(chainBillingEvidence(w))).toBe(true);
    });

    it('an empty chain and a loop-start cancel are not_sent', async () => {
      const empty = await walkChain(mode, []);
      expect(empty.error.status).toBeUndefined();
      expect(chainBillingEvidence(empty)).toEqual(['not_sent']);
    });

    // A status exists only when the provider ANSWERED: real adapter, real
    // classifyResponse. 451 stops the walk (terminal); the rest walk on (failures).
    it.each([429, 400, 503, 451, 401, 402])(
      'an upstream %s response is rejected',
      async (status) => {
        const answered: HttpClient = () =>
          Promise.resolve(errorResponse(status, JSON.stringify({ error: { message: 'nope' } })));
        const w = await walkChain(mode, [
          faultAttempt('pre', network()),
          realAttempt('p1', answered),
        ]);
        expect(w.error.status).toBe(status);
        expect(chainBillingEvidence(w)).toEqual(['uncertain', 'rejected']);
        expect(w.terminalBilling === 'rejected').toBe(status === 451);
      },
    );
  });

  function network(): ProviderError {
    return classifyNetworkError(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
  }

  describe('a real 3xx redirect refusal', () => {
    let server: http.Server;
    let port = 0;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(302, { location: 'http://elsewhere.example/v1/chat/completions' });
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it.each(['buffered', 'stream'] as const)(
      '%s: carries the 3xx status and is rejected',
      async (mode) => {
        const guarded = createGuardedHttpClient({ mode: 'selfhosted', providerKind: 'local' });
        const w = await walkChain(mode, [
          faultAttempt('pre', network()),
          realAttempt('p1', guarded, {
            kind: 'local',
            mode: 'selfhosted',
            baseUrl: `http://127.0.0.1:${String(port)}/v1`,
          }),
        ]);
        expect(w.error.status).toBe(302);
        expect(chainBillingEvidence(w)).toEqual(['uncertain', 'rejected']);
      },
    );
  });
});

// --- plan cooldown skip (classify-plan-quota-errors, design D8) ---

/** A cooldown store that counts every call, over the real in-memory contract. */
class SpyPlanStore implements PlanCooldownStore {
  readonly inner: InMemoryPlanCooldownStore;
  readonly calls = { check: 0, checkMany: 0, record: 0, lift: 0 };
  readonly recorded: PlanCooldownInput[] = [];
  constructor(now: () => number = () => Date.now()) {
    this.inner = new InMemoryPlanCooldownStore(now);
  }
  check(id: string): Promise<PlanCooldown | null> {
    this.calls.check += 1;
    return this.inner.check(id);
  }
  checkMany(ids: readonly string[]): Promise<ReadonlyMap<string, PlanCooldown | null>> {
    this.calls.checkMany += 1;
    return this.inner.checkMany(ids);
  }
  record(id: string, input: PlanCooldownInput): Promise<PlanCooldown> {
    this.calls.record += 1;
    this.recorded.push(input);
    return this.inner.record(id, input);
  }
  lift(id: string): Promise<void> {
    this.calls.lift += 1;
    return this.inner.lift(id);
  }
}

const quota429 = (): ProviderError =>
  new ProviderError('quota_exhausted', 'Usage limit reached', {
    status: 429,
    planReset: { window: 'short' },
  });

describe.each(['buffered', 'stream'] as const)(
  'the plan cooldown skip on the %s chain walker',
  (mode) => {
    interface Probe {
      readonly attempt: ChainAttempt;
      readonly built: () => number;
      readonly served: () => number;
    }
    /** A member that serves, or fails with `fault`, counting builds and calls. */
    const member = (
      providerId: string,
      fault: ProviderError | null,
      flag: boolean,
      model = providerId,
    ): Probe => {
      let built = 0;
      let served = 0;
      const ok: NormalizedResponse = {
        id: 'r',
        model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
      };
      const attempt: ChainAttempt = {
        providerId,
        externalModelId: model,
        ...(flag ? { planCooldown: true as const } : {}),
        buildAdapter: () => {
          built += 1;
          return Promise.resolve({
            protocol: 'openai_compatible',
            chat: () => {
              if (fault) return Promise.reject(fault);
              served += 1;
              return Promise.resolve(ok);
            },
            chatStream: async function* () {
              if (fault) throw fault;
              served += 1;
              yield START;
              yield TEXT;
              yield STOP;
              yield END;
            },
            listModels: () => Promise.resolve([]),
            testConnection: () => Promise.resolve({ ok: true, models: 0 }),
          } as unknown as ProviderAdapter);
        },
      };
      return { attempt, built: () => built, served: () => served };
    };

    interface Walk {
      readonly ok: boolean;
      readonly servedIndex?: number;
      readonly error?: ProviderError;
      readonly failures: readonly AttemptFailure[];
      readonly terminalBilling?: AttemptBilling | undefined;
    }
    async function walk(breaker: CircuitBreaker, attempts: readonly ChainAttempt[]): Promise<Walk> {
      const client = getAdapter('openai');
      const req = { model: 'x', messages: [], params: {} };
      if (mode === 'buffered') {
        const r = await runBufferedChain(
          breaker,
          attempts,
          client,
          req,
          { created: 1 },
          new AbortController().signal,
        );
        return r.ok
          ? { ok: true, servedIndex: r.servedIndex, failures: r.failures }
          : { ok: false, error: r.error, failures: r.failures, terminalBilling: r.terminalBilling };
      }
      const r = await openStreamChain(breaker, attempts, client, req, OPTS);
      if (r.kind === 'stream') {
        await collect(r.frames);
        return { ok: true, servedIndex: r.servedIndex, failures: r.failures };
      }
      return {
        ok: false,
        error: r.error,
        failures: r.failures,
        terminalBilling: r.terminalBilling,
      };
    }

    const breakerOn = (store: PlanCooldownStore, now?: () => number): CircuitBreaker =>
      new CircuitBreaker(new InMemoryBreakerStore(), {
        planCooldowns: store,
        ...(now ? { now } : {}),
      });

    it('records an answered quota failure and serves the next member', async () => {
      const store = new SpyPlanStore();
      const z = member('z', quota429(), true);
      const pay = member('pay', null, false);
      const w = await walk(breakerOn(store), [z.attempt, pay.attempt]);
      expect(w.ok).toBe(true);
      expect(w.servedIndex).toBe(1);
      expect(w.failures[0]!.error.kind).toBe('quota_exhausted');
      expect(w.failures[0]!.skip).toBeUndefined();
      expect(w.failures[0]!.dispatched).toBe(true);
      expect(store.calls.record).toBe(1);
      expect((await store.inner.check('z'))?.kind).toBe('quota_exhausted');
    });

    it('skips a paused member with no build and no breaker decide', async () => {
      const store = new SpyPlanStore();
      await store.inner.record('z', { kind: 'quota_exhausted', default: 15 * 60_000 });
      const breaker = breakerOn(store);
      const decide = jest.spyOn(breaker, 'before');
      const z = member('z', quota429(), true);
      const pay = member('pay', null, false);
      const w = await walk(breaker, [z.attempt, pay.attempt]);
      expect(w.ok).toBe(true);
      expect(w.servedIndex).toBe(1);
      expect(z.built()).toBe(0);
      expect(decide.mock.calls.map((c) => c[0])).toEqual(['pay']);
      expect(w.failures).toHaveLength(1);
      expect(w.failures[0]).toMatchObject({
        index: 0,
        dispatched: false,
        skip: 'plan_cooldown',
        billing: 'not_sent',
      });
      expect(w.failures[0]!.error.kind).toBe('quota_exhausted');
      expect(w.failures[0]!.error.status).toBeUndefined();
    });

    it('skips the second member of one provider right after the first fails', async () => {
      const store = new SpyPlanStore();
      const a = member('z', quota429(), true, 'glm-a');
      const b = member('z', null, true, 'glm-b');
      const pay = member('pay', null, false);
      const w = await walk(breakerOn(store), [a.attempt, b.attempt, pay.attempt]);
      expect(w.servedIndex).toBe(2);
      expect(b.built()).toBe(0);
      expect(w.failures.map((f) => f.skip)).toEqual([undefined, 'plan_cooldown']);
      expect(store.calls.record).toBe(1);
    });

    it('an all-paused chain returns the cooldown kind not_sent and never waits', async () => {
      jest.useFakeTimers();
      try {
        const store = new SpyPlanStore();
        await store.inner.record('z', { kind: 'plan_inactive', default: 60 * 60_000 });
        await store.inner.record('y', { kind: 'risk_control', default: 30 * 60_000 });
        const z = member('z', null, true);
        const y = member('y', null, true);
        const w = await walk(breakerOn(store), [z.attempt, y.attempt]);
        expect(w.ok).toBe(false);
        expect(w.error!.kind).toBe('risk_control'); // the last skip's kind
        expect(w.error!.status).toBeUndefined();
        expect(w.failures.map((f) => f.billing)).toEqual(['not_sent', 'not_sent']);
        expect(walkUnbilled(w.failures.map((f) => f.billing ?? 'uncertain'))).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        expect(z.built() + y.built()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('a skip never writes: traffic on a paused provider never extends the end', async () => {
      let now = 1_000_000;
      const store = new SpyPlanStore(() => now);
      const first = await store.inner.record('z', {
        kind: 'quota_exhausted',
        default: 15 * 60_000,
      });
      expect(store.calls.record).toBe(0); // the seed went through the inner store
      const breaker = breakerOn(store, () => now);
      const pay = member('pay', null, false);
      // Ten requests, some after `until - default` (the window where a re-record would extend).
      for (let i = 0; i < 10; i += 1) {
        now = 1_000_000 + Math.floor((i / 9) * (first.until - 1_000_000 - 1_000));
        const z = member('z', quota429(), true);
        const w = await walk(breaker, [z.attempt, pay.attempt]);
        expect(w.failures[0]!.skip).toBe('plan_cooldown');
        expect(z.built()).toBe(0);
      }
      expect(store.calls.record).toBe(0);
      expect(store.recorded).toHaveLength(0);
      expect((await store.inner.check('z'))?.until).toBe(first.until);
    });

    it('an attempt without the flag makes zero cooldown-store calls', async () => {
      const store = new SpyPlanStore();
      await store.inner.record('z', { kind: 'quota_exhausted', default: 15 * 60_000 });
      const before = { ...store.calls };
      const z = member('z', quota429(), false);
      const pay = member('pay', null, false);
      const w = await walk(breakerOn(store), [z.attempt, pay.attempt]);
      // The unflagged member is dispatched despite the stored pause, and its failure records nothing.
      expect(z.built()).toBe(1);
      expect(w.failures[0]!.dispatched).toBe(true);
      expect(store.calls).toEqual(before);
    });

    it('a status-less plan-kind failure from a dispatched member records nothing', async () => {
      const store = new SpyPlanStore();
      const z = member('z', new ProviderError('quota_exhausted', 'no status'), true);
      const pay = member('pay', null, false);
      const w = await walk(breakerOn(store), [z.attempt, pay.attempt]);
      expect(w.servedIndex).toBe(1);
      expect(store.calls.record).toBe(0);
    });

    it('a plan failure leaves the breaker closed however often it settles', async () => {
      const store = new SpyPlanStore();
      const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
        planCooldowns: store,
        config: { ...DEFAULT_BREAKER_CONFIG, threshold: 1 },
      });
      const pay = member('pay', null, false);
      for (let i = 0; i < 4; i += 1) {
        await store.inner.lift('z');
        const z = member('z', quota429(), true);
        await walk(breaker, [z.attempt, pay.attempt]);
        expect(z.built()).toBe(1); // never skipped by the breaker
      }
    });
  },
);

// add-subscription-quota-display (task 3.3): the per-attempt plan-usage callback rides the context
// both walkers build. Each attempt gets only its own; a skip never reaches an adapter.
describe.each(['buffered', 'stream'] as const)(
  'ChainAttempt.onPlanUsage on the %s chain walker',
  (mode) => {
    type Ctx = Parameters<ProviderAdapter['chat']>[1];
    interface Probe {
      readonly attempt: ChainAttempt;
      readonly ctxs: () => readonly Ctx[];
      readonly built: () => number;
    }
    const member = (
      providerId: string,
      fault: ProviderError | null,
      onPlanUsage?: ChainAttempt['onPlanUsage'],
      extra: Partial<ChainAttempt> = {},
    ): Probe => {
      const seen: Ctx[] = [];
      let built = 0;
      const ok: NormalizedResponse = {
        id: 'r',
        model: providerId,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
      };
      const attempt: ChainAttempt = {
        providerId,
        externalModelId: providerId,
        ...(onPlanUsage !== undefined ? { onPlanUsage } : {}),
        ...extra,
        buildAdapter: () => {
          built += 1;
          return Promise.resolve({
            protocol: 'openai_compatible',
            chat: (_req: unknown, ctx: Ctx) => {
              seen.push(ctx);
              return fault ? Promise.reject(fault) : Promise.resolve(ok);
            },
            chatStream: async function* (_req: unknown, ctx: Ctx) {
              seen.push(ctx);
              if (fault) throw fault;
              yield START;
              yield TEXT;
              yield STOP;
              yield END;
            },
            listModels: () => Promise.resolve([]),
            testConnection: () => Promise.resolve({ ok: true, models: 0 }),
          } as unknown as ProviderAdapter);
        },
      };
      return { attempt, ctxs: () => seen, built: () => built };
    };

    async function walk(breaker: CircuitBreaker, attempts: readonly ChainAttempt[]): Promise<void> {
      const client = getAdapter('openai');
      const req = { model: 'x', messages: [], params: {} };
      if (mode === 'buffered') {
        await runBufferedChain(
          breaker,
          attempts,
          client,
          req,
          { created: 1 },
          new AbortController().signal,
        );
        return;
      }
      const r = await openStreamChain(breaker, attempts, client, req, OPTS);
      if (r.kind === 'stream') await collect(r.frames);
    }

    it('gives each attempt only its own callback down a fallback chain', async () => {
      const cbA = jest.fn();
      const cbB = jest.fn();
      const a = member('a', new ProviderError('rate_limit', 'slow'), cbA);
      const b = member('b', null, cbB);
      await walk(new CircuitBreaker(new InMemoryBreakerStore()), [a.attempt, b.attempt]);
      expect(a.ctxs()).toHaveLength(1);
      expect(b.ctxs()).toHaveLength(1);
      expect(a.ctxs()[0]!.onPlanUsage).toBe(cbA);
      expect(b.ctxs()[0]!.onPlanUsage).toBe(cbB);
      expect(cbA).not.toHaveBeenCalled();
      expect(cbB).not.toHaveBeenCalled();
    });

    it('a circuit-open skip invokes none and builds nothing', async () => {
      const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
        config: { threshold: 1, cooldownMs: 60_000, probeLeaseMs: 200, stateTtlMs: 60_000 },
      });
      await walk(breaker, [member('p1', new ProviderError('unavailable', 'down')).attempt]);
      const cb = jest.fn();
      const open = member('p1', null, cb);
      const next = member('p2', null);
      await walk(breaker, [open.attempt, next.attempt]);
      expect(open.built()).toBe(0);
      expect(open.ctxs()).toEqual([]);
      expect(cb).not.toHaveBeenCalled();
      expect(next.ctxs()).toHaveLength(1);
    });

    it('a plan-cooldown skip invokes none and builds nothing', async () => {
      const store = new InMemoryPlanCooldownStore();
      await store.record('z', { kind: 'quota_exhausted', default: 15 * 60_000 });
      const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { planCooldowns: store });
      const cb = jest.fn();
      const z = member('z', null, cb, { planCooldown: true });
      const next = member('p2', null);
      await walk(breaker, [z.attempt, next.attempt]);
      expect(z.built()).toBe(0);
      expect(z.ctxs()).toEqual([]);
      expect(cb).not.toHaveBeenCalled();
      expect(next.ctxs()).toHaveLength(1);
    });

    it('an attempt without the field passes exactly the context it passed before', async () => {
      const a = member('a', null);
      await walk(new CircuitBreaker(new InMemoryBreakerStore()), [a.attempt]);
      const ctx = a.ctxs()[0]!;
      expect(Object.keys(ctx as object).sort()).toEqual(['onBytes', 'signal']);
    });
  },
);
