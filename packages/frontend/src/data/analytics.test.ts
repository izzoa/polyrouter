import { describe, expect, it } from 'vitest';
import {
  breakdownToSpend,
  escalationRate,
  fallbackRate,
  filterToRequestParams,
  NOT_BILLED_LABEL,
  rowCostLabel,
  rowCostParts,
  isTerminalSkip,
  successRate,
  timeseriesToChart,
  toAttemptTrail,
  toErrorView,
  toInspectorView,
} from './analytics';
import {
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
  batchRequests: 0,
  freeRequests: 8,
  notBilledRequests: 0,
  paidRequests: 20,
  unpricedRequests: 2,
  nativeFamilySpend: 0,
  subscriptionPricedRequests: 0,
  cashPricedRequests: 0,
  cashSpend: 0,
  subscriptionSpend: 0,
  unknownSpend: 0,
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
  billed: true,
  priceSource: null,
  batchId: null,
  priceMode: null,
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
  workloadClass: null,
  workloadScore: null,
  workloadSource: null,
  workloadRevision: null,
  errorKind: null,
  errorStatus: null,
  errorMessage: null,
  errorRequestId: null,
  errorMarkers: null,
  attemptFailures: null,
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
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
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
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
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
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
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
    expect(filterToRequestParams('auto')).toEqual({
      decisionLayers: ['structural', 'workload', 'semantic', 'cascade'],
    });
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

  it('labelOf', () => {
    expect(labelOf('GPT', 'm1')).toBe('GPT');
    expect(labelOf(null, 'm1')).toBe('m1');
    expect(labelOf(null, null)).toBe('unknown');
  });

  it('rowCostLabel shows the total, with `· est.` only for an estimated price, never for usage (adopt-figure-states 2.1)', () => {
    expect(rowCostLabel(ROW)).toBe('$0.0020');
    // A usage-only estimate is marked on the tokens cell, never on the money.
    expect(rowCostLabel({ ...ROW, usageEstimated: true })).toBe('$0.0020');
    expect(rowCostLabel({ ...ROW, priceEstimated: true })).toBe('$0.0020 · est.');
    expect(rowCostLabel({ ...ROW, usageEstimated: true, priceEstimated: true })).toBe(
      '$0.0020 · est.',
    );
  });
});

/** adopt-figure-states task 2.1: the table's cost cell and the inspector's total read one
 * cost state (`requestCostState`), in the vocabulary's words. */
