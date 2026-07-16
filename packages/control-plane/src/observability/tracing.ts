import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { loadObservabilityConfig } from './observability.config';

/** The single tracer name every span in this app uses. Callers go through
 * `trace.getTracer(TRACER_NAME)` from `@opentelemetry/api` — a no-op unless a
 * provider was registered here (or by a test). */
export const TRACER_NAME = 'polyrouter';

let provider: NodeTracerProvider | undefined;

/**
 * Register the OTel SDK when `OTEL_ENABLED` (#21). Called in `main.ts` after
 * `loadConfig` (so a malformed registered var already failed boot) and BEFORE
 * Nest is created. `provider.register()` installs the AsyncLocalStorage context
 * manager, which carries the root span through guards/services/stream pumps.
 * The exporter honors the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (its own
 * default applies when absent); an unreachable collector only ever fails the
 * batched async export — never a request.
 */
export function initTracing(): void {
  const cfg = loadObservabilityConfig();
  if (!cfg.otelEnabled || provider !== undefined) return;
  const p = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: cfg.serviceName }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  p.register();
  provider = p;
}

/** Flush + shut down the batch processor on graceful drain. Idempotent. */
export async function shutdownTracing(): Promise<void> {
  const p = provider;
  provider = undefined;
  if (!p) return;
  try {
    await p.shutdown();
  } catch {
    // a flush failure at shutdown must not turn a clean drain into a crash
  }
}
