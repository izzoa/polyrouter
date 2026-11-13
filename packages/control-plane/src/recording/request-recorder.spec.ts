import { userPrincipal } from '@polyrouter/shared/server';
import type { LogWriter, RequestLogDraft } from './log-writer';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { RequestRecorder, type RecordingContext } from './request-recorder';

function makeRecorder(enqueue = jest.fn()): { recorder: RequestRecorder; enqueue: jest.Mock } {
  const writer = { enqueue } as unknown as LogWriter;
  return { recorder: new RequestRecorder(writer, new ProxyMetrics()), enqueue };
}

const ctx = (over: Partial<RecordingContext> = {}): RecordingContext => ({
  principal: userPrincipal('u1'),
  requestId: 'req-1',
  agentId: 'a1',
  protocol: 'openai',
  providerId: 'p1',
  providerName: 'openai',
  modelId: 'm1',
  tierAssigned: 'default',
  decisionLayer: 'default',
  routingReason: 'default tier',
  provider: { baseUrl: 'https://api.openai.com/v1', kind: 'api_key' },
  model: {
    externalModelId: 'gpt-4o',
    inputPricePer1m: null,
    outputPricePer1m: null,
    isFree: false,
    listedInputPricePer1m: null,
    listedOutputPricePer1m: null,
    listedIsFree: null,
  },
  startedAt: Date.now() - 20,
  requestChars: 400,
  ...over,
});

