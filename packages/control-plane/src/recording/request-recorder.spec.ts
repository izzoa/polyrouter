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

  describe('learning contribution (add-semantic-learning task 3.3)', () => {
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    const withSink = (): { recorder: RequestRecorder; enqueue: jest.Mock; contribute: jest.Mock } => {
      const enqueue = jest.fn();
      const contribute = jest.fn();
      const writer = { enqueue } as unknown as LogWriter;
      const recorder = new RequestRecorder(writer, new ProxyMetrics(), { contribute });
      return { recorder, enqueue, contribute };
    };
    const learning = (enabled: boolean) => ({ evidence: vec, enabled, epoch: 0, revision: 'sha256:rev' });

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
      const recorder = new RequestRecorder({ enqueue } as unknown as LogWriter, new ProxyMetrics(), {
        contribute: () => {
          throw new Error('sink boom');
        },
      });
      expect(() =>
        recorder.record(ctx({ learning: learning(true) }), { status: 'success', outputChars: 0 }),
      ).not.toThrow();
      expect(enqueue).toHaveBeenCalledTimes(1); // the row was still enqueued
    });
  });
});
