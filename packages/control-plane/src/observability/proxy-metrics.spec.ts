import { ProxyMetrics } from './proxy-metrics';

describe('ProxyMetrics (#21)', () => {
  it('emits the request/token/cost/upstream/breaker/drop series with bounded labels', async () => {
    const m = new ProxyMetrics();
    m.recordRequest('openai', 'structural', 'success', 0.25);
    m.recordTokens('openai-prod', 'gpt-4o', 100, 40);
    m.recordCost('openai-prod', 'gpt-4o', 0.0125); // USD → 12500 µ$
    m.recordUpstream('openai-prod', 'gpt-4o', 'success', 0.2);
    m.recordUpstream('backup', 'gpt-4o-mini', 'error', 0.1);
    m.upstreamSetupFailed('broken');
    m.breakerStateObserved('openai-prod', 'open');
    m.breakerOpened('openai-prod');
    m.logRowsDroppedBy(3);

    const text = await m.metricsText();
    expect(text).toContain(
      'polyrouter_requests_total{protocol="openai",decision_layer="structural",status="success"} 1',
    );
    expect(text).toContain(
      'polyrouter_tokens_total{provider="openai-prod",model="gpt-4o",direction="input"} 100',
    );
    expect(text).toContain(
      'polyrouter_tokens_total{provider="openai-prod",model="gpt-4o",direction="output"} 40',
    );
    expect(text).toContain(
      'polyrouter_cost_microusd_total{provider="openai-prod",model="gpt-4o"} 12500',
    );
    expect(text).toContain(
      'polyrouter_upstream_requests_total{provider="backup",model="gpt-4o-mini",outcome="error"} 1',
    );
    expect(text).toContain('polyrouter_upstream_setup_failures_total{provider="broken"} 1');
    expect(text).toContain('polyrouter_breaker_state{provider="openai-prod"} 2');
    expect(text).toContain('polyrouter_breaker_opens_total{provider="openai-prod"} 1');
    expect(text).toContain('polyrouter_log_rows_dropped_total 3');
    expect(text).toContain('polyrouter_request_duration_seconds_bucket'); // histograms present
    expect(text).toContain('polyrouter_upstream_duration_seconds_bucket');
    expect(text).toContain('process_cpu_user_seconds_total'); // default process metrics
  });

  it('skips unpriced/zero/invalid cost and never emits a negative counter', async () => {
    const m = new ProxyMetrics();
    m.recordCost('p', 'm', null);
    m.recordCost('p', 'm', 0); // a free model's 0 → no movement
    m.recordCost('p', 'm', Number.NaN);
    m.recordCost('p', 'm', -1);
    expect(await m.metricsText()).not.toContain('polyrouter_cost_microusd_total{provider="p"');
  });

  it('emit methods never throw into the caller on bad input', () => {
    const m = new ProxyMetrics();
    // A negative duration is invalid for a histogram — must be swallowed.
    expect(() => m.recordRequest('openai', 'default', 'success', -5)).not.toThrow();
    expect(() => m.recordUpstream('p', 'm', 'success', Number.NaN)).not.toThrow();
    expect(() => m.logRowsDroppedBy(-2)).not.toThrow();
  });

  it('uses LLM-scale duration buckets so a >10s observation lands in a finite bucket (E15.1)', async () => {
    const m = new ProxyMetrics();
    m.recordRequest('openai', 'default', 'success', 90); // a 90s streamed completion
    m.recordUpstream('openai-prod', 'gpt-4o', 'success', 90);
    const text = await m.metricsText();
    // The explicit ladder is present (prom-client defaults stop at le="10", so a 90s
    // observation would otherwise land ONLY in +Inf). prom-client emits `le` first.
    expect(text).toContain('polyrouter_request_duration_seconds_bucket{le="60",protocol="openai",decision_layer="default",status="success"} 0');
    expect(text).toContain('polyrouter_request_duration_seconds_bucket{le="120",protocol="openai",decision_layer="default",status="success"} 1');
    expect(text).toContain('polyrouter_request_duration_seconds_bucket{le="300",protocol="openai",decision_layer="default",status="success"} 1');
    // Upstream histogram gets the same ladder — a 90s stream is finite, not only +Inf.
    expect(text).toContain('polyrouter_upstream_duration_seconds_bucket{le="60",provider="openai-prod",model="gpt-4o"} 0');
    expect(text).toContain('polyrouter_upstream_duration_seconds_bucket{le="120",provider="openai-prod",model="gpt-4o"} 1');
  });

  it('two instances own independent registries (no cross-app collision)', async () => {
    const a = new ProxyMetrics();
    const b = new ProxyMetrics();
    a.breakerOpened('only-a');
    expect(await a.metricsText()).toContain('provider="only-a"');
    expect(await b.metricsText()).not.toContain('provider="only-a"');
  });
});