describe('RequestRecorder', () => {
  it('builds a metadata draft from a success outcome (no bodies)', () => {
    const { recorder, enqueue } = makeRecorder();
    recorder.record(ctx(), {
      status: 'success',
      providerUsage: { inputTokens: 30, outputTokens: 12 },
      outputChars: 40,
    });
    const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
    expect(d).toMatchObject({
      agentId: 'a1',
      providerId: 'p1',
      modelId: 'm1',
      tierAssigned: 'default',
      decisionLayer: 'default',
      status: 'success',
    });
    expect(d.usage).toMatchObject({ inputTokens: 30, outputTokens: 12, estimated: false });
    expect(d.id).toBeTruthy();
    expect(d.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(d)).not.toContain('messages'); // no prompt/response body
  });

  it('estimates usage when the outcome carries none', () => {
    const { recorder, enqueue } = makeRecorder();
    recorder.record(ctx({ requestChars: 400 }), { status: 'error', outputChars: 40 });
    const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
    expect(d.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, estimated: true });
    expect(d.status).toBe('error');
  });

  it('never throws into the caller', () => {
    const { recorder } = makeRecorder(
      jest.fn(() => {
        throw new Error('boom');
      }),
    );
    expect(() => recorder.record(ctx(), { status: 'success', outputChars: 0 })).not.toThrow();
  });

  it('carries terminal error detail on an error outcome (add-request-error-detail)', () => {
    const { recorder, enqueue } = makeRecorder();
    recorder.record(ctx(), {
      status: 'error',
      outputChars: 0,
      error: { kind: 'rate_limit', status: 429, providerMessage: 'Rate limited', requestId: 'r1' },
    });
    const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
    expect(d.error).toEqual({
      kind: 'rate_limit',
      status: 429,
      providerMessage: 'Rate limited',
      requestId: 'r1',
    });
  });

  it('CENTRALLY discards error detail on any non-error status', () => {
    const { recorder, enqueue } = makeRecorder();
    for (const status of ['success', 'fallback', 'cancelled'] as const) {
      recorder.record(ctx(), {
        status,
        outputChars: 0,
        error: { kind: 'unavailable', providerMessage: 'should not persist' },
      });
    }
    for (const call of enqueue.mock.calls) {
      expect((call[0] as RequestLogDraft).error).toBeUndefined();
    }
  });

  it('carries the per-attempt trail on an error outcome (add-fallback-attempt-detail)', () => {
    const { recorder, enqueue } = makeRecorder();
    const attemptFailures = [
      {
        index: 0,
        providerId: 'p1',
        model: 'a',
        kind: 'unavailable',
        status: 529,
        dispatched: true,
      },
      {
        index: 1,
        providerId: 'p2',
        model: 'b',
        kind: 'unavailable',
        dispatched: false,
        terminal: true,
      },
    ];
    recorder.record(ctx({ attemptFailures }), {
      status: 'error',
      outputChars: 0,
      error: { kind: 'unavailable' },
    });
    const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
    expect(d.attemptFailures).toEqual(attemptFailures);
  });

  // classify-plan-quota-errors task 6.4: a plan-cooldown skip's reason rides the same trail
  // gate as every other entry, and a plan kind's own message persists verbatim.
  it('keeps skipReason on fallback and error rows and discards it on success and cancelled', () => {
    const { recorder, enqueue } = makeRecorder();
    const attemptFailures = [
      {
        index: 0,
        providerId: 'p1',
        model: 'a',
        kind: 'quota_exhausted',
        dispatched: false,
        skipReason: 'plan_cooldown' as const,
        terminal: true,
      },
    ];
    for (const status of ['success', 'cancelled'] as const) {
      recorder.record(ctx({ attemptFailures }), { status, outputChars: 0 });
    }
    for (const call of enqueue.mock.calls) {
      expect((call[0] as RequestLogDraft).attemptFailures).toBeUndefined();
    }
    enqueue.mockClear();
    for (const status of ['fallback', 'error'] as const) {
      recorder.record(ctx({ attemptFailures }), {
        status,
        outputChars: 0,
        ...(status === 'error' ? { error: { kind: 'quota_exhausted' } } : {}),
      });
    }
    for (const call of enqueue.mock.calls) {
      expect((call[0] as RequestLogDraft).attemptFailures).toEqual(attemptFailures);
    }
  });

  it.each(['quota_exhausted', 'risk_control', 'plan_inactive', 'plan_entitlement'])(
    'persists a %s message verbatim (it was scrubbed and capped at the adapter)',
    (kind) => {
      const { recorder, enqueue } = makeRecorder();
      const providerMessage = 'Usage limit reached for 5 hours. Your limit will reset at 18:00';
      recorder.record(ctx(), {
        status: 'error',
        outputChars: 0,
        error: { kind, status: 429, providerMessage, markers: ['1308'] },
      });
      const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
      expect(d.error).toEqual({ kind, status: 429, providerMessage, markers: ['1308'] });
    },
  );

  // fix-bad-request-dead-end: the trail follows the WALK, the five error-detail
  // columns follow the TERMINAL status. Two rules, not one — a request the chain
  // RECOVERED has no terminal error but very much has a trail, and it is the only
  // record of why the chain moved.
  it('discards the per-attempt trail on success and cancelled — but KEEPS it on fallback', () => {
    const { recorder, enqueue } = makeRecorder();
    const attemptFailures = [
      { index: 0, providerId: 'p1', model: 'a', kind: 'bad_request', dispatched: true },
    ];
    for (const status of ['success', 'cancelled'] as const) {
      recorder.record(ctx({ attemptFailures }), { status, outputChars: 0 });
    }
    for (const call of enqueue.mock.calls) {
      expect((call[0] as RequestLogDraft).attemptFailures).toBeUndefined();
    }
    enqueue.mockClear();
    recorder.record(ctx({ attemptFailures }), { status: 'fallback', outputChars: 0 });
    const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
    expect(d.attemptFailures).toEqual(attemptFailures);
  });

  // keep-cheap-leg-attempt-trail (design D1): an escalated row's status reads the
  // escalation leg alone, so a cheap leg that failed before the strong tier served
  // cleanly settles `success` — and its trail is the only record of that leg.
  describe('an escalated row keeps its cheap leg’s trail whichever leg served', () => {
    const cheapTrail = [
      {
        index: 0,
        providerId: 'p1',
        model: 'cheap-a',
        kind: 'unavailable',
        dispatched: true,
        stopReason: 'deadline' as const,
        leg: 'cheap' as const,
      },
    ];

    it('keeps the trail on an escalated success, with no terminal error detail', () => {
      const { recorder, enqueue } = makeRecorder();
      recorder.record(ctx({ attemptFailures: cheapTrail }), {
        status: 'success',
        outputChars: 0,
        escalated: true,
        escalationSource: 'cheap_error',
        // a caller that wrongly supplies error detail on a success row is still gated
        error: { kind: 'unavailable' },
      });
      const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
      expect(d.attemptFailures).toEqual(cheapTrail);
      expect(d.error).toBeUndefined();
    });

    it('records no trail on an escalated success whose trail is empty', () => {
      const { recorder, enqueue } = makeRecorder();
      recorder.record(ctx({ attemptFailures: [] }), {
        status: 'success',
        outputChars: 0,
        escalated: true,
        escalationSource: 'quality_gate',
      });
      expect((enqueue.mock.calls[0]![0] as RequestLogDraft).attemptFailures).toBeUndefined();
    });

    it('discards it on an escalated cancel and on a success that did not escalate', () => {
      const { recorder, enqueue } = makeRecorder();
      recorder.record(ctx({ attemptFailures: cheapTrail }), {
        status: 'cancelled',
        outputChars: 0,
        escalated: true,
        escalationSource: 'cheap_error',
      });
      recorder.record(ctx({ attemptFailures: cheapTrail }), {
        status: 'success',
        outputChars: 0,
        escalated: false,
      });
      expect(enqueue.mock.calls).toHaveLength(2);
      for (const call of enqueue.mock.calls) {
        expect((call[0] as RequestLogDraft).attemptFailures).toBeUndefined();
      }
    });
  });

  it('a recovered row still carries NO terminal error detail — the two gates are separate', () => {
    const { recorder, enqueue } = makeRecorder();
    recorder.record(
      ctx({
        attemptFailures: [
          { index: 0, providerId: 'p1', model: 'a', kind: 'bad_request', dispatched: true },
        ],
      }),
      // a caller that wrongly supplies error detail on a fallback row is still gated
      { status: 'fallback', outputChars: 0, error: { kind: 'bad_request' } },
    );
    const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
    expect(d.error).toBeUndefined(); // terminal detail follows the terminal status
    expect(d.attemptFailures).toHaveLength(1); // the trail follows the walk
  });

  // zero-cost-unbilled-errors D2: the proxy folds the walk's evidence into
  // `unbilledWalk`, the RECORDER decides. The table is spelled out row by row (not
  // derived from the gate's own expression) so a gate that drops a conjunct fails.
  describe('not-billed gate (zero-cost-unbilled-errors)', () => {
    const usage = { inputTokens: 30, outputTokens: 12 };
    const rows: {
      readonly name: string;
      readonly status: 'success' | 'error' | 'fallback' | 'cancelled';
      readonly unbilledWalk: boolean | undefined;
      readonly withUsage: boolean;
      readonly billed: boolean;
    }[] = [
      {
        name: 'error + flag',
        status: 'error',
        unbilledWalk: true,
        withUsage: false,
        billed: false,
      },
      {
        name: 'cancelled + flag',
        status: 'cancelled',
        unbilledWalk: true,
        withUsage: false,
        billed: false,
      },
      {
        name: 'error + flag false',
        status: 'error',
        unbilledWalk: false,
        withUsage: false,
        billed: true,
      },
      {
        name: 'error + flag absent',
        status: 'error',
        unbilledWalk: undefined,
        withUsage: false,
        billed: true,
      },
      {
        name: 'cancelled + flag absent',
        status: 'cancelled',
        unbilledWalk: undefined,
        withUsage: false,
        billed: true,
      },
      {
        name: 'cancelled + flag false',
        status: 'cancelled',
        unbilledWalk: false,
        withUsage: false,
        billed: true,
      },
      {
        name: 'success never, even with the flag',
        status: 'success',
        unbilledWalk: true,
        withUsage: false,
        billed: true,
      },
      {
        name: 'fallback never, even with the flag',
        status: 'fallback',
        unbilledWalk: true,
        withUsage: false,
        billed: true,
      },
      {
        name: 'error + flag but provider usage present',
        status: 'error',
        unbilledWalk: true,
        withUsage: true,
        billed: true,
      },
      {
        name: 'cancelled + flag but provider usage present',
        status: 'cancelled',
        unbilledWalk: true,
        withUsage: true,
        billed: true,
      },
      {
        name: 'success + flag + usage',
        status: 'success',
        unbilledWalk: true,
        withUsage: true,
        billed: true,
      },
    ];

    it.each(rows)('$name -> billed=$billed', ({ status, unbilledWalk, withUsage, billed }) => {
      const { recorder, enqueue } = makeRecorder();
      recorder.record(ctx(), {
        status,
        outputChars: 0,
        ...(withUsage ? { providerUsage: usage } : {}),
        ...(unbilledWalk !== undefined ? { unbilledWalk } : {}),
      });
      const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
      expect(d.billed).toBe(billed);
    });

    it('a not-billed draft keeps its estimate, usage_estimated, error detail and trail unchanged', () => {
      const { recorder, enqueue } = makeRecorder();
      const attemptFailures = [
        { index: 0, providerId: 'p1', model: 'a', kind: 'unavailable', dispatched: false },
        {
          index: 1,
          providerId: 'p2',
          model: 'b',
          kind: 'unavailable',
          dispatched: false,
          terminal: true,
        },
      ];
      const error = { kind: 'unavailable', providerMessage: 'circuit open' };
      recorder.record(ctx({ requestChars: 400, attemptFailures }), {
        status: 'error',
        outputChars: 0,
        unbilledWalk: true,
        error,
      });
      const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
      expect(d.billed).toBe(false);
      // The chars/4 routing estimate and its flag are the evidence the row keeps.
      expect(d.usage).toMatchObject({ inputTokens: 100, outputTokens: 0, estimated: true });
      expect(d.error).toEqual(error);
      expect(d.attemptFailures).toEqual(attemptFailures);
      expect(d.status).toBe('error');
    });

    it('the attempt ledger never carries the marker — a superseded cheap call ran', () => {
      const enqueueAttempt = jest.fn();
      const writer = { enqueue: jest.fn(), enqueueAttempt } as unknown as LogWriter;
      const recorder = new RequestRecorder(writer, new ProxyMetrics());
      recorder.recordAttempt(
        'req-1',
        ctx(),
        { status: 'fallback', outputChars: 8, unbilledWalk: true },
        0,
      );
      const a = enqueueAttempt.mock.calls[0]![0] as Record<string, unknown>;
      expect('billed' in a).toBe(false);
    });
  });

  describe('learning contribution (add-semantic-learning task 3.3)', () => {
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    const withSink = (): {
      recorder: RequestRecorder;
      enqueue: jest.Mock;
      contribute: jest.Mock;
    } => {
      const enqueue = jest.fn();
      const contribute = jest.fn();
      const writer = { enqueue } as unknown as LogWriter;
      const recorder = new RequestRecorder(writer, new ProxyMetrics(), { contribute });
      return { recorder, enqueue, contribute };
    };
    const learning = (enabled: boolean) => ({
      evidence: vec,
      enabled,
      epoch: 0,
      revision: 'sha256:rev',
    });

    it('contributes the served vector at settle, and NEVER puts it in the draft (invariant 8)', () => {
      const { recorder, enqueue, contribute } = withSink();
      recorder.record(ctx({ learning: learning(true) }), {
        status: 'success',
        outputChars: 10,
        escalated: false,
        qualitySignal: 0.9,
      });
      expect(contribute).toHaveBeenCalledTimes(1);
      expect(contribute.mock.calls[0]![2]).toBe(vec); // arg[2] = the vector (arg[1] = epoch)
      // The enqueued draft has NO vector anywhere.
      const d = enqueue.mock.calls[0]![0] as RequestLogDraft;
      expect(Object.values(d).some((v) => v instanceof Float32Array)).toBe(false);
      expect(JSON.stringify(d)).not.toContain('0.1');
    });

    it('does NOT contribute when the decision-time gate was disabled', () => {
      const { recorder, contribute } = withSink();
      recorder.record(ctx({ learning: learning(false) }), { status: 'success', outputChars: 0 });
      expect(contribute).not.toHaveBeenCalled();
    });

    it('does NOT contribute when no learning context rode (non-ambiguous path)', () => {
      const { recorder, contribute } = withSink();
      recorder.record(ctx(), { status: 'success', outputChars: 0 });
      expect(contribute).not.toHaveBeenCalled();
    });

    it('a throwing sink never breaks recording', () => {
      const enqueue = jest.fn();
      const recorder = new RequestRecorder(
        { enqueue } as unknown as LogWriter,
        new ProxyMetrics(),
        {
          contribute: () => {
            throw new Error('sink boom');
          },
        },
      );
      expect(() =>
        recorder.record(ctx({ learning: learning(true) }), { status: 'success', outputChars: 0 }),
      ).not.toThrow();
      expect(enqueue).toHaveBeenCalledTimes(1); // the row was still enqueued
    });
  });
});
