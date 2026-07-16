import { SpanStatusCode, context, trace, type Span } from '@opentelemetry/api';
import type {
  CallContext,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedStreamEvent,
  ProviderAdapter,
} from '@polyrouter/data-plane';
import type { ProxyMetrics, UpstreamOutcome } from './proxy-metrics';
import { TRACER_NAME } from './tracing';

export interface ObserveAdapterOptions {
  /** Provider display name — the metric/span attribution label (#21). */
  readonly provider: string;
  /** Whether the CLIENT's request signal is aborted — distinguishes a client
   * cancellation (`canceled`, never a provider fault) from an infrastructure
   * abort like the first-byte timeout (`error`). */
  readonly clientAborted: () => boolean;
  readonly metrics: ProxyMetrics;
}

/**
 * Wrap a provider adapter with the `upstream` span + upstream metrics (#21).
 * One span/counter per actual upstream call — breaker-skipped members never
 * reach a decorated adapter (no call happened), and setup failures are counted
 * separately in `buildAdapter`. Outcome rules mirror the breaker's stream
 * semantics: a yielded `error` event or a stream ending without a terminal
 * stop is `error`; a consumer abort is `canceled` only when the CLIENT went
 * away, else it was an infra abort (timeout) and stays `error`.
 * `listModels`/`testConnection` (control-plane CRUD) pass through untouched.
 */
export function observeAdapter(
  adapter: ProviderAdapter,
  opts: ObserveAdapterOptions,
): ProviderAdapter {
  return {
    protocol: adapter.protocol,

    async chat(request: NormalizedRequest, ctx?: CallContext): Promise<NormalizedResponse> {
      const { span, startedAt } = openSpan(opts, request.model, false);
      try {
        const response = await adapter.chat(request, ctx);
        settle(opts, span, request.model, startedAt, 'success');
        return response;
      } catch (err) {
        settle(opts, span, request.model, startedAt, outcomeOfThrow(opts));
        throw err;
      }
    },

    chatStream(
      request: NormalizedRequest,
      ctx?: CallContext,
    ): AsyncGenerator<NormalizedStreamEvent> {
      const inner = adapter.chatStream(request, ctx);
      // The wrapper IS the generator: its body (and the span) starts on FIRST
      // iteration — a never-iterated call creates no span — and the `finally`
      // runs exactly once on completion, throw, or consumer `return()`.
      return observeStream(inner, opts, request.model);
    },

    listModels: (ctx?: CallContext) => adapter.listModels(ctx),
    testConnection: (ctx?: CallContext) => adapter.testConnection(ctx),
  };
}

async function* observeStream(
  inner: AsyncGenerator<NormalizedStreamEvent>,
  opts: ObserveAdapterOptions,
  model: string,
): AsyncGenerator<NormalizedStreamEvent> {
  const { span, startedAt } = openSpan(opts, model, true);
  let sawTerminalStop = false;
  let sawError = false;
  let completed = false;
  let thrown: unknown;
  try {
    for await (const ev of inner) {
      if (ev.type === 'message_delta' && ev.stopReason !== undefined) sawTerminalStop = true;
      if (ev.type === 'error') sawError = true;
      yield ev;
    }
    completed = true;
  } catch (err) {
    thrown = err;
    throw err;
  } finally {
    let outcome: UpstreamOutcome;
    if (thrown !== undefined) outcome = outcomeOfThrow(opts);
    else if (completed) {
      outcome = sawError || !sawTerminalStop ? 'error' : 'success';
      // Ended without a terminal stop = truncated (the breaker's trip rule).
      if (!sawError && !sawTerminalStop) span.setAttribute('polyrouter.truncated', true);
    }
    // Abandoned before completion (consumer return()): the client went away or
    // an infra abort (e.g. first-byte timeout) tore the pump down.
    else outcome = opts.clientAborted() ? 'canceled' : 'error';
    settle(opts, span, model, startedAt, outcome);
  }
}

/** A throw with the CLIENT gone is a cancellation regardless of the error's
 * shape: a mid-body abort is often normalized to `ProviderError('unavailable')`
 * by the adapter before it reaches us (the raw undici error is not typed), and
 * counting the client's own disconnect as a provider error would corrupt the
 * error-rate attribution. Conversely a cancellation-shaped throw with the
 * client still present is an INFRA abort (first-byte/idle timeout) — an error.
 * A genuine provider failure racing a disconnect is indistinguishable and rare
 * — preferring `canceled` is the safe side. */
function outcomeOfThrow(opts: ObserveAdapterOptions): UpstreamOutcome {
  return opts.clientAborted() ? 'canceled' : 'error';
}

function openSpan(
  opts: ObserveAdapterOptions,
  model: string,
  streaming: boolean,
): { span: Span; startedAt: number } {
  const span = trace.getTracer(TRACER_NAME).startSpan(
    'upstream',
    {
      attributes: {
        'polyrouter.provider': opts.provider,
        'polyrouter.model': model,
        'polyrouter.streaming': streaming,
      },
    },
    context.active(),
  );
  return { span, startedAt: Date.now() };
}

function settle(
  opts: ObserveAdapterOptions,
  span: Span,
  model: string,
  startedAt: number,
  outcome: UpstreamOutcome,
): void {
  span.setAttribute('polyrouter.outcome', outcome);
  if (outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
  // Clamped: a backwards wall-clock step must not feed a negative histogram value.
  const seconds = Math.max(0, Date.now() - startedAt) / 1000;
  opts.metrics.recordUpstream(opts.provider, model, outcome, seconds);
}
