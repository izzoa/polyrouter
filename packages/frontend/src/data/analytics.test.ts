import { describe, expect, it } from 'vitest';
import {
  breakdownToSpend,
  escalationRate,
  fallbackRate,
  filterToRequestParams,
  pct,
  rowCostLabel,
  successRate,
  timeseriesToChart,
  toErrorView,
  toInspectorView,
} from './analytics';
import {
  fmtMicros,
  labelOf,
  totalCostMicros,
  type AnalyticsSummary,
  type RequestRow,
  type TimeseriesPoint,
} from './api';

const SUMMARY: AnalyticsSummary = {
  spend: 12.5,
  requests: 30,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  successCount: 24,
  fallbackCount: 4,
  errorCount: 2,
  escalatedCount: 6,
  estimatedCount: 3,
  freeRequests: 8,
  paidRequests: 20,
  unpricedRequests: 2,
  nativeFamilySpend: 0,
};

const ROW: RequestRow = {
  id: 'r1',
  createdAt: '2026-07-15T00:00:00.000Z',
  agentId: 'a1',
  providerId: 'p1',
  modelId: 'm1',
  tierAssigned: 'default',
  decisionLayer: 'structural',
  routingReason: 'auto → L1 structural → default',
  routingHeaderName: null,
  routingHeaderValue: null,
  status: 'success',
  escalated: false,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 10,
  cacheWriteTokens: 20,
  inputPriceSnapshot: 1.5,
  outputPriceSnapshot: 6,
  cacheReadPriceSnapshot: 0,
  cacheWritePriceSnapshot: null,
  cost: 0.002,
  attemptCostMicros: 0,
  durationMs: 1200,
  usageEstimated: false,
  priceSource: null,
  priceEstimated: false,
  qualitySignal: 0.8,
  modelLabel: 'GPT',
  providerLabel: 'OpenAI',
  agentLabel: 'openclaw',
  structuralBand: null,
  structuralScore: null,
  structuralBandSource: null,
  semanticBand: null,
  semanticScore: null,
  semanticSource: null,
  semanticRevision: null,
  errorKind: null,
  errorStatus: null,
  errorMessage: null,
  errorRequestId: null,
  hasBodies: false,
};

describe('summary-derived rates', () => {
  it('computes success/fallback/escalation rates', () => {
    expect(successRate(SUMMARY)).toBeCloseTo(0.8, 10);
    expect(fallbackRate(SUMMARY)).toBeCloseTo(4 / 30, 10);
    expect(escalationRate(SUMMARY)).toBeCloseTo(0.2, 10);
  });

  it('guards an empty range (requests === 0 → 0, never NaN)', () => {
    const empty: AnalyticsSummary = { ...SUMMARY, requests: 0, successCount: 0 };
    expect(successRate(empty)).toBe(0);
    expect(pct(0, 0)).toBe('0.0%');
    expect(pct(24, 30)).toBe('80.0%');
  });
});

describe('timeseriesToChart', () => {
  it('maps buckets to epoch SECONDS and requests to counts', () => {
    const pts: TimeseriesPoint[] = [
      {
        bucket: '2026-07-15T00:00:00.000Z',
        requests: 5,
        spend: 1,
        inputTokens: 0,
        outputTokens: 0,
        errorCount: 0,
        fallbackCount: 0,
        escalatedCount: 0,
      },
      {
        bucket: '2026-07-15T01:00:00.000Z',
        requests: 8,
        spend: 2,
        inputTokens: 0,
        outputTokens: 0,
        errorCount: 0,
        fallbackCount: 0,
        escalatedCount: 0,
      },
    ];
    const [secs, counts] = timeseriesToChart(pts, 3600);
    expect(secs).toEqual([
      Math.floor(Date.parse('2026-07-15T00:00:00.000Z') / 1000),
      Math.floor(Date.parse('2026-07-15T01:00:00.000Z') / 1000),
    ]);
    expect(counts).toEqual([5, 8]);
  });

  it('zero-fills missing (empty) buckets instead of interpolating across the gap (A-31)', () => {
    const pt = (bucket: string, requests: number): TimeseriesPoint => ({
      bucket,
      requests,
      spend: 0,
      inputTokens: 0,
      outputTokens: 0,
      errorCount: 0,
      fallbackCount: 0,
      escalatedCount: 0,
    });
    // Hourly buckets with 01:00 and 02:00 missing (no requests those hours).
    const [secs, counts] = timeseriesToChart(
      [pt('2026-07-15T00:00:00.000Z', 5), pt('2026-07-15T03:00:00.000Z', 8)],
      3600,
    );
    const h = (s: string): number => Math.floor(Date.parse(s) / 1000);
    expect(secs).toEqual([
      h('2026-07-15T00:00:00.000Z'),
      h('2026-07-15T01:00:00.000Z'),
      h('2026-07-15T02:00:00.000Z'),
      h('2026-07-15T03:00:00.000Z'),
    ]);
    expect(counts).toEqual([5, 0, 0, 8]); // dips to zero over the idle hours, not a straight line
  });
});

