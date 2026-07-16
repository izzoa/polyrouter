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
});