describe('the request cost state reaches the table and the inspector (adopt-figure-states 2.1)', () => {
  const FREE_ROW: RequestRow = {
    ...ROW,
    id: 'free',
    cost: 0,
    attemptCostMicros: 0,
    inputPriceSnapshot: 0,
    outputPriceSnapshot: 0,
    priceSource: 'bundled',
  };

  it('a free row reads `$0 free`, and a free row priced `listed` reads `$0 free · est.`', () => {
    expect(rowCostLabel(FREE_ROW)).toBe('$0 free');
    expect(toInspectorView(FREE_ROW).totalCost).toBe('$0 free');
    const listed: RequestRow = { ...FREE_ROW, priceSource: 'listed', priceEstimated: true };
    expect(rowCostLabel(listed)).toBe('$0 free · est.');
    expect(toInspectorView(listed).totalCost).toBe('$0 free · est.');
  });

  it('a null-cost row reads `unpriced`, even with attempt cost, and the attempt line keeps that cost', () => {
    const r: RequestRow = { ...ROW, cost: null, attemptCostMicros: 250, priceEstimated: true };
    expect(rowCostLabel(r)).toBe('unpriced');
    expect(toInspectorView(r).totalCost).toBe('unpriced');
    expect(toInspectorView(r).servedCost).toBe('unpriced');
    expect(toInspectorView(r).attemptCost).toBe('$0.0003 · est.');
  });

  it('a 40 µ$ row reads `<$0.0001`, never `$0.0000`', () => {
    const r: RequestRow = { ...ROW, cost: 0.00004, attemptCostMicros: 0 };
    expect(rowCostLabel(r)).toBe('<$0.0001');
    expect(toInspectorView(r).totalCost).toBe('<$0.0001');
    expect(toInspectorView(r).servedCost).toBe('<$0.0001');
  });

  it('a usage-only estimated row has no `· est.` on any money figure', () => {
    const r: RequestRow = { ...ROW, usageEstimated: true, priceEstimated: false };
    const v = toInspectorView(r);
    expect(rowCostLabel(r)).not.toContain('est.');
    expect(v.totalCost).not.toContain('est.');
    expect(v.servedCost).not.toContain('est.');
    expect(v.attemptCost).not.toContain('est.');
    expect(v.usageEstimated).toBe(true);
  });

  it('a legacy `billed = null` row with a `native_family` price reads `· est.`', () => {
    const r: RequestRow = {
      ...ROW,
      status: 'error',
      billed: null,
      usageEstimated: true,
      cost: 0.0042,
      priceSource: 'native_family',
      priceEstimated: true,
    };
    expect(rowCostLabel(r)).toBe('$0.0042 · est.');
    expect(toInspectorView(r).totalCost).toBe('$0.0042 · est.');
    expect(rowCostLabel(r)).not.toContain('~');
  });

  it('marks the served cost when the SERVED price was estimated, and the attempt line when only an attempt could have been', () => {
    const served: RequestRow = { ...ROW, priceSource: 'native_family', priceEstimated: true };
    expect(toInspectorView(served).servedCost).toBe('$0.0020 · est.');
    // An exact served call beside a native-priced superseded attempt: the flag can only
    // have come from the attempt ledger, so the attempt line carries the marker, not served.
    const attemptOnly: RequestRow = {
      ...ROW,
      priceSource: 'bundled',
      priceEstimated: true,
      attemptCostMicros: 1_500,
    };
    expect(toInspectorView(attemptOnly).servedCost).toBe('$0.0020');
    expect(toInspectorView(attemptOnly).attemptCost).toBe('$0.0015 · est.');
    expect(toInspectorView(attemptOnly).totalCost).toBe('$0.0035 · est.');
    // No attempt cost: nothing to mark on the attempt line.
    expect(toInspectorView({ ...attemptOnly, attemptCostMicros: 0 }).attemptCost).toBe('$0.0000');
  });

  it('the table label equals the inspector total, as text and as parts, for every row in a fixture matrix', () => {
    const billed: (boolean | null)[] = [true, false, null];
    const costs: (number | null)[] = [null, 0, 0.00004, 0.0042];
    const attempts = [0, 250];
    const snapshots: [number | null, number | null][] = [
      [0, 0],
      [1.5, 6],
      [null, null],
    ];
    const sources: [string | null, boolean][] = [
      [null, false],
      ['bundled', false],
      ['bundled', true], // an attempt-only estimate
      ['native_family', true],
      ['listed', true],
    ];
    let checked = 0;
    for (const b of billed)
      for (const cost of costs)
        for (const attemptCostMicros of attempts)
          for (const [inputPriceSnapshot, outputPriceSnapshot] of snapshots)
            for (const [priceSource, priceEstimated] of sources)
              for (const usageEstimated of [false, true]) {
                const r: RequestRow = {
                  ...ROW,
                  billed: b,
                  cost,
                  attemptCostMicros,
                  inputPriceSnapshot,
                  outputPriceSnapshot,
                  priceSource,
                  priceEstimated,
                  usageEstimated,
                };
                const v = toInspectorView(r);
                expect(v.totalCost).toBe(rowCostLabel(r));
                expect(v.totalParts).toEqual(rowCostParts(r));
                expect(rowCostLabel(r)).not.toContain('~');
                checked += 1;
              }
    expect(checked).toBe(3 * 4 * 2 * 3 * 5 * 2);
  });

  it('exposes every inspector figure and price row as parts whose joined text is the string', () => {
    const v = toInspectorView({ ...FREE_ROW, priceSource: 'listed', priceEstimated: true });
    for (const [text, parts] of [
      [v.servedCost, v.servedParts],
      [v.attemptCost, v.attemptParts],
      [v.totalCost, v.totalParts],
      ...v.prices.map((p) => [p.value, p.parts] as const),
    ] as const) {
      expect(parts.map((p) => p.text).join(' ')).toBe(text);
    }
    expect(v.totalParts).toEqual([
      { text: '$0', tone: 'slot' },
      { text: 'free', tone: 'green' },
      { text: '· est.', tone: 'ink3' },
    ]);
    expect(v.prices[0]!.parts).toEqual(v.totalParts);
  });
});

