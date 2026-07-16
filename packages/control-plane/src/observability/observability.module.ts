import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import './observability.config';
import { MetricsController } from './metrics.controller';
import { ProxyMetrics } from './proxy-metrics';
import { shutdownTracing } from './tracing';

/** Flush the batched span exporter during graceful drain (a no-op when tracing
 * was never initialized — tests and the default posture). */
@Injectable()
class TracingLifecycle implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTracing();
  }
}

/**
 * Observability (#21, spec §3.2.6): the proxy's Prometheus registry + `/metrics`
 * and the tracing shutdown hook. Imports nothing (no cycles); `RecordingModule`
 * and `ProxyModule` import it for `ProxyMetrics`.
 */
@Module({
  controllers: [MetricsController],
  providers: [ProxyMetrics, TracingLifecycle],
  exports: [ProxyMetrics],
})
export class ObservabilityModule {}
