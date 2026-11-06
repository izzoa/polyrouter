import { describe, expect, it } from 'vitest';
import {
  AGENT_UNATTRIBUTED,
  breakdownToSpend,
  escalationRate,
  fallbackRate,
  filterToRequestParams,
  NOT_BILLED_NOTE,
  rowCostLabel,
  rowCostParts,
  isTerminalSkip,
  routeTraceCaption,
  SKIP_LABEL,
  SNAPSHOT_CAPTION_BATCH,
  SNAPSHOT_CAPTION_SYNC,
  successRate,
  timeseriesToChart,
  toErrorView,
  toInspectorView,
  toRouteTrace,
  TRACE_NOT_RECORDED,
  USAGE_ESTIMATED_NOTE,
  type RouteTraceAttemptNode,
  type RouteTraceNode,
  type RouteTraceOutcomeNode,
  type RouteTraceSupersededNode,
} from './analytics';
import {
  labelOf,
  totalCostMicros,
  type AnalyticsSummary,
  type AttemptFailureEntry,
  type RequestRow,
  type RequestStatus,
  type TimeseriesPoint,
} from './api';
import { fmtElapsed } from './batchBand';
import { fmtLatency, NOT_BILLED } from './figures';

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
  escalationSource: null,
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

/** The trace's attempt nodes, in drawn order. */
const attemptsOf = (nodes: readonly RouteTraceNode[]): RouteTraceAttemptNode[] =>
  nodes.filter((n): n is RouteTraceAttemptNode => n.kind === 'attempt');
/** The trace's one outcome node (it is always the last). */
const outcomeOf = (nodes: readonly RouteTraceNode[]): RouteTraceOutcomeNode => {
  const last = nodes[nodes.length - 1];
  if (last?.kind !== 'outcome') throw new Error('the trace must end in its outcome node');
  return last;
};
const supersededOf = (nodes: readonly RouteTraceNode[]): RouteTraceSupersededNode | undefined =>
  nodes.find((n): n is RouteTraceSupersededNode => n.kind === 'superseded');
/** The trace as the plain text of each node, in drawn order. */
const traceTexts = (r: RequestRow): string[] => toRouteTrace(r).map((n) => n.text);
/** A figure's parts as their joined text (null stays null). */
const partsTextOf = (parts: readonly { text: string }[] | null): string | null =>
  parts === null ? null : parts.map((p) => p.text).join(' ');

/** One recorded attempt entry: a dispatched `rate_limit` failure unless overridden. */
const entry = (over: Partial<AttemptFailureEntry> & { model: string }): AttemptFailureEntry => ({
  index: 0,
  providerId: 'p',
  kind: 'rate_limit',
  dispatched: true,
  ...over,
});

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

