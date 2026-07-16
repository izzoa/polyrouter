import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { TRACER_NAME } from './tracing';

/** Client protocol from the request path (metadata for the root span only). */
function protocolOf(originalUrl: string): string {
  if (originalUrl.startsWith('/v1/messages')) return 'anthropic';
  if (originalUrl.startsWith('/v1/chat/completions')) return 'openai';
  return 'other';
}

/**
 * Root span for the `/v1` proxy plane (#21): starts `proxy.request`, makes it
 * the ACTIVE context for the whole downstream pipeline (`context.with` +
 * AsyncLocalStorage — guards, services, and stream pumps all inherit it), and
 * ends it on response close (covers streaming and client aborts; double-end
 * guarded). Mounted with `app.use('/v1', …)` so `req.path` is stripped — the
 * span uses `req.originalUrl`. Pure `@opentelemetry/api`: with no SDK
 * registered (the default) every call is a no-op.
 */
export function otelRootMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = (req.originalUrl ?? req.url).split('?')[0] ?? '';
  const span = trace.getTracer(TRACER_NAME).startSpan(`proxy.request`, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.request.method': req.method,
      'url.path': path,
      'polyrouter.protocol': protocolOf(path),
    },
  });
  let ended = false;
  res.once('close', () => {
    if (ended) return;
    ended = true;
    span.setAttribute('http.response.status_code', res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
  context.with(trace.setSpan(context.active(), span), next);
}