describe('filterToRequestParams', () => {
  it('maps every chip to server-side params', () => {
    expect(filterToRequestParams('all')).toEqual({});
    expect(filterToRequestParams('explicit')).toEqual({
      decisionLayers: ['explicit', 'header', 'default'],
    });
    expect(filterToRequestParams('auto')).toEqual({ decisionLayers: ['structural', 'cascade'] });
    expect(filterToRequestParams('fallback')).toEqual({ status: 'fallback' });
    expect(filterToRequestParams('escalated')).toEqual({ escalated: true });
  });
});

describe('cost helpers', () => {
  it('totalCostMicros = round(cost × 1e6) + attemptCostMicros', () => {
    expect(totalCostMicros({ cost: 0.002, attemptCostMicros: 250 })).toBe(2250);
    expect(totalCostMicros({ cost: null, attemptCostMicros: 250 })).toBe(250);
    expect(totalCostMicros({ cost: 0, attemptCostMicros: 0 })).toBe(0);
  });

  it('fmtMicros + labelOf', () => {
    expect(fmtMicros(1_234_000)).toBe('$1.2340');
    expect(fmtMicros(0)).toBe('$0.0000');
    expect(labelOf('GPT', 'm1')).toBe('GPT');
    expect(labelOf(null, 'm1')).toBe('m1');
    expect(labelOf(null, null)).toBe('unknown');
  });

  it('rowCostLabel shows the total and a ~ when usage is estimated', () => {
    expect(rowCostLabel(ROW)).toBe('$0.0020');
    expect(rowCostLabel({ ...ROW, usageEstimated: true })).toBe('$0.0020~');
  });
});

describe('breakdownToSpend', () => {
  it('maps rows to bar data with the label fallback', () => {
    expect(
      breakdownToSpend([
        { key: 'm1', label: 'GPT', spend: 5, requests: 3 },
        { key: 'x', label: null, spend: 1, requests: 1 },
        { key: '', label: null, spend: 2, requests: 1 },
      ]),
    ).toEqual([
      { n: 'GPT', v: 5 },
      { n: 'x', v: 1 },
      { n: 'unknown', v: 2 },
    ]);
  });
});

describe('toInspectorView', () => {
  it('exposes the decision layer + verbatim routing reason', () => {
    const v = toInspectorView(ROW);
    expect(v.title).toBe('GPT');
    expect(v.decisionLayer).toBe('structural');
    expect(v.routingReason).toBe('auto → L1 structural → default');
    expect(v.totalMicros).toBe(2000);
    expect(v.servedCost).toBe('$0.0020');
    expect(v.totalCost).toBe('$0.0020');
  });

  it('keeps a `0` snapshot ("$0 free") distinct from a `null` snapshot ("unpriced")', () => {
    const v = toInspectorView(ROW);
    const byLabel = Object.fromEntries(v.prices.map((p) => [p.label, p]));
    expect(byLabel['cache read']?.value).toBe('$0 free');
    expect(byLabel['cache read']?.free).toBe(true);
    expect(byLabel['cache write']?.value).toBe('unpriced');
    expect(byLabel['cache write']?.unpriced).toBe(true);
    expect(byLabel['input']?.value).toBe('$1.5 / 1M');
  });

  it('renders a null served cost as "unpriced" (≠ $0.00), and a `0` cost as $0.0000', () => {
    expect(toInspectorView({ ...ROW, cost: null, attemptCostMicros: 250 }).servedCost).toBe(
      'unpriced',
    );
    expect(toInspectorView({ ...ROW, cost: null, attemptCostMicros: 250 }).totalCost).toBe(
      'unpriced',
    );
    expect(toInspectorView({ ...ROW, cost: 0 }).servedCost).toBe('$0.0000');
    expect(toInspectorView({ ...ROW, cost: 0 }).totalCost).toBe('$0.0000');
  });

  it('renders the matched header: name+value, bare name, or hidden (add-routing-header-visibility)', () => {
    // built-in tier header → `name: value`
    expect(
      toInspectorView({
        ...ROW,
        decisionLayer: 'header',
        routingHeaderName: 'x-polyrouter-tier',
        routingHeaderValue: 'heavy',
      }).matchedHeader,
    ).toBe('x-polyrouter-tier: heavy');
    // custom rule → bare name (its configured value is never recorded)
    expect(
      toInspectorView({
        ...ROW,
        decisionLayer: 'header',
        routingHeaderName: 'x-team',
        routingHeaderValue: null,
      }).matchedHeader,
    ).toBe('x-team');
    // legacy header-layer row (pre-capture) and non-header layers → hidden
    expect(toInspectorView({ ...ROW, decisionLayer: 'header' }).matchedHeader).toBeNull();
    expect(toInspectorView(ROW).matchedHeader).toBeNull();
    // a stray value without a name (type/CHECK-impossible) never renders
    expect(
      toInspectorView({ ...ROW, routingHeaderValue: 'orphan' }).matchedHeader,
    ).toBeNull();
  });
});

