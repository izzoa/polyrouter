import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { BreakerState } from '@polyrouter/data-plane';

/** Upstream call outcome (#21). `canceled` = the CLIENT went away (never a
 * provider fault — kept out of error rates); a first-byte timeout or an
 * upstream error event is `error`. */
export type UpstreamOutcome = 'success' | 'error' | 'canceled';

const BREAKER_STATE_VALUE: Record<BreakerState, number> = {
  closed: 0,
  half_open: 1,
  open: 2,
};

/**
 * LLM-scale latency buckets (E15.1). prom-client's default histogram buckets top
 * out at a 10s finite bucket, but streamed completions routinely run 10s–minutes,
 * so with the defaults every real observation lands only in `+Inf` and
 * `histogram_quantile` reports ~10s for all traffic (per-provider comparison above
 * 10s is impossible). These explicit buckets span sub-second to 10 minutes.
 */
const LLM_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];

/**
 * The proxy's Prometheus registry (#21, spec §3.2.6). One registry PER Nest app
 * (never prom-client's global default — Jest builds many apps per process, and a
 * shared registry would collide on re-registration). Every emit method is
 * exception-safe: observability must never throw into a request (invariant-1
 * discipline). Label values are bounded by instance config (provider display
 * names, external model ids, small enums) — never tenant/agent/request ids or
 * message content (invariant 8).
 */
@Injectable()
export class ProxyMetrics {
  private readonly logger = new Logger(ProxyMetrics.name);
  readonly registry = new Registry();

  private readonly requests = new Counter({
    name: 'polyrouter_requests_total',
    help: 'Recorder-finalized inference requests (excludes pre-routing rejections)',
    labelNames: ['protocol', 'decision_layer', 'status'] as const,
    registers: [this.registry],
  });
  private readonly requestDuration = new Histogram({
    name: 'polyrouter_request_duration_seconds',
    help: 'End-to-end proxied request duration',
    labelNames: ['protocol', 'decision_layer', 'status'] as const,
    buckets: LLM_DURATION_BUCKETS,
    registers: [this.registry],
  });
  private readonly tokens = new Counter({
    name: 'polyrouter_tokens_total',
    help: 'Tokens by provider/model/direction (includes superseded cascade attempts)',
    labelNames: ['provider', 'model', 'direction'] as const,
    registers: [this.registry],
  });
  private readonly cost = new Counter({
    name: 'polyrouter_cost_microusd_total',
    help: 'Snapshot cost in micro-USD, emitted once per durably-written row (invariant 4)',
    labelNames: ['provider', 'model'] as const,
    registers: [this.registry],
  });
  private readonly upstream = new Counter({
    name: 'polyrouter_upstream_requests_total',
    help: 'Upstream provider calls by outcome (canceled = client abort, never a provider fault)',
    labelNames: ['provider', 'model', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly upstreamDuration = new Histogram({
    name: 'polyrouter_upstream_duration_seconds',
    help: 'Upstream call duration (streams measured to completion), split by outcome',
    // `outcome` (A-37): a client-abort (`canceled`) settles whenever the consumer
    // leaves, so its duration is not provider latency — labeling it keeps aborts out
    // of `success` latency quantiles.
    labelNames: ['provider', 'model', 'outcome'] as const,
    buckets: LLM_DURATION_BUCKETS,
    registers: [this.registry],
  });
  private readonly upstreamSetupFailures = new Counter({
    name: 'polyrouter_upstream_setup_failures_total',
    help: 'Chain members that failed before any upstream call (credential/decrypt faults)',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });
  private readonly breakerState = new Gauge({
    name: 'polyrouter_breaker_state',
    help: 'Circuit-breaker state last observed at admission (0 closed, 1 half_open, 2 open)',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });
  private readonly breakerOpens = new Counter({
    name: 'polyrouter_breaker_opens_total',
    help: 'Circuit-breaker transitions into open',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });
  private readonly logRowsDropped = new Counter({
    name: 'polyrouter_log_rows_dropped_total',
    help: 'Request-log rows the writer abandoned (queue overflow or insert give-up)',
    registers: [this.registry],
  });
  private readonly budgetFaults = new Counter({
    name: 'polyrouter_budget_enforcement_faults_total',
    help: 'Budget checks that faulted and engaged the named fail mode (open|closed)',
    labelNames: ['mode'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  recordRequest(
    protocol: string,
    decisionLayer: string,
    status: string,
    durationSeconds: number,
  ): void {
    this.safe(() => {
      this.requests.inc({ protocol, decision_layer: decisionLayer, status });
      this.requestDuration.observe(
        { protocol, decision_layer: decisionLayer, status },
        durationSeconds,
      );
    });
  }

  recordTokens(provider: string, model: string, input: number, output: number): void {
    this.safe(() => {
      if (input > 0) this.tokens.inc({ provider, model, direction: 'input' }, input);
      if (output > 0) this.tokens.inc({ provider, model, direction: 'output' }, output);
    });
  }

  /** `costUsd` is the row's snapshot cost (USD, possibly null = unpriced → no emit). */
  recordCost(provider: string, model: string, costUsd: number | null): void {
    if (costUsd === null || !Number.isFinite(costUsd) || costUsd <= 0) return;
    this.safe(() => this.cost.inc({ provider, model }, Math.round(costUsd * 1_000_000)));
  }

  recordUpstream(
    provider: string,
    model: string,
    outcome: UpstreamOutcome,
    durationSeconds: number,
  ): void {
    this.safe(() => {
      this.upstream.inc({ provider, model, outcome });
      this.upstreamDuration.observe({ provider, model, outcome }, durationSeconds);
    });
  }

  upstreamSetupFailed(provider: string): void {
    this.safe(() => this.upstreamSetupFailures.inc({ provider }));
  }

  breakerStateObserved(provider: string, state: BreakerState): void {
    this.safe(() => this.breakerState.set({ provider }, BREAKER_STATE_VALUE[state]));
  }

  breakerOpened(provider: string): void {
    this.safe(() => this.breakerOpens.inc({ provider }));
  }

  logRowsDroppedBy(n: number): void {
    if (n <= 0) return;
    this.safe(() => this.logRowsDropped.inc(n));
  }

  /** A budget check faulted and engaged its named fail mode (E6.1) — so an
   * instance silently running degraded enforcement is visible on `/metrics`. */
  recordBudgetFault(mode: 'open' | 'closed'): void {
    this.safe(() => this.budgetFaults.inc({ mode }));
  }

  metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** A metric fault must never surface into the request path. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.warn(`metric emission failed: ${String(err)}`);
    }
  }
}