/** Token components a breakdown row needs but this suite does not exercise. */
const T = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedTokens: 0,
};

describe('breakdownToSpend', () => {
  it('maps rows to bar data with the label fallback', () => {
    expect(
      breakdownToSpend([
        { key: 'm1', label: 'GPT', spend: 5, requests: 3, ...T },
        { key: 'x', label: null, spend: 1, requests: 1, ...T },
        { key: '', label: null, spend: 2, requests: 1, ...T },
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

  it('passes the semantic provenance through only when L2 evaluated the row (add-semantic-dashboard 3.2)', () => {
    // Legacy / non-semantic rows carry null → the inspector chip stays hidden.
    expect(toInspectorView(ROW).semanticSource).toBeNull();
    expect(toInspectorView(ROW).semanticBand).toBeNull();
    // An L2-evaluated row surfaces the source + band verbatim.
    const v = toInspectorView({ ...ROW, semanticSource: 'learned', semanticBand: 'high' });
    expect(v.semanticSource).toBe('learned');
    expect(v.semanticBand).toBe('high');
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
    expect(toInspectorView({ ...ROW, routingHeaderValue: 'orphan' }).matchedHeader).toBeNull();
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
      markers: null,
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

describe('toAttemptTrail / isTerminalSkip — the structural fallback trail (add-fallback-attempt-detail)', () => {
  const entries = [
    {
      index: 0,
      providerId: 'p1',
      model: 'gpt-x',
      kind: 'unavailable',
      status: 529,
      dispatched: true,
    },
    {
      index: 1,
      providerId: 'p2',
      model: 'strong-y',
      kind: 'rate_limit',
      dispatched: true,
      leg: 'escalation' as const,
    },
    {
      index: 2,
      providerId: 'p3',
      model: 'grok-z',
      kind: 'unavailable',
      dispatched: false,
      terminal: true,
    },
  ];

  it('renders dispatched failures with kind (+ HTTP status when recorded) and labels skips explicitly', () => {
    const trail = toAttemptTrail({ ...ROW, status: 'error', attemptFailures: entries });
    expect(trail).toEqual([
      {
        model: 'gpt-x',
        label: 'unavailable · HTTP 529',
        legLabel: null,
        skipped: false,
        markers: null,
      },
      {
        model: 'strong-y',
        label: 'rate_limit',
        legLabel: 'escalation',
        skipped: false,
        markers: null,
      },
      {
        model: 'grok-z',
        label: 'skipped — circuit open (provider not contacted)',
        legLabel: null,
        skipped: true,
        markers: null,
      },
    ]);
  });

  it('a null column (all history) yields an empty trail — the drawer renders as before', () => {
    expect(toAttemptTrail(ROW)).toEqual([]);
    expect(toInspectorView(ROW).attemptTrail).toEqual([]);
    expect(toInspectorView(ROW).terminalSkipped).toBe(false);
  });

  it('terminalSkipped keys off the recorded marker only — never inferred from kinds', () => {
    expect(isTerminalSkip({ ...ROW, status: 'error', attemptFailures: entries })).toBe(true);
    // Same kinds, but the terminal-marked entry was DISPATCHED → not a skip note.
    const dispatchedTerminal = [
      { index: 0, providerId: 'p1', model: 'a', kind: 'unavailable', dispatched: false },
      {
        index: 1,
        providerId: 'p2',
        model: 'b',
        kind: 'unavailable',
        dispatched: true,
        terminal: true,
      },
    ];
    expect(isTerminalSkip({ ...ROW, status: 'error', attemptFailures: dispatchedTerminal })).toBe(
      false,
    );
    // A skip with NO marker (e.g. a bad_request stop after a skip) → no note.
    const unmarkedSkip = [
      { index: 0, providerId: 'p1', model: 'a', kind: 'unavailable', dispatched: false },
    ];
    expect(isTerminalSkip({ ...ROW, status: 'error', attemptFailures: unmarkedSkip })).toBe(false);
  });

  it('rides toInspectorView', () => {
    const v = toInspectorView({ ...ROW, status: 'error', attemptFailures: entries });
    expect(v.attemptTrail).toHaveLength(3);
    expect(v.terminalSkipped).toBe(true);
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

  it('a provider-listed snapshot is marked as an estimate (record-listed-price-fallback)', () => {
    const v = toInspectorView({
      ...base,
      cost: 0.02,
      inputPriceSnapshot: 4,
      outputPriceSnapshot: 16,
      priceSource: 'listed',
      priceEstimated: true,
    });
    expect(v.priceSourceLabel).toBe('provider-listed · estimate');
    expect(v.prices[0]!.value).toBe('$4 / 1M · est.');
    expect(v.prices[1]!.value).toBe('$16 / 1M · est.');
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

describe('toInspectorView — workload verdict (add-workload-telemetry)', () => {
  it('maps the class + source verbatim, and null when unevaluated', () => {
    const v = toInspectorView({ ...ROW, workloadClass: 'code', workloadSource: 'structural' });
    expect(v.workloadClass).toBe('code');
    expect(v.workloadSource).toBe('structural');
    const none = toInspectorView({ ...ROW, workloadClass: 'none', workloadSource: 'structural' });
    expect(none.workloadClass).toBe('none');
    const legacy = toInspectorView({ ...ROW, workloadClass: null, workloadSource: null });
    expect(legacy.workloadClass).toBeNull();
    expect(legacy.workloadSource).toBeNull();
  });
});

/** The field-report row (2026-10-27): an `auto` → `workload:research` request whose every
 * chain member was skipped (circuit open). 54,040 estimated input tokens at $2 / 1M used
 * to book $0.1081~; now it is recorded `cost = 0`, `billed = false`, tokens and snapshot kept. */
const FIELD_REPORT: RequestRow = {
  ...ROW,
  id: 'r-field',
  status: 'error',
  inputTokens: 54_040,
  outputTokens: 0,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  inputPriceSnapshot: 2,
  outputPriceSnapshot: 8,
  cacheReadPriceSnapshot: null,
  cacheWritePriceSnapshot: null,
  cost: 0,
  attemptCostMicros: 0,
  usageEstimated: true,
  billed: false,
  priceSource: 'native_family',
  priceEstimated: true,
};

describe('not-billed rows (zero-cost-unbilled-errors)', () => {
  it('the table cell reads `$0 · not billed`, never a ~ estimate', () => {
    expect(rowCostLabel(FIELD_REPORT)).toBe(NOT_BILLED_LABEL);
    expect(rowCostLabel(FIELD_REPORT)).toBe('$0 · not billed');
    expect(rowCostLabel(FIELD_REPORT)).not.toContain('~');
  });

  it('the inspector shows not billed for served AND total, the note flag, and keeps tokens and est. price rows', () => {
    const v = toInspectorView(FIELD_REPORT);
    expect(v.notBilled).toBe(true);
    expect(v.servedCost).toBe('$0 · not billed');
    expect(v.totalCost).toBe('$0 · not billed');
    expect(v.totalCost).not.toContain('est.');
    expect(v.totalMicros).toBe(0);
    // Token counts, the estimate flag and the price rows render exactly as before.
    expect(v.inputTokens).toBe(54_040);
    expect(v.usageEstimated).toBe(true);
    expect(v.priceEstimated).toBe(true);
    expect(v.priceSourceLabel).toBe('native family · estimate');
    expect(v.prices.map((p) => p.value)).toEqual([
      '$2 / 1M · est.',
      '$8 / 1M · est.',
      'unpriced',
      'unpriced',
    ]);
  });

  it('a not-billed PARENT with real attempt cost keeps its normal total, but the served call still reads not billed', () => {
    // A cascade whose cheap call served and was superseded, and whose escalation was then
    // rejected: the parent row is not billed, the attempt ledger holds the cheap call's cost.
    const parent: RequestRow = { ...FIELD_REPORT, attemptCostMicros: 1_500 };
    const v = toInspectorView(parent);
    expect(v.notBilled).toBe(true);
    expect(v.servedCost).toBe('$0 · not billed');
    expect(v.attemptCost).toBe('$0.0015');
    // The real spend is NEVER hidden behind `$0 · not billed`.
    expect(v.totalCost).not.toContain('not billed');
    expect(v.totalCost).toBe('$0.0015 · est.');
    expect(v.totalMicros).toBe(1_500);
    expect(rowCostLabel(parent)).not.toContain('not billed');
    // adopt-figure-states: the table reads the same state, in the same words, as the total.
    expect(rowCostLabel(parent)).toBe('$0.0015 · est.');
    // Without any estimate marker the same total is a plain amount.
    const exact: RequestRow = {
      ...parent,
      usageEstimated: false,
      priceEstimated: false,
      priceSource: 'bundled',
    };
    expect(rowCostLabel(exact)).toBe('$0.0015');
    expect(toInspectorView(exact).totalCost).toBe('$0.0015');
    expect(toInspectorView(exact).servedCost).toBe('$0 · not billed');
  });

  it('free and legacy rows read the vocabulary, and only a `billed = false` row reads not billed', () => {
    // adopt-figure-states (MODIFIED "Free and legacy rows are unchanged"): a free-model row
    // has both price snapshots at zero, and reads `$0 free`; a legacy estimated row priced
    // `native_family` reads `· est.` on its money (its usage is marked on the tokens cell).
    const free: RequestRow = {
      ...ROW,
      id: 'free',
      cost: 0,
      billed: true,
      inputPriceSnapshot: 0,
      outputPriceSnapshot: 0,
    };
    const legacyEstimated: RequestRow = {
      ...ROW,
      id: 'legacy',
      status: 'error',
      billed: null,
      usageEstimated: true,
      cost: 0.0042,
      priceSource: 'native_family',
      priceEstimated: true,
    };
    const legacyZero: RequestRow = { ...legacyEstimated, id: 'legacy0', cost: 0 };
    const paid: RequestRow = { ...ROW, id: 'paid', billed: true };
    // The not-billed row sits mid-collection: a pass here cannot come from index 0.
    const rows = [free, legacyEstimated, FIELD_REPORT, legacyZero, paid];
    expect(rows.map(rowCostLabel)).toEqual([
      '$0 free',
      '$0.0042 · est.',
      '$0 · not billed',
      // a legacy zero-cost row at non-zero prices is a measured zero, NOT retroactively
      // relabelled not billed
      '$0.0000 · est.',
      '$0.0020',
    ]);
    expect(rows.map(rowCostLabel).join(' ')).not.toContain('~');
    expect(rows.map((r) => toInspectorView(r).notBilled)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(rows.map((r) => toInspectorView(r).servedCost)).toEqual([
      '$0 free',
      '$0.0042 · est.',
      '$0 · not billed',
      '$0.0000 · est.',
      '$0.0020',
    ]);
    expect(rows.map((r) => toInspectorView(r).totalCost)).toEqual(rows.map(rowCostLabel));
  });
});

describe('inspector unit prices render at display precision (zero-cost-unbilled-errors)', () => {
  const priced = (over: Partial<RequestRow>): string[] =>
    toInspectorView({ ...ROW, ...over }).prices.map((p) => p.value);

  it('a float-artifact snapshot reads `$0.1 / 1M`, with the est. marker when the source is an estimate', () => {
    const artifact = {
      inputPriceSnapshot: 3,
      outputPriceSnapshot: 15,
      cacheReadPriceSnapshot: 0.09999999999999999,
      cacheWritePriceSnapshot: null,
    };
    expect(priced(artifact)).toEqual(['$3 / 1M', '$15 / 1M', '$0.1 / 1M', 'unpriced']);
    expect(priced({ ...artifact, priceSource: 'native_family' })).toEqual([
      '$3 / 1M · est.',
      '$15 / 1M · est.',
      '$0.1 / 1M · est.',
      'unpriced',
    ]);
  });

  it('ordinary prices, `$0 free` and `unpriced` read as before; real sub-dollar prices keep their digits', () => {
    expect(
      priced({
        inputPriceSnapshot: 0,
        outputPriceSnapshot: 0.0375,
        cacheReadPriceSnapshot: 2.5,
        cacheWritePriceSnapshot: null,
      }),
    ).toEqual(['$0 free', '$0.0375 / 1M', '$2.5 / 1M', 'unpriced']);
    // Display only: the view never rewrites the stored snapshot on the row.
    const row = { ...ROW, cacheReadPriceSnapshot: 0.09999999999999999 };
    toInspectorView(row);
    expect(row.cacheReadPriceSnapshot).toBe(0.09999999999999999);
  });
});

// fix-bad-request-dead-end: the operator-facing half of the reported incident. A
// RECOVERED request has no terminal error but very much has a trail, and a WITHHELD
// message is only diagnosable through the retained classification.
describe('toErrorView / toAttemptTrail — recovered rows and withheld messages', () => {
  it('a fallback row renders NO error card but DOES render its trail', () => {
    const row = {
      ...ROW,
      status: 'fallback',
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: [
        {
          index: 0,
          providerId: 'p1',
          model: 'mimo-v2.5-pro',
          kind: 'bad_request',
          status: 400,
          dispatched: true,
          markers: ['context_length_exceeded'],
        },
      ],
    } as unknown as RequestRow;
    expect(toErrorView(row)).toBeNull(); // no terminal error → no card
    const trail = toAttemptTrail(row);
    expect(trail).toHaveLength(1);
    expect(trail[0]!.model).toBe('mimo-v2.5-pro');
    expect(trail[0]!.label).toBe('bad_request · HTTP 400');
    expect(trail[0]!.markers).toEqual(['context_length_exceeded']);
  });

  it('a withheld message still shows its classification on the card', () => {
    const row = {
      ...ROW,
      status: 'error',
      errorKind: 'bad_request',
      errorStatus: 400,
      errorMessage: '[validation message withheld]',
      errorRequestId: null,
      errorMarkers: ['context_length_exceeded'],
    } as unknown as RequestRow;
    const ev = toErrorView(row);
    expect(ev?.markers).toEqual(['context_length_exceeded']);
    expect(ev?.message).toBe('[validation message withheld]');
  });

  it('an empty marker list normalizes to null — the row drops, never renders empty', () => {
    const row = {
      ...ROW,
      status: 'error',
      errorKind: 'unavailable',
      errorStatus: 503,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: [],
    } as unknown as RequestRow;
    expect(toErrorView(row)?.markers).toBeNull();
  });

  it('markers ALONE summon the card — a row with nothing else is still diagnosable', () => {
    const row = {
      ...ROW,
      status: 'error',
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: ['upstream_oversized'],
    } as unknown as RequestRow;
    expect(toErrorView(row)?.markers).toEqual(['upstream_oversized']);
  });
});