describe('toRouteTrace / isTerminalSkip — the structural fallback trail (add-fallback-attempt-detail, folded into the route trace)', () => {
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
    const trail = attemptsOf(toRouteTrace({ ...ROW, status: 'error', attemptFailures: entries }));
    expect(trail).toEqual([
      {
        kind: 'attempt',
        emphasis: 'failed',
        model: 'gpt-x',
        label: 'unavailable · HTTP 529',
        markers: null,
        leg: null,
        text: 'gpt-x · unavailable · HTTP 529',
      },
      {
        kind: 'attempt',
        emphasis: 'failed',
        model: 'strong-y',
        label: 'rate_limit',
        markers: null,
        leg: 'escalation',
        text: 'strong-y · rate_limit · escalation',
      },
      {
        kind: 'attempt',
        emphasis: 'skipped',
        model: 'grok-z',
        label: 'skipped — circuit open (provider not contacted)',
        markers: null,
        leg: null,
        text: 'grok-z · skipped — circuit open (provider not contacted)',
      },
    ]);
    expect(SKIP_LABEL).toBe('skipped — circuit open (provider not contacted)');
  });

  it('a null column (all history) draws no attempt node — source, decision and outcome only', () => {
    expect(attemptsOf(toRouteTrace(ROW))).toEqual([]);
    expect(toInspectorView(ROW).trace.map((n) => n.kind)).toEqual([
      'source',
      'decision',
      'outcome',
    ]);
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
    expect(attemptsOf(v.trace)).toHaveLength(3);
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
    expect(rowCostLabel(FIELD_REPORT)).toBe(NOT_BILLED);
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
describe('toErrorView / toRouteTrace — recovered rows and withheld messages', () => {
  it('a fallback row renders NO error card but DOES draw its trail', () => {
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
    const trail = attemptsOf(toRouteTrace(row));
    expect(trail).toHaveLength(1);
    expect(trail[0]!.model).toBe('mimo-v2.5-pro');
    expect(trail[0]!.label).toBe('bad_request · HTTP 400');
    expect(trail[0]!.markers).toEqual(['context_length_exceeded']);
    expect(trail[0]!.text).toBe('mimo-v2.5-pro · bad_request · HTTP 400 · context_length_exceeded');
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

/* ---- add-route-trace-inspector: the route trace (tasks 3.1–3.4) -------------------- */

/** dashboard-analytics "The inspector draws the recorded route as a trace" (task 3.1). */
describe('toRouteTrace — the recorded route as a trace (add-route-trace-inspector 3.1)', () => {
  it('a fallback request draws its walk, not its tier: no node for the unwalked member C', () => {
    // Tier `heavy` is [A, B, C]: A was rejected (rate_limit, HTTP 429) and B served.
    const r: RequestRow = {
      ...ROW,
      status: 'fallback',
      tierAssigned: 'heavy',
      decisionLayer: 'explicit',
      routingReason: 'tier heavy: model-a → model-b → model-c; model-a rate_limit (429)',
      modelId: 'model-b',
      modelLabel: 'Model B',
      providerLabel: 'Provider B',
      attemptFailures: [entry({ model: 'model-a', status: 429 })],
    };
    expect(traceTexts(r)).toEqual([
      'openclaw',
      'router · explicit',
      'model-a · rate_limit · HTTP 429',
      'Provider B · Model B · served · 1.20s',
    ]);
    // C is named only by the verbatim reason (which still renders), never by the trace, and
    // the tier itself is the Decision section's `tier` row, not a trace node.
    expect(traceTexts(r).join(' ')).not.toContain('model-c');
    expect(traceTexts(r).join(' ')).not.toContain('heavy');
    // The inspector's trace is this function's output for the row. "Editing the tier afterwards
    // leaves the trace unchanged" is rendered in `routeTrace.view.test.tsx`, which edits the
    // tier (removing B, adding D) while the inspector is open.
    expect(toInspectorView(r).trace).toEqual(toRouteTrace(r));
  });

  it('the source node reads the agent label, or `(no agent)`, never the raw agent id', () => {
    const keyless: RequestRow = { ...ROW, agentId: null, agentLabel: null };
    const deleted: RequestRow = { ...ROW, agentId: 'agent-raw-7f3a', agentLabel: null };
    for (const r of [keyless, deleted]) {
      const [source] = toRouteTrace(r);
      expect(source).toEqual({ kind: 'source', emphasis: 'neutral', text: '(no agent)' });
      expect(source!.text).toBe(AGENT_UNATTRIBUTED);
      expect(traceTexts(r).join(' ')).not.toContain('agent-raw-7f3a');
    }
    expect(toRouteTrace(ROW)[0]!.text).toBe('openclaw');
  });

  it('the decision chip names any layer verbatim and neutrally, never blank', () => {
    for (const layer of ['workload', 'explicit', 'cascade', 'l9_quantum_vibes']) {
      const decision = toRouteTrace({ ...ROW, decisionLayer: layer })[1];
      expect(decision).toEqual({
        kind: 'decision',
        emphasis: 'neutral',
        layer,
        text: `router · ${layer}`,
      });
    }
  });

  it('a cascade walk keeps its stored leg order, even though leg-relative indexes collide', () => {
    // Stored walk order, cheap leg first: indexes 0, 1, then 0 again on the escalation
    // leg. Sorting by index would interleave the legs (cheap 0, escalation 0, cheap 1).
    const r: RequestRow = {
      ...ROW,
      decisionLayer: 'cascade',
      status: 'fallback',
      escalated: true,
      escalationSource: 'cheap_error',
      attemptFailures: [
        entry({ index: 0, model: 'cheap-1', kind: 'unavailable', leg: 'cheap' }),
        entry({ index: 1, model: 'cheap-2', kind: 'timeout', leg: 'cheap' }),
        entry({ index: 0, model: 'strong-1', status: 429, leg: 'escalation' }),
      ],
    };
    const attempts = attemptsOf(toRouteTrace(r));
    expect(attempts.map((a) => a.model)).toEqual(['cheap-1', 'cheap-2', 'strong-1']);
    expect(attempts.map((a) => a.leg)).toEqual(['cheap leg', 'cheap leg', 'escalation']);
    expect(attempts.map((a) => a.text)).toEqual([
      'cheap-1 · unavailable · cheap leg',
      'cheap-2 · timeout · cheap leg',
      'strong-1 · rate_limit · HTTP 429 · escalation',
    ]);
    // A primary (non-cascade) chain records no leg, so it carries no tag.
    expect(
      attemptsOf(toRouteTrace({ ...ROW, attemptFailures: [entry({ model: 'a' })] }))[0]!.leg,
    ).toBe(null);
  });

  it('an error row with detail keeps its ERROR card AND its trace, which still ends in its outcome', () => {
    const r: RequestRow = {
      ...ROW,
      status: 'error',
      errorKind: 'rate_limit',
      errorStatus: 429,
      attemptFailures: [entry({ model: 'a', status: 429, terminal: true })],
    };
    const v = toInspectorView(r);
    expect(v.errorView?.headline).toBe('rate_limit · HTTP 429');
    expect(v.trace.map((n) => n.kind)).toEqual(['source', 'decision', 'attempt', 'outcome']);
    expect(v.routingReason).toBe(ROW.routingReason);
  });
});

/** dashboard-analytics "The route trace lights only a served outcome" (task 3.1). */
describe('the route trace lights only a served outcome (add-route-trace-inspector 3.1)', () => {
  it('a served request lights only its outcome, which names the provider and the model', () => {
    for (const status of ['success', 'fallback'] as const) {
      const r: RequestRow = {
        ...ROW,
        status,
        providerLabel: 'P',
        modelLabel: 'M',
        durationMs: 1_240,
        attemptFailures: status === 'fallback' ? [entry({ model: 'a', status: 429 })] : null,
      };
      const trace = toRouteTrace(r);
      expect(outcomeOf(trace)).toEqual({
        kind: 'outcome',
        emphasis: 'lit',
        provider: 'P',
        model: 'M',
        result: 'served',
        latency: '1.24s',
        text: 'P · M · served · 1.24s',
      });
      // Exactly one outcome node, and it is the only lit node.
      expect(trace.filter((n) => n.kind === 'outcome')).toHaveLength(1);
      expect(trace.filter((n) => n.emphasis === 'lit')).toEqual([outcomeOf(trace)]);
    }
    // With no labels the outcome falls back to the recorded ids, never to `unknown`.
    const ids = outcomeOf(toRouteTrace({ ...ROW, providerLabel: null, modelLabel: null }));
    expect([ids.provider, ids.model]).toEqual(['p1', 'm1']);
  });

  it('an exhausted chain ends unlit in `failed · <latency>`, without naming a model again', () => {
    // Both members are on the recorded provider, so it is the last one tried (flag RF-1).
    const r: RequestRow = {
      ...ROW,
      status: 'error',
      durationMs: 2_100,
      attemptFailures: [
        entry({ index: 0, providerId: 'p1', model: 'a', status: 429 }),
        entry({
          index: 1,
          providerId: 'p1',
          model: 'b',
          kind: 'unavailable',
          status: 503,
          terminal: true,
        }),
      ],
    };
    const trace = toRouteTrace(r);
    expect(trace.map((n) => n.text).slice(2)).toEqual([
      'a · rate_limit · HTTP 429',
      'b · unavailable · HTTP 503',
      'OpenAI · failed · 2.10s',
    ]);
    expect(outcomeOf(trace)).toMatchObject({
      emphasis: 'neutral',
      provider: 'OpenAI',
      model: null,
      result: 'failed',
    });
    expect(trace.some((n) => n.emphasis === 'lit')).toBe(false);
  });

  it('an error with no terminal-marked entry names the recorded model, when one is recorded', () => {
    const legacy: RequestRow = { ...ROW, status: 'error', attemptFailures: null };
    expect(outcomeOf(toRouteTrace(legacy)).text).toBe('OpenAI · GPT · failed · 1.20s');
    // A post-commit stream failure after an earlier failed member: no entry carries the
    // terminal marker, and the row records the committed member, which the trail never holds.
    const committed: RequestRow = {
      ...legacy,
      attemptFailures: [entry({ model: 'a', status: 429 })],
    };
    expect(outcomeOf(toRouteTrace(committed)).text).toBe('OpenAI · GPT · failed · 1.20s');
    expect(outcomeOf(toRouteTrace({ ...legacy, modelLabel: null })).model).toBe('m1');
    // No model recorded at all: the outcome still reads, with no blank slot.
    expect(outcomeOf(toRouteTrace({ ...legacy, modelLabel: null, modelId: null })).text).toBe(
      'OpenAI · failed · 1.20s',
    );
    for (const r of [legacy, committed]) {
      expect(toRouteTrace(r).some((n) => n.emphasis === 'lit')).toBe(false);
    }
  });

  it('a cancelled request is unlit, names the recorded provider and model, and reads `cancelled by client`', () => {
    const r: RequestRow = { ...ROW, status: 'cancelled', durationMs: 800 };
    expect(outcomeOf(toRouteTrace(r))).toEqual({
      kind: 'outcome',
      emphasis: 'neutral',
      provider: 'OpenAI',
      model: 'GPT',
      result: 'cancelled by client',
      latency: '800ms',
      text: 'OpenAI · GPT · cancelled by client · 800ms',
    });
  });

  it('an unrecognised status renders unlit and verbatim, and never blank', () => {
    // `RequestStatus` admits any recorded string, so an unrecognised value needs no cast.
    const odd: RequestRow = { ...ROW, status: 'throttled' };
    expect(outcomeOf(toRouteTrace(odd))).toMatchObject({
      emphasis: 'neutral',
      provider: 'OpenAI',
      model: null,
      result: 'throttled',
      text: 'OpenAI · throttled · 1.20s',
    });
    const blank: RequestRow = { ...ROW, status: '' };
    expect(outcomeOf(toRouteTrace(blank)).text).toBe('OpenAI · unknown · 1.20s');
  });

  it('an unlit outcome names the recorded provider only when it was the last one tried (flag RF-1)', () => {
    // The recorder records a failed walk against its final leg's FIRST member. An exhausted
    // chain whose terminal entry is on another provider therefore keeps today's text.
    const exhausted: RequestRow = {
      ...ROW,
      status: 'error',
      durationMs: 2_100,
      attemptFailures: [
        entry({ index: 0, providerId: 'p1', model: 'a', status: 429 }),
        entry({ index: 1, providerId: 'p2', model: 'b', status: 503, terminal: true }),
      ],
    };
    expect(outcomeOf(toRouteTrace(exhausted))).toMatchObject({
      provider: null,
      text: 'failed · 2.10s',
    });
    // A terminal entry that recorded no provider id cannot confirm it either.
    const unknownTerminal: RequestRow = {
      ...exhausted,
      attemptFailures: [entry({ providerId: null, model: 'b', status: 503, terminal: true })],
    };
    expect(outcomeOf(toRouteTrace(unknownTerminal)).text).toBe('failed · 2.10s');
    // A non-retryable stop after a failed member is recorded against that first member, which
    // the trail holds; the member that stopped the walk is not in it.
    const stopped: RequestRow = {
      ...ROW,
      status: 'error',
      attemptFailures: [entry({ providerId: 'p1', model: 'a', status: 429 })],
    };
    expect(outcomeOf(toRouteTrace(stopped))).toMatchObject({
      provider: null,
      text: 'GPT · failed · 1.20s',
    });
    // With no provider label, the recorded id; with no provider recorded, today's text.
    const cancelled: RequestRow = { ...ROW, status: 'cancelled', durationMs: 800 };
    expect(outcomeOf(toRouteTrace({ ...cancelled, providerLabel: null })).text).toBe(
      'p1 · GPT · cancelled by client · 800ms',
    );
    for (const [r, today] of [
      [cancelled, 'GPT · cancelled by client · 800ms'],
      [{ ...ROW, status: 'error' }, 'GPT · failed · 1.20s'],
      [{ ...ROW, status: 'throttled' }, 'throttled · 1.20s'],
    ] as const) {
      const none: RequestRow = { ...r, providerLabel: null, providerId: null };
      expect(outcomeOf(toRouteTrace(none))).toMatchObject({ provider: null, text: today });
    }
  });

  it("a batch item's outcome reads the job's wall time, in the table's latency format", () => {
    const wall = 3 * 3_600_000 + 60_000;
    const item: RequestRow = {
      ...ROW,
      decisionLayer: 'explicit',
      batchId: 'batch_01',
      priceMode: 'batch',
      durationMs: wall,
    };
    const trace = toRouteTrace(item);
    expect(trace[1]!.text).toBe('router · explicit');
    expect(outcomeOf(trace)).toMatchObject({ result: 'served', latency: '3h 1m' });
    expect(outcomeOf(trace).latency).toBe(fmtElapsed(wall));
    // The table's predicate: either column alone makes a batch item.
    expect(outcomeOf(toRouteTrace({ ...item, batchId: null })).latency).toBe('3h 1m');
    expect(outcomeOf(toRouteTrace({ ...item, priceMode: null })).latency).toBe('3h 1m');
    // A synchronous row keeps `fmtLatency`.
    expect(outcomeOf(toRouteTrace({ ...ROW, durationMs: 125_000 })).latency).toBe(
      fmtLatency(125_000),
    );
    // The Decision section still states the explicit layer beside the batch mode and job.
    const v = toInspectorView(item);
    expect([v.decisionLayer, v.batchId, v.routingReason]).toEqual([
      'explicit',
      'batch_01',
      ROW.routingReason,
    ]);
  });
});

/** dashboard-analytics "The route trace shows a superseded cascade call only from what was
 * recorded" (task 3.2). */
describe('the superseded cascade call, drawn only from what was recorded (add-route-trace-inspector 3.2)', () => {
  /** A quality-gate escalation the strong model served, exactly priced, with a superseded
   * cheap call that cost 3,100 µ$ and no cheap-leg failures. */
  const GATED: RequestRow = {
    ...ROW,
    decisionLayer: 'cascade',
    escalated: true,
    escalationSource: 'quality_gate',
    qualitySignal: 0.42,
    attemptCostMicros: 3_100,
    priceSource: 'bundled',
    priceEstimated: false,
    modelId: 'strong-model',
    modelLabel: 'Strong',
    providerLabel: 'Anthropic',
  };

  it('a quality-gate escalation shows the superseded call between the decision and the outcome', () => {
    const trace = toRouteTrace(GATED);
    expect(trace.map((n) => n.text)).toEqual([
      'openclaw',
      'router · cascade',
      'cheap attempt superseded · q=0.42 · $0.0031',
      'Anthropic · Strong · served · 1.20s',
    ]);
    const node = supersededOf(trace)!;
    expect(node).toMatchObject({ emphasis: 'neutral', quality: 'q=0.42' });
    // It names no model: the listing carries none for the superseded call.
    expect(Object.keys(node)).not.toContain('model');
    expect(node.text).not.toContain('Strong');
    expect(node.text).not.toContain('strong-model');
  });

  it('an attempt cost is marked as an estimate only when the listing can tell', () => {
    // Exact served price, flag set: the flag can only have come from an attempt.
    const flagged: RequestRow = { ...GATED, priceEstimated: true };
    expect(supersededOf(toRouteTrace(flagged))!.text).toBe(
      'cheap attempt superseded · q=0.42 · $0.0031 · est.',
    );
    const fv = toInspectorView(flagged);
    expect(partsTextOf(fv.attemptsRowParts)).toBe('$0.0031 · est.');
    // Flag unset: neither attempt figure is marked.
    const exact = toInspectorView(GATED);
    expect(supersededOf(exact.trace)!.text).toBe('cheap attempt superseded · q=0.42 · $0.0031');
    expect(partsTextOf(exact.attemptsRowParts)).toBe('$0.0031');
    // The served price is itself an estimate: the listing cannot say whether the attempt was
    // too, so neither attempt figure is marked, and the total is.
    for (const priceSource of ['native_family', 'listed']) {
      const v = toInspectorView({ ...GATED, priceSource, priceEstimated: true });
      expect(supersededOf(v.trace)!.text).toBe('cheap attempt superseded · q=0.42 · $0.0031');
      expect(partsTextOf(v.attemptsRowParts)).toBe('$0.0031');
      expect(v.totalCost.endsWith(' · est.')).toBe(true);
    }
  });

  it('a superseded call sits between its legs: after the last cheap entry, before the escalation', () => {
    const r: RequestRow = {
      ...GATED,
      status: 'fallback',
      attemptFailures: [
        entry({ index: 0, model: 'cheap-1', kind: 'unavailable', leg: 'cheap' }),
        entry({ index: 1, model: 'cheap-2', kind: 'unavailable', leg: 'cheap' }),
        entry({ index: 0, model: 'strong-1', status: 429, leg: 'escalation' }),
      ],
    };
    expect(toRouteTrace(r).map((n) => n.kind)).toEqual([
      'source',
      'decision',
      'attempt',
      'attempt',
      'superseded',
      'attempt',
      'outcome',
    ]);
    expect(traceTexts(r).slice(3, 6)).toEqual([
      'cheap-2 · unavailable · cheap leg',
      'cheap attempt superseded · q=0.42 · $0.0031',
      'strong-1 · rate_limit · HTTP 429 · escalation',
    ]);
  });

  it('a failed cheap leg is not a superseded answer: no node, no `q=`, a `cheap leg` attempt', () => {
    const r: RequestRow = {
      ...GATED,
      escalationSource: 'cheap_error',
      qualitySignal: 0, // the legacy score a cheap_error row may carry
      attemptCostMicros: 0,
      attemptFailures: [entry({ model: 'cheap-1', kind: 'unavailable', leg: 'cheap' })],
    };
    const trace = toRouteTrace(r);
    expect(supersededOf(trace)).toBeUndefined();
    expect(attemptsOf(trace).map((a) => a.leg)).toEqual(['cheap leg']);
    expect(trace.some((n) => /q=/.test(n.text))).toBe(false);
    // A cheap_error escalation whose superseded call did cost money (a passing verdict whose
    // replay failed) draws the node from that cost, still with no `q=`.
    const replayed = supersededOf(toRouteTrace({ ...r, attemptCostMicros: 3_100 }))!;
    expect(replayed.text).toBe('cheap attempt superseded · $0.0031');
  });

  it('a legacy escalation draws only what it recorded', () => {
    const legacy: RequestRow = { ...GATED, escalationSource: null };
    expect(supersededOf(toRouteTrace(legacy))!.text).toBe('cheap attempt superseded · $0.0031');
    expect(supersededOf(toRouteTrace({ ...legacy, attemptCostMicros: 0 }))).toBeUndefined();
    // A quality-gate row with no recorded score and no attempt cost: the label alone.
    const bare = supersededOf(
      toRouteTrace({ ...GATED, qualitySignal: null, attemptCostMicros: 0 }),
    )!;
    expect(bare).toMatchObject({
      quality: null,
      costParts: null,
      text: 'cheap attempt superseded',
    });
    // A row that did not escalate never draws one (a passing cascade with a signal).
    expect(supersededOf(toRouteTrace({ ...GATED, escalated: false, escalationSource: null }))).toBe(
      undefined,
    );
  });

  it("over a fixture matrix, the superseded node's cost is the receipt's attempt parts, never re-derived", () => {
    const sources: ('quality_gate' | 'cheap_error' | null)[] = [
      'quality_gate',
      'cheap_error',
      null,
    ];
    const prices: [string | null, boolean][] = [
      [null, false],
      ['bundled', false],
      ['bundled', true],
      ['native_family', true],
      ['listed', true],
    ];
    const trails: (AttemptFailureEntry[] | null)[] = [
      null,
      [entry({ model: 'c', leg: 'cheap' })],
      [entry({ model: 'c', leg: 'cheap' }), entry({ model: 's', leg: 'escalation' })],
      [entry({ model: 's', leg: 'escalation' })],
    ];
    let drawn = 0;
    let checked = 0;
    for (const escalated of [true, false])
      for (const escalationSource of escalated ? sources : [null])
        for (const attemptCostMicros of [0, 40, 3_100])
          for (const qualitySignal of [null, 0, 0.42])
            for (const [priceSource, priceEstimated] of prices)
              for (const attemptFailures of trails) {
                const r: RequestRow = {
                  ...ROW,
                  decisionLayer: 'cascade',
                  status: attemptFailures === null ? 'success' : 'fallback',
                  escalated,
                  escalationSource,
                  attemptCostMicros,
                  qualitySignal,
                  priceSource,
                  priceEstimated,
                  attemptFailures,
                };
                const v = toInspectorView(r);
                expect(v.trace).toEqual(toRouteTrace(r));
                const node = supersededOf(v.trace);
                const expected =
                  escalated && (escalationSource === 'quality_gate' || attemptCostMicros > 0);
                expect(node !== undefined, JSON.stringify(r.attemptFailures)).toBe(expected);
                checked += 1;
                if (node === undefined) continue;
                drawn += 1;
                if (attemptCostMicros > 0) {
                  // The same parts, as data and as the very array the receipt row renders.
                  expect(node.costParts).toEqual(v.attemptParts);
                  expect(node.costParts).toBe(v.attemptsRowParts);
                  expect(supersededOf(toRouteTrace(r))!.costParts).toEqual(v.attemptParts);
                } else {
                  expect(node.costParts).toBeNull();
                  expect(v.attemptsRowParts).toBeNull();
                }
                expect(node.quality !== null).toBe(
                  escalationSource === 'quality_gate' && qualitySignal !== null,
                );
                // Never after an escalation-leg entry, never before a cheap-leg one.
                const at = v.trace.indexOf(node);
                const legs = attemptsOf(v.trace).map((a) => [v.trace.indexOf(a), a.leg] as const);
                for (const [i, leg] of legs)
                  expect(leg === 'cheap leg' ? i < at : i > at).toBe(true);
              }
    expect(checked).toBe((3 + 1) * 3 * 3 * 5 * 4);
    expect(drawn).toBeGreaterThan(0);
  });
});

/** dashboard-analytics "The inspector draws the recorded route as a trace", scenario "A
 * recovered request without recorded attempts says so" (task 3.3). */
describe('the trace caption (add-route-trace-inspector 3.3)', () => {
  it('only a recovered (`fallback`) row with null attempts says its history was not recorded', () => {
    const recovered: RequestRow = { ...ROW, status: 'fallback', attemptFailures: null };
    expect(TRACE_NOT_RECORDED).toBe('attempt history was not recorded for this request');
    expect(routeTraceCaption(recovered)).toBe(TRACE_NOT_RECORDED);
    const v = toInspectorView(recovered);
    expect(v.traceCaption).toBe(TRACE_NOT_RECORDED);
    expect(v.trace.map((n) => n.kind)).toEqual(['source', 'decision', 'outcome']);
    expect(outcomeOf(v.trace).emphasis).toBe('lit');
  });

  it('an error, success or cancelled row with null attempts, and a recorded fallback, show none', () => {
    for (const status of ['error', 'success', 'cancelled'] as const) {
      expect(toInspectorView({ ...ROW, status, attemptFailures: null }).traceCaption).toBeNull();
    }
    const recorded: RequestRow = {
      ...ROW,
      status: 'fallback',
      attemptFailures: [entry({ model: 'a', status: 429 })],
    };
    expect(toInspectorView(recorded).traceCaption).toBeNull();
  });
});

/** dashboard-analytics "The route trace draws no commit marker until commit time is
 * recorded" (task 3.4). */
describe('no commit marker (add-route-trace-inspector 3.4)', () => {
  /** A time figure in either latency format: `412ms`, `1.24s`, `2m 05s`, `45s`, `12m`,
   * `3h 1m`. */
  const TIME = /\d+h \d+m|\d+m \d{2}s|\d+(?:\.\d+)?(?:ms|s|m)\b/g;

  it('over every status, no node mentions a first token or a commit, and only the outcome carries a time', () => {
    const statuses: RequestStatus[] = ['success', 'fallback', 'error', 'cancelled', 'throttled'];
    const shapes: Partial<RequestRow>[] = [
      {},
      {
        attemptFailures: [
          entry({ model: 'a', status: 429 }),
          entry({ model: 'b', dispatched: false, terminal: true }),
        ],
      },
      {
        decisionLayer: 'cascade',
        escalated: true,
        escalationSource: 'quality_gate',
        qualitySignal: 0.42,
        attemptCostMicros: 3_100,
        attemptFailures: [entry({ model: 'c', leg: 'cheap' })],
      },
      { batchId: 'batch_01', priceMode: 'batch', durationMs: 7_412_300 },
      { durationMs: 412 },
      { durationMs: 125_000 },
    ];
    let checked = 0;
    for (const status of statuses)
      for (const shape of shapes) {
        const r: RequestRow = { ...ROW, ...shape, status };
        const trace = toRouteTrace(r);
        for (const n of trace) expect(n.text).not.toMatch(/first token|commit/i);
        const outcome = outcomeOf(trace);
        expect(outcome.text.match(TIME)).toEqual([outcome.latency]);
        for (const n of trace.slice(0, -1)) expect(n.text.match(TIME)).toBeNull();
        checked += 1;
      }
    expect(checked).toBe(statuses.length * shapes.length);
  });
});

/* ---- add-route-trace-inspector: the price receipt (task 3.5) ----------------------- */

/** dashboard-analytics "The inspector's price receipt states its provenance". */
describe('the price receipt states its provenance (add-route-trace-inspector 3.5)', () => {
  it('a synchronous receipt names its completion snapshot, and nothing claims an issue-time one', () => {
    expect(SNAPSHOT_CAPTION_SYNC).toBe(
      'Recorded with the request — later price changes never apply.',
    );
    for (const priceMode of [null, 'sync'] as const) {
      const v = toInspectorView({ ...ROW, priceMode });
      expect(v.receiptCaption).toBe(SNAPSHOT_CAPTION_SYNC);
      // No view string, anywhere, says the price was fixed when the request was issued.
      expect(JSON.stringify(v)).not.toMatch(/snapshotted\s+at\s+request\s+time/i);
    }
    // The default footnote is gone: an ordinary row has no note at all.
    expect(toInspectorView(ROW).receiptNote).toBeNull();
  });

  it('a batch receipt names submission pricing, and its source row keeps the provenance', () => {
    expect(SNAPSHOT_CAPTION_BATCH).toBe('Batch rate, recorded at submission.');
    const batch: RequestRow = { ...ROW, batchId: 'b1', priceMode: 'batch', priceSource: 'bundled' };
    const v = toInspectorView(batch);
    expect(v.receiptCaption).toBe(SNAPSHOT_CAPTION_BATCH);
    expect(v.receiptSource).toBe('batch · bundled');
    expect(
      toInspectorView({ ...batch, priceSource: 'native_family', priceEstimated: true })
        .receiptSource,
    ).toBe('batch · native family · estimate');
    expect(toInspectorView({ ...ROW, priceSource: 'bundled' }).receiptSource).toBe('bundled');
    expect(toInspectorView({ ...ROW, priceSource: null }).receiptSource).toBeNull();
  });

  it('an unpriced request makes no snapshot claim: no caption, an `unpriced` total, no `$0.00`', () => {
    const v = toInspectorView({
      ...ROW,
      cost: null,
      inputPriceSnapshot: null,
      outputPriceSnapshot: null,
      cacheReadPriceSnapshot: null,
      cacheWritePriceSnapshot: null,
    });
    expect(v.receiptCaption).toBeNull();
    expect(v.totalCost).toBe('unpriced');
    expect(v.tokenRows.map((t) => t.text)).toEqual([
      '1,000 × unpriced',
      '500 × unpriced',
      '10 × unpriced',
      '20 × unpriced',
    ]);
    // What the receipt draws: the token rows, the served and total rows, and no attempts row
    // (the attempt cost is zero). DS-3's always-computed `attemptCost` is not drawn.
    const drawn = [
      ...v.tokenRows.map((t) => t.text),
      v.servedCost,
      v.totalCost,
      partsTextOf(v.attemptsRowParts),
    ];
    expect(drawn).toEqual([...drawn.slice(0, 4), 'unpriced', 'unpriced', null]);
    expect(drawn.join(' ')).not.toContain('$0.00');
  });

  it('a provider-listed estimate names its source and marks every priced figure and the total', () => {
    const v = toInspectorView({
      ...ROW,
      cost: 0.02,
      inputPriceSnapshot: 4,
      outputPriceSnapshot: 16,
      cacheReadPriceSnapshot: 0.4,
      priceSource: 'listed',
      priceEstimated: true,
    });
    expect(v.receiptSource).toBe('provider-listed · estimate');
    const priced = v.tokenRows.filter((t) => partsTextOf(t.priceParts) !== 'unpriced');
    expect(priced.map((t) => partsTextOf(t.priceParts))).toEqual([
      '$4 / 1M · est.',
      '$16 / 1M · est.',
      '$0.4 / 1M · est.',
    ]);
    expect(v.totalCost).toBe('$0.0200 · est.');
  });
});

/** dashboard-analytics "The price receipt itemises the snapshot and totals it exactly". */
describe('the price receipt itemises the snapshot and totals it exactly (add-route-trace-inspector 3.5)', () => {
  it('each token class reads count × unit price; a null cache count shows the price alone', () => {
    const v = toInspectorView({
      ...ROW,
      inputTokens: 1_204,
      outputTokens: 310,
      inputPriceSnapshot: 3,
      outputPriceSnapshot: 15,
      cacheReadTokens: null,
      cacheReadPriceSnapshot: 0.3,
      cacheWriteTokens: null,
      cacheWritePriceSnapshot: null,
    });
    expect(v.tokenRows.map((t) => [t.label, t.text])).toEqual([
      ['input', '1,204 × $3 / 1M'],
      ['output', '310 × $15 / 1M'],
      ['cache read', '$0.3 / 1M'],
    ]);
    expect(v.tokenRows[2]!.countParts).toBeNull();
    // Input and output always render, a recorded zero count included; a cache count with no
    // snapshot still renders, priced `unpriced`.
    const zero = toInspectorView({
      ...ROW,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheReadPriceSnapshot: null,
      cacheWriteTokens: 12,
      cacheWritePriceSnapshot: null,
    });
    expect(zero.tokenRows.map((t) => t.text)).toEqual([
      '1,000 × $1.5 / 1M',
      '0 × $6 / 1M',
      '12 × unpriced',
    ]);
  });

  it('the total is the integer micro-dollar sum, never a sum of the rounded rows', () => {
    const v = toInspectorView({ ...ROW, cost: 0.012346, attemptCostMicros: 3_100 });
    expect(v.servedCost).toBe('$0.0123');
    expect(partsTextOf(v.attemptsRowParts)).toBe('$0.0031');
    expect(v.totalMicros).toBe(12_346 + 3_100);
    expect(v.totalCost).toBe('$0.0154');
    // Here the rounded rows would sum to $0.0156 (0.0124 + 0.0032); the exact total is
    // 15,500 µ$, which reads $0.0155.
    const halves = toInspectorView({ ...ROW, cost: 0.01235, attemptCostMicros: 3_150 });
    expect([halves.servedCost, partsTextOf(halves.attemptsRowParts)]).toEqual([
      '$0.0124',
      '$0.0032',
    ]);
    expect(halves.totalMicros).toBe(15_500);
    expect(halves.totalCost).toBe('$0.0155');
  });

  it('no attempts row without attempt cost, and the total equals the served cost', () => {
    const v = toInspectorView({ ...ROW, cost: 0.012346, attemptCostMicros: 0 });
    expect(v.attemptsRowParts).toBeNull();
    expect(v.totalCost).toBe(v.servedCost);
    expect(v.totalMicros).toBe(12_346);
  });

  it('a token row estimated on both axes keeps each marker on its own figure, in two groups', () => {
    const v = toInspectorView({
      ...ROW,
      outputTokens: 310,
      outputPriceSnapshot: 15,
      usageEstimated: true,
      priceSource: 'native_family',
      priceEstimated: true,
    });
    const output = v.tokenRows[1]!;
    expect(output.text).toBe('310 · est. usage × $15 / 1M · est.');
    expect(output.countParts).toEqual([
      { text: '310', tone: 'slot' },
      { text: '· est. usage', tone: 'ink3' },
    ]);
    expect(output.priceParts).toEqual([
      { text: '$15 / 1M', tone: 'slot' },
      { text: '· est.', tone: 'ink3' },
    ]);
    // Every count on a usage-estimated row is an estimate, and no price carries the usage
    // marker.
    for (const t of v.tokenRows) {
      expect(partsTextOf(t.countParts)).toMatch(/· est\. usage$/);
      expect(partsTextOf(t.priceParts)).not.toContain('usage');
    }
  });
});

/** dashboard-analytics "The receipt total reads the request's cost state". */
describe("the receipt total reads the request's cost state (add-route-trace-inspector 3.5)", () => {
  it('a not-billed total never reads as an estimate, and the receipt keeps its estimate rows', () => {
    // FIELD_REPORT: billed = false, zero attempt cost, estimated usage, priced native_family.
    const v = toInspectorView(FIELD_REPORT);
    expect(v.servedCost).toBe('$0 · not billed');
    expect(v.totalCost).toBe('$0 · not billed');
    expect(v.totalCost).not.toContain('est.');
    expect(v.tokenRows.map((t) => t.text)).toEqual([
      '54,040 · est. usage × $2 / 1M · est.',
      '0 · est. usage × $8 / 1M · est.',
    ]);
    expect(v.receiptNote).toBe(NOT_BILLED_NOTE);
    expect(v.attemptsRowParts).toBeNull();
  });

  it('usage and price estimates stay apart: estimated usage never marks the money', () => {
    const r: RequestRow = {
      ...ROW,
      usageEstimated: true,
      priceSource: 'bundled',
      priceEstimated: false,
    };
    const v = toInspectorView(r);
    expect(v.tokenRows.every((t) => partsTextOf(t.countParts)?.endsWith('· est. usage'))).toBe(
      true,
    );
    expect(v.receiptNote).toBe(USAGE_ESTIMATED_NOTE);
    expect(USAGE_ESTIMATED_NOTE).toBe('Provider omitted usage — token counts are estimated.');
    expect(v.tokenRows.some((t) => partsTextOf(t.priceParts)?.includes('est.'))).toBe(false);
    expect(v.receiptSource).toBe('bundled');
    expect(v.totalCost).toBe('$0.0020');
    expect(v.totalCost).toBe(rowCostLabel(r));
  });

  it('the total matches the table cell: `$0 free`, `$0 free · est.` and `<$0.0001`, never `$0.0000`', () => {
    const free: RequestRow = {
      ...ROW,
      cost: 0,
      billed: true,
      inputPriceSnapshot: 0,
      outputPriceSnapshot: 0,
      attemptCostMicros: 0,
    };
    const listedFree: RequestRow = { ...free, priceSource: 'listed', priceEstimated: true };
    const tiny: RequestRow = { ...ROW, cost: 0.00004, attemptCostMicros: 0 };
    expect([free, listedFree, tiny].map((r) => toInspectorView(r).totalCost)).toEqual([
      '$0 free',
      '$0 free · est.',
      '<$0.0001',
    ]);
    for (const r of [free, listedFree, tiny]) {
      expect(toInspectorView(r).totalCost).toBe(rowCostLabel(r));
      expect(toInspectorView(r).totalParts).toEqual(rowCostParts(r));
    }
  });

  it('over a fixture matrix, the receipt fields follow their rules and the total is the table cell', () => {
    let checked = 0;
    for (const billed of [true, false, null])
      for (const cost of [null, 0, 0.00004, 0.012346])
        for (const attemptCostMicros of [0, 3_100])
          for (const priceMode of [null, 'sync', 'batch'] as const)
            for (const usageEstimated of [false, true])
              for (const [cacheReadTokens, cacheReadPriceSnapshot] of [
                [null, null],
                [null, 0.3],
                [7, null],
              ] as const) {
                // A not-billed row records `cost = 0` (database CHECK), never a null cost.
                if (billed === false && cost !== 0) continue;
                const r: RequestRow = {
                  ...ROW,
                  billed,
                  cost,
                  attemptCostMicros,
                  priceMode,
                  batchId: priceMode === 'batch' ? 'b1' : null,
                  usageEstimated,
                  cacheReadTokens,
                  cacheReadPriceSnapshot,
                };
                const v = toInspectorView(r);
                expect(v.totalCost).toBe(rowCostLabel(r));
                expect(v.receiptCaption === null).toBe(cost === null);
                expect(v.attemptsRowParts === null).toBe(attemptCostMicros === 0);
                expect(v.tokenRows.some((t) => t.label === 'cache read')).toBe(
                  cacheReadTokens !== null || cacheReadPriceSnapshot !== null,
                );
                expect(v.receiptNote).toBe(
                  billed === false ? NOT_BILLED_NOTE : usageEstimated ? USAGE_ESTIMATED_NOTE : null,
                );
                checked += 1;
              }
    expect(checked).toBeGreaterThan(100);
  });
});
