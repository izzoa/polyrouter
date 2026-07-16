import { Controller, Get, NotFoundException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProxyMetrics } from './proxy-metrics';
import { loadObservabilityConfig } from './observability.config';

/** `GET /metrics` (#21) — Prometheus text, session-free by construction (the
 * SessionGuard ignores non-`/api` paths, like `/health`). Instance-level,
 * metadata-only aggregates; `METRICS_ENABLED=false` hides it entirely (404).
 * Operators should network-guard the port (see #22 packaging docs). */
@Controller('metrics')
export class MetricsController {
  private readonly enabled: boolean;

  constructor(private readonly metrics: ProxyMetrics) {
    this.enabled = loadObservabilityConfig().metricsEnabled;
  }

  @Get()
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    if (!this.enabled) throw new NotFoundException();
    // prom-client owns the exposition content type (text/plain; version=0.0.4).
    res.setHeader('Content-Type', this.metrics.contentType);
    res.setHeader('Cache-Control', 'no-store');
    return this.metrics.metricsText();
  }
}
