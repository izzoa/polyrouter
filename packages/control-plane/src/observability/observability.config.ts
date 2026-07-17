import { loadConfig, registerConfig, z } from '@polyrouter/shared';

/** Observability config (#21, spec §3.2.6). Tracing is OFF by default and can
 * never be required for a request to succeed; metrics are ON by default (an
 * in-process registry — the kill-switch only hides `/metrics`). The OTLP
 * endpoint is registered as an optional URL so a malformed value fails boot
 * fast (§12) while an ABSENT one falls back to the exporter's standard
 * default — a well-formed but unreachable collector is never fatal. */
registerConfig(
  'observability',
  z.object({
    OTEL_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === 'true'), // default false
    METRICS_ENABLED: z
      .string()
      .optional()
      .transform((v) => v !== 'false'), // default true
    OTEL_SERVICE_NAME: z.string().default('polyrouter'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    // The per-signal traces override (A-35). The OTLP exporter reads it directly and
    // it takes precedence over the generic endpoint, so register it here too — a
    // malformed value fails boot (same discipline as the generic one) and it flows
    // through the compose pass-through allowlist.
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional(),
  }),
);

export type ObservabilityRawConfig = {
  OTEL_ENABLED: boolean;
  METRICS_ENABLED: boolean;
  OTEL_SERVICE_NAME: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
};

export interface ObservabilityConfig {
  readonly otelEnabled: boolean;
  readonly metricsEnabled: boolean;
  readonly serviceName: string;
}

export function loadObservabilityConfig(): ObservabilityConfig {
  const all = loadConfig<ObservabilityRawConfig>();
  return {
    otelEnabled: all.OTEL_ENABLED,
    metricsEnabled: all.METRICS_ENABLED,
    serviceName: all.OTEL_SERVICE_NAME,
  };
}