describe('toErrorView — the ERROR card gate + headline rules (add-request-error-detail)', () => {
  const errRow = (over: Partial<RequestRow>): RequestRow => ({
    ...ROW,
    status: 'error',
    cost: null,
    ...over,
  });

  it('kind + status + message + request id → full card', () => {
    const v = toErrorView(
      errRow({
        errorKind: 'rate_limit',
        errorStatus: 429,
        errorMessage: 'Rate limit exceeded: free-models-per-day',
        errorRequestId: 'req_1',
      }),
    );
    expect(v).toEqual({
      headline: 'rate_limit · HTTP 429',
      message: 'Rate limit exceeded: free-models-per-day',
      requestId: 'req_1',
    });
  });

  it('each identity field alone renders a coherent headline — never a blank slot', () => {
    expect(toErrorView(errRow({ errorKind: 'unavailable' }))?.headline).toBe('unavailable');
    expect(toErrorView(errRow({ errorStatus: 429 }))?.headline).toBe('HTTP 429');
    const msgOnly = toErrorView(errRow({ errorMessage: 'boom' }));
    expect(msgOnly?.headline).toBe(''); // the card drops the headline row, keeps the message
    expect(msgOnly?.message).toBe('boom');
  });

  it('normalizes FIRST: empty/whitespace strings do not summon the card', () => {
    expect(toErrorView(errRow({ errorKind: '  ', errorMessage: '' }))).toBeNull();
    expect(toErrorView(errRow({ errorMessage: '  spaced  ' }))?.message).toBe('spaced');
  });

  it('legacy all-null error rows and non-error rows (even with junk detail) → null', () => {
    expect(toErrorView(errRow({}))).toBeNull(); // all four null
    expect(
      toErrorView({ ...ROW, status: 'success', errorKind: 'unavailable', errorMessage: 'junk' }),
    ).toBeNull();
    expect(toErrorView({ ...ROW, status: 'fallback', errorStatus: 500 })).toBeNull();
  });

  it('rides toInspectorView', () => {
    expect(toInspectorView(errRow({ errorKind: 'auth' })).errorView?.headline).toBe('auth');
    expect(toInspectorView(ROW).errorView).toBeNull();
  });
});

describe('toInspectorView — native-family provenance (add-native-price-fallback)', () => {
  const base = ROW;

  it('marks unit-price rows, the total, and the source line for a native-priced request', () => {
    const v = toInspectorView({
      ...base,
      cost: 0.001,
      inputPriceSnapshot: 0.3,
      outputPriceSnapshot: 1.2,
      cacheReadPriceSnapshot: 0,
      priceSource: 'native_family',
      priceEstimated: true,
    });
    expect(v.priceSourceLabel).toBe('native family · estimate');
    expect(v.prices[0]!.value).toBe('$0.3 / 1M · est.');
    expect(v.prices[1]!.value).toBe('$1.2 / 1M · est.');
    // The zero-priced (free) snapshot carries the marker too — never exact-looking.
    expect(v.prices[2]!.value).toBe('$0 free · est.');
    expect(v.totalCost.endsWith(' · est.')).toBe(true);
  });

  it('an attempt-only estimate marks the TOTAL while the served source stays plain', () => {
    const v = toInspectorView({
      ...base,
      cost: 0.009,
      inputPriceSnapshot: 2.5,
      priceSource: 'bundled',
      priceEstimated: true, // rolled up from a native-priced superseded attempt
    });
    expect(v.priceSourceLabel).toBe('bundled');
    expect(v.prices[0]!.value).toBe('$2.5 / 1M'); // served rows unmarked
    expect(v.totalCost.endsWith(' · est.')).toBe(true); // the combined total is marked
  });

  it('legacy/unpriced rows render exactly as before', () => {
    const v = toInspectorView({ ...base, cost: null, priceSource: null, priceEstimated: false });
    expect(v.priceSourceLabel).toBeNull();
    expect(v.totalCost).toBe('unpriced');
  });
});
