// observe-adapter (#21): span + upstream-metric semantics per outcome — the
// paths the e2e cannot drive deterministically (client abort vs infra abort,
// truncation, error events, a never-iterated stream). Uses a real in-memory
// tracer (this file is its own module registry — no cross-spec leakage).
import { SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  ProviderError,
  type NormalizedRequest,
  type NormalizedResponse,
  type NormalizedStreamEvent,
  type ProviderAdapter,
} from '@polyrouter/data-plane';
import { observeAdapter } from './observe-adapter';
import { ProxyMetrics } from './proxy-metrics';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());
beforeEach(() => exporter.reset());

const REQ = { model: 'gpt-4o', messages: [] } as unknown as NormalizedRequest;
const RESPONSE = { content: [] } as unknown as NormalizedResponse;

function events(...evs: NormalizedStreamEvent[]): () => AsyncGenerator<NormalizedStreamEvent> {
  // eslint-disable-next-line @typescript-eslint/require-await -- AsyncGenerator by contract
  return async function* gen(): AsyncGenerator<NormalizedStreamEvent> {
    for (const e of evs) yield e;
  };
}
const START: NormalizedStreamEvent = {
  type: 'message_start',
  id: 'm',
  model: 'x',
  role: 'assistant',
};
const TERMINAL: NormalizedStreamEvent = { type: 'message_delta', stopReason: 'stop' };
const ERROR_EV: NormalizedStreamEvent = {
  type: 'error',
  error: { type: 'overloaded_error', message: 'x' },
} as unknown as NormalizedStreamEvent;

function fakeAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    protocol: 'openai_compatible',
    chat: () => Promise.resolve(RESPONSE),
    chatStream: events(START, TERMINAL),
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
    ...over,
  };
}

function wrap(
  adapter: ProviderAdapter,
  clientAborted = false,
): { wrapped: ProviderAdapter; metrics: ProxyMetrics } {
  const metrics = new ProxyMetrics();
  const wrapped = observeAdapter(adapter, {
    provider: 'prov',
    clientAborted: () => clientAborted,
    metrics,
  });
  return { wrapped, metrics };
}

async function consume(gen: AsyncGenerator<NormalizedStreamEvent>): Promise<void> {
  for await (const _ of gen) {
    void _; // draining
  }
}

const upstreamSpan = () => exporter.getFinishedSpans().find((s) => s.name === 'upstream');
const outcomeCount = async (m: ProxyMetrics, outcome: string): Promise<boolean> =>
  (await m.metricsText()).includes(
    `polyrouter_upstream_requests_total{provider="prov",model="gpt-4o",outcome="${outcome}"} 1`,
  );

describe('observeAdapter (#21)', () => {
  it('chat success → success outcome, OK span', async () => {
    const { wrapped, metrics } = wrap(fakeAdapter());
    await wrapped.chat(REQ);
    expect(upstreamSpan()!.attributes['polyrouter.outcome']).toBe('success');
    expect(await outcomeCount(metrics, 'success')).toBe(true);
  });

  it('chat throw → error outcome, ERROR span, rethrown', async () => {
    const { wrapped, metrics } = wrap(
      fakeAdapter({ chat: () => Promise.reject(new ProviderError('unavailable', 'boom')) }),
    );
    await expect(wrapped.chat(REQ)).rejects.toThrow('boom');
    expect(upstreamSpan()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(await outcomeCount(metrics, 'error')).toBe(true);
  });

  it('a throw with the CLIENT gone → canceled even when normalized to ProviderError', async () => {
    // A mid-body abort is often converted to ProviderError('unavailable') by the
    // adapter before it reaches the decorator — the client signal is the truth.
    const { wrapped, metrics } = wrap(
      fakeAdapter({ chat: () => Promise.reject(new ProviderError('unavailable', 'terminated')) }),
      true,
    );
    await expect(wrapped.chat(REQ)).rejects.toThrow('terminated');
    const span = upstreamSpan()!;
    expect(span.attributes['polyrouter.outcome']).toBe('canceled');
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(await outcomeCount(metrics, 'canceled')).toBe(true);
  });

  it('a clean terminal stream → success', async () => {
    const { wrapped, metrics } = wrap(fakeAdapter());
    await consume(wrapped.chatStream(REQ));
    expect(upstreamSpan()!.attributes['polyrouter.outcome']).toBe('success');
    expect(await outcomeCount(metrics, 'success')).toBe(true);
  });

  it('a stream ending WITHOUT a terminal stop → error (truncated)', async () => {
    const { wrapped, metrics } = wrap(fakeAdapter({ chatStream: events(START) }));
    await consume(wrapped.chatStream(REQ));
    const span = upstreamSpan()!;
    expect(span.attributes['polyrouter.outcome']).toBe('error');
    expect(span.attributes['polyrouter.truncated']).toBe(true);
    expect(await outcomeCount(metrics, 'error')).toBe(true);
  });

  it('a yielded error event → error, even though nothing throws', async () => {
    const { wrapped, metrics } = wrap(fakeAdapter({ chatStream: events(START, ERROR_EV) }));
    await consume(wrapped.chatStream(REQ));
    expect(upstreamSpan()!.attributes['polyrouter.outcome']).toBe('error');
    expect(await outcomeCount(metrics, 'error')).toBe(true);
  });

  it('consumer abort with the CLIENT gone → canceled (never a provider error)', async () => {
    const { wrapped, metrics } = wrap(fakeAdapter(), true);
    const gen = wrapped.chatStream(REQ);
    await gen.next(); // enter the stream (span starts)
    await gen.return(undefined); // client went away
    const span = upstreamSpan()!;
    expect(span.attributes['polyrouter.outcome']).toBe('canceled');
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(await outcomeCount(metrics, 'canceled')).toBe(true);
  });

  it('consumer abort with the client still there (infra abort/timeout) → error', async () => {
    const { wrapped, metrics } = wrap(fakeAdapter(), false);
    const gen = wrapped.chatStream(REQ);
    await gen.next();
    await gen.return(undefined); // torn down, but NOT by the client
    expect(upstreamSpan()!.attributes['polyrouter.outcome']).toBe('error');
    expect(await outcomeCount(metrics, 'error')).toBe(true);
  });

  it('a never-iterated stream call emits no span and no metric', async () => {
    const { wrapped, metrics } = wrap(fakeAdapter());
    wrapped.chatStream(REQ); // returned but never pulled — no upstream work
    expect(upstreamSpan()).toBeUndefined();
    expect(await metrics.metricsText()).not.toContain('polyrouter_upstream_requests_total{');
  });
});
