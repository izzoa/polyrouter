import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_UNATTRIBUTED,
  ASKED,
  ATTEMPTS_NOT_RECORDED,
  breakdownToSpend,
  CAUSE_CHEAP_DEADLINE,
  CAUSE_CHEAP_DID_NOT_SERVE,
  CAUSE_CHEAP_EXHAUSTED,
  CAUSE_CHEAP_STOPPED,
  CAUSE_NOT_DELIVERED,
  CAUSE_QUALITY_GATE,
  CHEAP_LEG,
  clampText,
  DEADLINE_LABEL,
  DEADLINE_LABEL_CHEAP,
  DEFERRED,
  ENDED_AT,
  ESCALATION_LEG,
  escalationCause,
  QUALITY_GATE_PASSED,
  escalationRate,
  fallbackRate,
  filterToRequestParams,
  IN_FLIGHT,
  LACKS_TOOLS,
  LACKS_TOOLS_AND_VISION,
  LACKS_VISION,
  NOT_BILLED_NOTE,
  OUTPUT_CAP,
  OUTPUT_CAPPED_AT,
  outputCapText,
  rowCostLabel,
  rowCostParts,
  isTerminalSkip,
  routeTraceCaption,
  PAUSE_LABEL,
  SKIP_LABEL,
  terminalSkipReason,
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
  type RouteTraceDeferralNode,
  type RouteTraceLegNode,
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
  type RouteDeferral,
  type RouteLeg,
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
  routeLegs: null,
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

  it('carries the recorded provider only when the trace outcome names none (add-docked-inspector flag F3)', () => {
    const outcomeProvider = (r: RequestRow): string | null => {
      const o = toInspectorView(r).trace.find((n) => n.kind === 'outcome');
      return o?.kind === 'outcome' ? o.provider : 'no outcome';
    };
    const base: RequestRow = { ...ROW, providerId: 'p1', providerLabel: 'Provider A' };
    // Lit: the outcome names the provider, so the Decision row stays hidden.
    expect(outcomeProvider({ ...base, status: 'success' })).toBe('Provider A');
    expect(toInspectorView({ ...base, status: 'success' }).recordedProvider).toBeNull();
    // Unlit and unconfirmed: the terminal attempt is on another provider.
    const unconfirmed: RequestRow = {
      ...base,
      status: 'error',
      attemptFailures: [
        { index: 0, providerId: 'p1', model: 'a', kind: 'rate_limit', dispatched: true },
        {
          index: 1,
          providerId: 'p2',
          model: 'b',
          kind: 'unavailable',
          dispatched: true,
          terminal: true,
        },
      ],
    };
    expect(outcomeProvider(unconfirmed)).toBeNull();
    expect(toInspectorView(unconfirmed).recordedProvider).toBe('Provider A');
    // The label falls back to the id, as the table's Provider column does.
    expect(toInspectorView({ ...unconfirmed, providerLabel: null }).recordedProvider).toBe('p1');
    // Unlit and confirmed (the terminal attempt is on the recorded provider): named by the trace.
    const confirmed: RequestRow = {
      ...unconfirmed,
      attemptFailures: [
        {
          index: 0,
          providerId: 'p1',
          model: 'a',
          kind: 'rate_limit',
          dispatched: true,
          terminal: true,
        },
      ],
    };
    expect(outcomeProvider(confirmed)).toBe('Provider A');
    expect(toInspectorView(confirmed).recordedProvider).toBeNull();
    // Nothing recorded, nothing to state.
    expect(
      toInspectorView({ ...unconfirmed, providerId: null, providerLabel: null }).recordedProvider,
    ).toBeNull();
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
        stop: null,
        markers: null,
        clamp: null,
        text: 'gpt-x · unavailable · HTTP 529',
      },
      {
        // No leg tag: the leg row above the node states the leg (add-route-trace-cascade-legs).
        kind: 'attempt',
        emphasis: 'failed',
        model: 'strong-y',
        label: 'rate_limit',
        stop: null,
        markers: null,
        clamp: null,
        text: 'strong-y · rate_limit',
      },
      {
        kind: 'attempt',
        emphasis: 'skipped',
        model: 'grok-z',
        label: 'skipped — circuit open (provider not contacted)',
        stop: null,
        markers: null,
        clamp: null,
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

  it('a plan-paused entry reads the pause label from its recorded skipReason, a circuit entry the circuit label', () => {
    const pausedEntry: AttemptFailureEntry = {
      index: 0,
      providerId: 'p1',
      model: 'kimi-k2',
      kind: 'quota_exhausted',
      dispatched: false,
      terminal: true,
      skipReason: 'plan_cooldown',
    };
    const [paused] = attemptsOf(
      toRouteTrace({ ...ROW, status: 'error', attemptFailures: [pausedEntry] }),
    );
    expect(paused).toMatchObject({
      emphasis: 'skipped',
      label: 'skipped — plan paused (provider not contacted)',
      text: 'kimi-k2 · skipped — plan paused (provider not contacted)',
    });
    expect(PAUSE_LABEL).toBe('skipped — plan paused (provider not contacted)');
    // The label is chosen from the recorded reason, never from the kind: the same kind with no
    // skip reason is the circuit-open label.
    const { skipReason: _omit, ...circuitEntry } = pausedEntry;
    expect(
      attemptsOf(toRouteTrace({ ...ROW, status: 'error', attemptFailures: [circuitEntry] }))[0]
        ?.label,
    ).toBe(SKIP_LABEL);
    // A DISPATCHED failure is never relabelled, whatever its kind.
    const dispatched: AttemptFailureEntry = { ...pausedEntry, dispatched: true, status: 429 };
    expect(
      attemptsOf(toRouteTrace({ ...ROW, status: 'error', attemptFailures: [dispatched] }))[0]
        ?.label,
    ).toBe('quota_exhausted · HTTP 429');
  });

  it('terminalSkipReason is the terminal skip’s recorded reason, null otherwise', () => {
    const base = { index: 0, providerId: 'p1', model: 'a', kind: 'quota_exhausted' } as const;
    const rowOf = (e: AttemptFailureEntry) => ({ ...ROW, attemptFailures: [e] });
    const withReason: AttemptFailureEntry = {
      ...base,
      dispatched: false,
      terminal: true,
      skipReason: 'plan_cooldown',
    };
    const v = toInspectorView({ ...rowOf(withReason), status: 'error' });
    expect(v.terminalSkipped).toBe(true);
    expect(v.terminalSkipReason).toBe('plan_cooldown');
    expect(terminalSkipReason(rowOf(withReason))).toBe('plan_cooldown');
    // A circuit skip, an unmarked skip, a dispatched terminal and a null column: no reason.
    expect(terminalSkipReason(rowOf({ ...base, dispatched: false, terminal: true }))).toBeNull();
    expect(
      terminalSkipReason(rowOf({ ...base, dispatched: false, skipReason: 'plan_cooldown' })),
    ).toBeNull();
    expect(
      terminalSkipReason(
        rowOf({ ...base, dispatched: true, terminal: true, skipReason: 'plan_cooldown' }),
      ),
    ).toBeNull();
    expect(terminalSkipReason(ROW)).toBeNull();
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
    // Each leg is stated once, by its leg row, and no attempt node carries a leg tag
    // (add-route-trace-cascade-legs design D5).
    expect(traceTexts(r)).toEqual([
      'openclaw',
      'router · cascade',
      'cheap leg',
      'cheap-1 · unavailable',
      'cheap-2 · timeout',
      'escalation · cheap leg did not serve',
      'strong-1 · rate_limit · HTTP 429',
      'OpenAI · GPT · served · 1.20s',
    ]);
    for (const a of attempts) expect(a.text).not.toMatch(/cheap leg|escalation/);
    // A primary (non-cascade) chain records no leg, so it draws no leg row.
    const primary = toRouteTrace({ ...ROW, attemptFailures: [entry({ model: 'a' })] });
    expect(primary.map((n) => n.kind)).toEqual(['source', 'decision', 'attempt', 'outcome']);
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
        keptQuality: null,
        clamp: null,
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
      keptQuality: null,
      clamp: null,
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
    // Not a cascade request: source, decision and outcome only, with no leg row.
    expect(trace.map((n) => n.kind)).toEqual(['source', 'decision', 'outcome']);
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
      'cheap leg',
      'cheap attempt superseded · q=0.42 · $0.0031',
      'escalation · quality gate',
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
    // add-route-trace-cascade-legs: the superseded call sits under the `cheap leg` row, after
    // the cheap-leg nodes and before the `escalation` row.
    expect(toRouteTrace(r).map((n) => n.kind)).toEqual([
      'source',
      'decision',
      'leg',
      'attempt',
      'attempt',
      'superseded',
      'leg',
      'attempt',
      'outcome',
    ]);
    expect(traceTexts(r).slice(2, 8)).toEqual([
      'cheap leg',
      'cheap-1 · unavailable',
      'cheap-2 · unavailable',
      'cheap attempt superseded · q=0.42 · $0.0031',
      'escalation · quality gate',
      'strong-1 · rate_limit · HTTP 429',
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
    // The failure sits under the `cheap leg` row, and the escalation row states the cause.
    expect(trace.map((n) => n.text).slice(2)).toEqual([
      'cheap leg',
      'cheap-1 · unavailable',
      'escalation · cheap leg did not serve',
      'Anthropic · Strong · served · 1.20s',
    ]);
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
                // add-route-trace-cascade-legs design D2 and D6, on every matrix row (each is a
                // cascade request): the `cheap leg` row follows the decision chip; the escalation
                // row is drawn exactly when the row escalated or recorded an escalation-leg entry;
                // and the cheap row says `attempts not recorded` exactly when that escalation row
                // is drawn with no cheap-leg entry and no superseded node under it.
                const legNodes = v.trace.filter((n): n is RouteTraceLegNode => n.kind === 'leg');
                expect(v.trace[2]).toBe(legNodes[0]);
                expect(legNodes[0]?.leg).toBe('cheap leg');
                const escalationRow =
                  escalated || (attemptFailures ?? []).some((a) => a.leg === 'escalation');
                expect(legNodes.some((n) => n.leg === 'escalation')).toBe(escalationRow);
                const cheapRecorded =
                  (attemptFailures ?? []).some((a) => a.leg === 'cheap') || node !== undefined;
                expect(legNodes[0]?.detail ?? null).toBe(
                  escalationRow && !cheapRecorded ? ATTEMPTS_NOT_RECORDED : null,
                );
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
                // Never after an escalation-leg entry, never before a cheap-leg one. Attempt
                // nodes carry no leg tag (add-route-trace-cascade-legs design D5), so each
                // node's leg is its stored entry's: they are drawn in stored order.
                const at = v.trace.indexOf(node);
                const legs = attemptsOf(v.trace).map(
                  (a, k) => [v.trace.indexOf(a), attemptFailures![k]!.leg] as const,
                );
                for (const [i, leg] of legs) expect(leg === 'cheap' ? i < at : i > at).toBe(true);
                // And under the `cheap leg` row, before the `escalation` row.
                const legRows = v.trace.flatMap((n, i) =>
                  n.kind === 'leg' ? [[i, n.leg] as const] : [],
                );
                expect(legRows[0]).toEqual([2, 'cheap leg']);
                expect(at).toBeGreaterThan(2);
                const escalationAt = legRows.find(([, leg]) => leg === 'escalation')?.[0];
                expect(escalationAt).toBeGreaterThan(at);
              }
    expect(checked).toBe((3 + 1) * 3 * 3 * 5 * 4);
    expect(drawn).toBeGreaterThan(0);
  });
});

/* ---- add-route-trace-cascade-legs (tasks 2.1–2.5) ----------------------------------- */

/** A cascade request its cheap leg served cleanly, with no recorded quality score. */
const CASCADE: RequestRow = {
  ...ROW,
  decisionLayer: 'cascade',
  status: 'success',
  escalated: false,
  escalationSource: null,
  qualitySignal: null,
  attemptCostMicros: 0,
  modelId: 'cheap-model',
  modelLabel: 'Cheap',
  providerLabel: 'Groq',
};
/** The maintainer's row (2026-11-12): the cheap leg did not serve, the heavy tier served
 * cleanly, so the row is `success`, the recorder kept no trail, and the proxy wrote a
 * placeholder 0 as the score. */
const UNRECORDED_ESCALATION: RequestRow = {
  ...CASCADE,
  escalated: true,
  escalationSource: 'cheap_error',
  qualitySignal: 0,
  attemptFailures: null,
  modelId: 'mimo-v2.6-pro',
  modelLabel: 'mimo-v2.6-pro',
  providerLabel: 'XiaomiMiMo',
  agentLabel: 'Lobechat',
  tierAssigned: 'heavy',
  durationMs: 38_890,
  routingReason:
    'cascade: escalated cheap→heavy; esc[capability_deferred ~z-ai/glm-latest(vision)] (q=0.00)',
};

/** dashboard-analytics "The route trace groups a cascade request under leg rows" and "The
 * cheap leg row says when its attempts were not recorded" (task 2.1). */
describe('a cascade request is grouped under leg rows (add-route-trace-cascade-legs 2.1)', () => {
  it('exports the leg-row contract strings DESIGN.md quotes', () => {
    expect([
      CHEAP_LEG,
      ESCALATION_LEG,
      ATTEMPTS_NOT_RECORDED,
      CAUSE_QUALITY_GATE,
      CAUSE_CHEAP_DID_NOT_SERVE,
      QUALITY_GATE_PASSED,
    ]).toEqual([
      'cheap leg',
      'escalation',
      'attempts not recorded',
      'quality gate',
      'cheap leg did not serve',
      'quality gate passed',
    ]);
  });

  /** Each situation's full node-kind and text sequence, as drawn. */
  const cases: [string, RequestRow, string[]][] = [
    [
      'served by its cheap leg',
      CASCADE,
      ['openclaw', 'router · cascade', 'cheap leg', 'Groq · Cheap · served · 1.20s'],
    ],
    [
      'cheap-served after cheap-leg failures',
      {
        ...CASCADE,
        status: 'fallback',
        attemptFailures: [
          entry({ index: 0, model: 'cheap-1', kind: 'unavailable', status: 503, leg: 'cheap' }),
        ],
      },
      [
        'openclaw',
        'router · cascade',
        'cheap leg',
        'cheap-1 · unavailable · HTTP 503',
        'Groq · Cheap · served · 1.20s',
      ],
    ],
    [
      'escalated by the quality gate, cheap call priced',
      {
        ...CASCADE,
        escalated: true,
        escalationSource: 'quality_gate',
        qualitySignal: 0.42,
        attemptCostMicros: 3_100,
        priceSource: 'bundled',
        modelLabel: 'Strong',
        providerLabel: 'Anthropic',
      },
      [
        'openclaw',
        'router · cascade',
        'cheap leg',
        'cheap attempt superseded · q=0.42 · $0.0031',
        'escalation · quality gate',
        'Anthropic · Strong · served · 1.20s',
      ],
    ],
    [
      'escalated by the quality gate, cheap call free',
      {
        ...CASCADE,
        escalated: true,
        escalationSource: 'quality_gate',
        qualitySignal: 0.42,
        modelLabel: 'Strong',
        providerLabel: 'Anthropic',
      },
      [
        'openclaw',
        'router · cascade',
        'cheap leg',
        'cheap attempt superseded · q=0.42',
        'escalation · quality gate',
        'Anthropic · Strong · served · 1.20s',
      ],
    ],
    [
      "the maintainer's row: cheap leg did not serve, nothing recorded",
      UNRECORDED_ESCALATION,
      [
        'Lobechat',
        'router · cascade',
        'cheap leg · attempts not recorded',
        'escalation · cheap leg did not serve',
        'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
      ],
    ],
    [
      'cheap_error fallback with cheap and escalation entries',
      {
        ...UNRECORDED_ESCALATION,
        status: 'fallback',
        attemptFailures: [
          entry({ index: 0, model: 'cheap-1', kind: 'timeout', leg: 'cheap' }),
          entry({ index: 0, model: 'strong-1', status: 429, leg: 'escalation' }),
        ],
      },
      [
        'Lobechat',
        'router · cascade',
        'cheap leg',
        'cheap-1 · timeout',
        'escalation · cheap leg did not serve',
        'strong-1 · rate_limit · HTTP 429',
        'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
      ],
    ],
    [
      'cheap_error fallback with escalation entries only',
      {
        ...UNRECORDED_ESCALATION,
        status: 'fallback',
        attemptFailures: [entry({ index: 0, model: 'strong-1', status: 429, leg: 'escalation' })],
      },
      [
        'Lobechat',
        'router · cascade',
        'cheap leg · attempts not recorded',
        'escalation · cheap leg did not serve',
        'strong-1 · rate_limit · HTTP 429',
        'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
      ],
    ],
    [
      'cheap_error with an attempt cost (a passing verdict whose replay failed)',
      { ...UNRECORDED_ESCALATION, attemptCostMicros: 3_100, priceSource: 'bundled' },
      [
        'Lobechat',
        'router · cascade',
        'cheap leg',
        'cheap attempt superseded · $0.0031',
        'escalation · cheap leg did not serve',
        'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
      ],
    ],
    [
      'legacy escalation with an attempt cost',
      {
        ...UNRECORDED_ESCALATION,
        escalationSource: null,
        attemptCostMicros: 3_100,
        priceSource: 'bundled',
      },
      [
        'Lobechat',
        'router · cascade',
        'cheap leg',
        'cheap attempt superseded · $0.0031',
        'escalation',
        'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
      ],
    ],
    [
      'legacy escalation with nothing recorded',
      { ...UNRECORDED_ESCALATION, escalationSource: null },
      [
        'Lobechat',
        'router · cascade',
        'cheap leg · attempts not recorded',
        'escalation',
        'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
      ],
    ],
    [
      'escalated, every member failed',
      {
        ...UNRECORDED_ESCALATION,
        status: 'error',
        durationMs: 2_100,
        attemptFailures: [
          entry({
            index: 0,
            providerId: 'p1',
            model: 'cheap-1',
            kind: 'unavailable',
            leg: 'cheap',
          }),
          entry({
            index: 0,
            providerId: 'p1',
            model: 'strong-1',
            status: 503,
            kind: 'unavailable',
            leg: 'escalation',
            terminal: true,
          }),
        ],
      },
      [
        'Lobechat',
        'router · cascade',
        'cheap leg',
        'cheap-1 · unavailable',
        'escalation · cheap leg did not serve',
        'strong-1 · unavailable · HTTP 503',
        'XiaomiMiMo · failed · 2.10s',
      ],
    ],
    [
      'cancelled during the cheap leg',
      { ...CASCADE, status: 'cancelled', durationMs: 800 },
      ['openclaw', 'router · cascade', 'cheap leg', 'Groq · Cheap · cancelled by client · 800ms'],
    ],
    [
      'cancelled after escalation',
      { ...UNRECORDED_ESCALATION, status: 'cancelled', durationMs: 800 },
      [
        'Lobechat',
        'router · cascade',
        'cheap leg · attempts not recorded',
        'escalation · cheap leg did not serve',
        'XiaomiMiMo · mimo-v2.6-pro · cancelled by client · 800ms',
      ],
    ],
    [
      'a cheap failure that was not retried',
      {
        ...CASCADE,
        status: 'error',
        attemptFailures: [entry({ index: 0, providerId: 'p9', model: 'cheap-1', leg: 'cheap' })],
      },
      [
        'openclaw',
        'router · cascade',
        'cheap leg',
        'cheap-1 · rate_limit',
        'Groq · Cheap · failed · 1.20s',
      ],
    ],
    [
      'another layer whose entries record a leg (not produced today)',
      {
        ...ROW,
        decisionLayer: 'default',
        status: 'fallback',
        attemptFailures: [entry({ index: 0, model: 'cheap-1', leg: 'cheap' })],
      },
      [
        'openclaw',
        'router · default',
        'cheap leg',
        'cheap-1 · rate_limit',
        'OpenAI · GPT · served · 1.20s',
      ],
    ],
    [
      // Design D2, both data halves: a recorded escalation-leg entry makes this a cascade
      // request AND draws its escalation row, even though the row is not flagged escalated.
      'an escalation-leg entry on another layer, not flagged escalated (not produced today)',
      {
        ...ROW,
        decisionLayer: 'default',
        status: 'fallback',
        escalated: false,
        attemptFailures: [entry({ index: 0, model: 'strong-1', status: 429, leg: 'escalation' })],
      },
      [
        'openclaw',
        'router · default',
        'cheap leg · attempts not recorded',
        'escalation',
        'strong-1 · rate_limit · HTTP 429',
        'OpenAI · GPT · served · 1.20s',
      ],
    ],
  ];

  it.each(cases)('%s', (_name, r, texts) => {
    const trace = toRouteTrace(r);
    expect(trace.map((n) => n.text)).toEqual(texts);
    expect(toInspectorView(r).trace).toEqual(trace);
    // Leg rows are neutral router decisions, never lit, never a failure, never skipped.
    for (const n of trace)
      if (n.kind === 'leg') {
        expect(n.emphasis).toBe('neutral');
        expect(n.text).toBe(n.detail === null ? n.leg : `${n.leg} · ${n.detail}`);
      }
    // Exactly one cheap leg row, which follows the decision chip; at most one escalation row.
    const legs = trace.filter((n): n is RouteTraceLegNode => n.kind === 'leg');
    expect(legs[0]).toMatchObject({ leg: 'cheap leg' });
    expect(trace[2]).toBe(legs[0]);
    expect(legs.filter((n) => n.leg === 'cheap leg')).toHaveLength(1);
    expect(legs.filter((n) => n.leg === 'escalation').length).toBeLessThanOrEqual(1);
    // No attempt node carries a leg tag.
    for (const a of attemptsOf(trace)) expect(a.text).not.toMatch(/cheap leg|escalation/);
  });

  it('a request that is not a cascade request draws exactly what it drew before: no leg row', () => {
    const recorded = [entry({ model: 'a', status: 429 })];
    for (const decisionLayer of [
      'explicit',
      'default',
      'header',
      'workload',
      'structural',
      'semantic',
    ])
      for (const attemptFailures of [null, recorded])
        // A settled batch item, and a row flagged escalated without a cascade layer or a
        // recorded leg (not produced today): neither is a cascade request (design D2).
        for (const extra of [
          {},
          { batchId: 'batch_01', priceMode: 'batch' as const },
          { escalated: true },
        ]) {
          const r: RequestRow = {
            ...ROW,
            ...extra,
            decisionLayer,
            status: attemptFailures === null ? 'success' : 'fallback',
            attemptFailures,
          };
          const trace = toRouteTrace(r);
          expect(trace.map((n) => n.kind)).toEqual(
            attemptFailures === null
              ? ['source', 'decision', 'outcome']
              : ['source', 'decision', 'attempt', 'outcome'],
          );
          expect(trace.map((n) => n.text).join(' ')).not.toMatch(/cheap leg|escalation/);
        }
  });

  it('`attempts not recorded` appears only when the row kept nothing for an escalated cheap leg', () => {
    const detailOf = (r: RequestRow): string | null => {
      const cheap = toRouteTrace(r).find(
        (n): n is RouteTraceLegNode => n.kind === 'leg' && n.leg === 'cheap leg',
      );
      return cheap?.detail ?? null;
    };
    expect(detailOf(UNRECORDED_ESCALATION)).toBe(ATTEMPTS_NOT_RECORDED);
    // A recorded cheap-leg attempt, or a superseded node, means something was recorded.
    expect(
      detailOf({
        ...UNRECORDED_ESCALATION,
        status: 'fallback',
        attemptFailures: [entry({ model: 'cheap-1', leg: 'cheap' })],
      }),
    ).toBeNull();
    expect(detailOf({ ...UNRECORDED_ESCALATION, escalationSource: 'quality_gate' })).toBeNull();
    // A cascade request that did not escalate reads `cheap leg` alone, whatever it recorded.
    expect(detailOf(CASCADE)).toBeNull();
    expect(detailOf({ ...CASCADE, status: 'cancelled' })).toBeNull();
    // No node for a cheap call the row has no record of: nothing names a cheap model.
    const texts = traceTexts(UNRECORDED_ESCALATION).join(' ');
    expect(texts).not.toMatch(/Groq|Cheap|cheap-model|glm/);
  });
});

/** dashboard-analytics "An escalated cascade request states its escalation and the recorded
 * cause" (task 2.2). */
describe('the escalation row states the recorded cause (add-route-trace-cascade-legs 2.2)', () => {
  const causeRow = (r: RequestRow): string | undefined =>
    toRouteTrace(r).find((n) => n.kind === 'leg' && n.leg === 'escalation')?.text;

  it('maps each recorded source to its words, never blank', () => {
    expect(escalationCause('quality_gate')).toBe('quality gate');
    expect(escalationCause('cheap_error')).toBe('cheap leg did not serve');
    expect(escalationCause(null)).toBeNull();
    expect(escalationCause('manual_override')).toBe('manual_override');
    expect(escalationCause('  ')).toBeNull();
    expect(causeRow({ ...UNRECORDED_ESCALATION, escalationSource: 'quality_gate' })).toBe(
      'escalation · quality gate',
    );
    expect(causeRow(UNRECORDED_ESCALATION)).toBe('escalation · cheap leg did not serve');
    expect(causeRow({ ...UNRECORDED_ESCALATION, escalationSource: null })).toBe('escalation');
    // A value the dashboard has no case for (the column's CHECK admits none today) renders
    // verbatim in the same neutral row.
    const odd: RequestRow = {
      ...UNRECORDED_ESCALATION,
      escalationSource: 'manual_override' as unknown as RequestRow['escalationSource'],
    };
    expect(causeRow(odd)).toBe('escalation · manual_override');
  });

  it('reads the cause from the recorded field, never from the routing reason', () => {
    const legacy: RequestRow = {
      ...UNRECORDED_ESCALATION,
      escalationSource: null,
      routingReason: 'cascade: escalated cheap→heavy; (q=0.00); structural:ambiguous score=0.45',
    };
    expect(causeRow(legacy)).toBe('escalation');
    const texts = traceTexts(legacy).join(' ');
    expect(texts).not.toMatch(/heavy|q=|structural|0\.45|cheap→/);
  });

  it('no `cheap_error` trace carries a `q=` figure, whatever signal the row recorded', () => {
    for (const qualitySignal of [null, 0, 0.42, 0.91])
      for (const attemptCostMicros of [0, 3_100])
        for (const status of ['success', 'fallback', 'error', 'cancelled'] as const) {
          const r: RequestRow = {
            ...UNRECORDED_ESCALATION,
            qualitySignal,
            attemptCostMicros,
            status,
          };
          expect(traceTexts(r).join(' ')).not.toContain('q=');
        }
  });
});

/** dashboard-analytics "A kept cheap answer states that the quality gate passed" (task 2.4). */
describe('a kept cheap answer states its passing verdict, as the Auto-performance view counts `qualityPassed` (add-route-trace-cascade-legs 2.4)', () => {
  it('a cascade row that did not escalate, was served and recorded a signal reads the verdict', () => {
    for (const status of ['success', 'fallback'] as const) {
      const r: RequestRow = { ...CASCADE, status, qualitySignal: 0.87 };
      const outcome = outcomeOf(toRouteTrace(r));
      expect(outcome).toMatchObject({ emphasis: 'lit', keptQuality: 'q=0.87' });
      // After the latency in the node's text.
      expect(outcome.text).toBe('Groq · Cheap · served · 1.20s · quality gate passed · q=0.87');
    }
    // Two decimals, as the superseded node's `q=`.
    expect(outcomeOf(toRouteTrace({ ...CASCADE, qualitySignal: 1 })).keptQuality).toBe('q=1.00');
  });

  it('a kept answer with no recorded score states no verdict and no zero', () => {
    const outcome = outcomeOf(toRouteTrace(CASCADE));
    expect(outcome.keptQuality).toBeNull();
    expect(outcome.text).toBe('Groq · Cheap · served · 1.20s');
    expect(outcome.text).not.toMatch(/q=|passed|0\.00/);
  });

  it('only a kept cheap answer carries the verdict', () => {
    const none: RequestRow[] = [
      // escalated, with a gate score or a placeholder
      { ...CASCADE, escalated: true, escalationSource: 'quality_gate', qualitySignal: 0.42 },
      UNRECORDED_ESCALATION,
      // a cascade row that failed or was cancelled in its cheap leg, with a passing score
      { ...CASCADE, status: 'error', qualitySignal: 0.87 },
      { ...CASCADE, status: 'cancelled', qualitySignal: 0.87 },
      // any other layer (ROW records 0.8 on a structural row)
      ROW,
      { ...ROW, decisionLayer: 'semantic', qualitySignal: 0.9 },
    ];
    for (const r of none) {
      const trace = toRouteTrace(r);
      expect(outcomeOf(trace).keptQuality).toBeNull();
      expect(trace.map((n) => n.text).join(' ')).not.toContain('quality gate passed');
    }
  });
});

/** dashboard-analytics "The Decision section prints a quality signal only when the gate
 * measured one" (task 2.5). */
describe('the Decision section hides the quality signal of a cheap-leg escalation (add-route-trace-cascade-legs 2.5)', () => {
  it('a `cheap_error` escalation shows no signal, whatever it recorded', () => {
    expect(toInspectorView(UNRECORDED_ESCALATION).qualitySignal).toBeNull();
    expect(
      toInspectorView({ ...UNRECORDED_ESCALATION, qualitySignal: 0.91 }).qualitySignal,
    ).toBeNull();
    // The escalated row and the verbatim reason, `(q=0.00)` included, still render.
    const v = toInspectorView(UNRECORDED_ESCALATION);
    expect(v.escalated).toBe(true);
    expect(v.routingReason).toContain('(q=0.00)');
  });

  it('a measured signal still renders, and a legacy escalation renders what it recorded', () => {
    expect(
      toInspectorView({
        ...CASCADE,
        escalated: true,
        escalationSource: 'quality_gate',
        qualitySignal: 0.42,
      }).qualitySignal,
    ).toBe(0.42);
    expect(toInspectorView({ ...CASCADE, qualitySignal: 0.87 }).qualitySignal).toBe(0.87);
    expect(
      toInspectorView({ ...UNRECORDED_ESCALATION, escalationSource: null, qualitySignal: 0 })
        .qualitySignal,
    ).toBe(0);
    expect(toInspectorView(CASCADE).qualitySignal).toBeNull();
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

  it('over every status, no node mentions a first token or a commit, and only the outcome and a recorded cheap end carry a time', () => {
    const statuses: RequestStatus[] = ['success', 'fallback', 'error', 'cancelled', 'throttled'];
    const escalatedCascade: Partial<RequestRow> = {
      decisionLayer: 'cascade',
      escalated: true,
      escalationSource: 'cheap_error',
      durationMs: 41_250,
    };
    /** Each shape, and the one time its escalation row may state (record-route-legs design D7):
     * the route record's cheap-leg end, `at <fmtLatency(endedMs)>`. Every other recorded
     * `endedMs` (a primary or escalation leg's, a streamed leg's commit instant included) and a
     * row without a record state none. */
    const shapes: [Partial<RequestRow>, string | null][] = [
      [{}, null],
      [
        {
          attemptFailures: [
            entry({ model: 'a', status: 429 }),
            entry({ model: 'b', dispatched: false, terminal: true }),
          ],
        },
        null,
      ],
      [
        {
          decisionLayer: 'cascade',
          escalated: true,
          escalationSource: 'quality_gate',
          qualitySignal: 0.42,
          attemptCostMicros: 3_100,
          attemptFailures: [entry({ model: 'c', leg: 'cheap' })],
        },
        null,
      ],
      [{ batchId: 'batch_01', priceMode: 'batch', durationMs: 7_412_300 }, null],
      [{ durationMs: 412 }, null],
      [{ durationMs: 125_000 }, null],
      // A streamed primary leg's `endedMs` is its commit instant: never drawn.
      [{ routeLegs: [{ leg: 'primary', end: 'served', endedMs: 450, servedIndex: 0 }] }, null],
      [
        {
          ...escalatedCascade,
          routeLegs: [
            { leg: 'cheap', end: 'deadline', endedMs: 30_020 },
            { leg: 'escalation', end: 'served', endedMs: 33_480, servedIndex: 0 },
          ],
        },
        '30.02s',
      ],
      [
        {
          ...escalatedCascade,
          escalationSource: 'quality_gate',
          routeLegs: [
            { leg: 'cheap', end: 'gate_failed', endedMs: 2_450, servedIndex: 0 },
            { leg: 'escalation', end: 'stopped', endedMs: 2_900 },
          ],
        },
        '2.45s',
      ],
      // A cheap end that states no cause (a cancel) keeps the recorded source's words, untimed.
      [
        {
          ...escalatedCascade,
          routeLegs: [
            { leg: 'cheap', end: 'cancelled', endedMs: 800 },
            { leg: 'escalation', end: 'served', endedMs: 900, servedIndex: 0 },
          ],
        },
        null,
      ],
      // A kept cheap answer: no escalation row, so no time but the latency.
      [
        {
          decisionLayer: 'cascade',
          qualitySignal: 0.87,
          routeLegs: [{ leg: 'cheap', end: 'served', endedMs: 640, servedIndex: 0 }],
        },
        null,
      ],
    ];
    let checked = 0;
    for (const status of statuses)
      for (const [shape, at] of shapes) {
        const r: RequestRow = { ...ROW, ...shape, status };
        const trace = toRouteTrace(r);
        for (const n of trace) expect(n.text).not.toMatch(/first token|commit/i);
        const outcome = outcomeOf(trace);
        expect(outcome.text.match(TIME)).toEqual([outcome.latency]);
        for (const n of trace.slice(0, -1)) {
          const timed = at !== null && n.kind === 'leg' && n.leg === 'escalation';
          expect(n.text.match(TIME), `${status}: ${n.text}`).toEqual(timed ? [at] : null);
          if (timed) expect(n.text.endsWith(` · at ${at}`)).toBe(true);
        }
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

/* ---- keep-cheap-leg-attempt-trail (task 5.1) ---------------------------------------- */

describe('a cheap call cut off by the deadline reads as such (keep-cheap-leg-attempt-trail)', () => {
  /** The maintainer's row as it now records: the cheap call the deadline cut off is kept,
   * and the heavy tier served cleanly, so the row is still `success`. */
  const DEADLINE_ESCALATION: RequestRow = {
    ...UNRECORDED_ESCALATION,
    attemptFailures: [
      entry({
        index: 0,
        model: 'cheap-1',
        kind: 'unavailable',
        leg: 'cheap',
        stopReason: 'deadline',
      }),
    ],
  };
  const nodeOf = (e: AttemptFailureEntry): RouteTraceAttemptNode => {
    const [node] = attemptsOf(toRouteTrace({ ...ROW, status: 'error', attemptFailures: [e] }));
    if (node === undefined) throw new Error('expected one attempt node');
    return node;
  };

  it('exports the contract strings DESIGN.md quotes', () => {
    expect([DEADLINE_LABEL_CHEAP, DEADLINE_LABEL]).toEqual([
      'no reply by the cheap deadline',
      'no reply by the deadline',
    ]);
  });

  it('a cheap-leg cut reads the cheap deadline in words, as a failure', () => {
    expect(
      nodeOf(
        entry({ model: 'cheap-1', kind: 'unavailable', leg: 'cheap', stopReason: 'deadline' }),
      ),
    ).toEqual({
      kind: 'attempt',
      emphasis: 'failed',
      model: 'cheap-1',
      label: 'no reply by the cheap deadline',
      stop: 'deadline',
      markers: null,
      clamp: null,
      text: 'cheap-1 · no reply by the cheap deadline',
    });
  });

  it.each([
    ['the escalation leg', { leg: 'escalation' as const }],
    ['no leg', {}],
  ])('a cut on %s reads the plain deadline words, never blank', (_where, leg) => {
    const node = nodeOf(entry({ model: 'm', kind: 'unavailable', stopReason: 'deadline', ...leg }));
    expect(node.label).toBe(DEADLINE_LABEL);
    expect(node.stop).toBe('deadline');
    expect(node.text).toBe('m · no reply by the deadline');
  });

  it('a plain unavailable failure without the stop reason reads as before', () => {
    const node = nodeOf(entry({ model: 'm', kind: 'unavailable', leg: 'cheap' }));
    expect(node.label).toBe('unavailable');
    expect(node.stop).toBeNull();
  });

  it('a never-dispatched member reads its skip label whatever else it carries', () => {
    const circuit = nodeOf(
      entry({ model: 'm', kind: 'unavailable', dispatched: false, stopReason: 'deadline' }),
    );
    expect([circuit.label, circuit.emphasis, circuit.stop]).toEqual([SKIP_LABEL, 'skipped', null]);
    const paused = nodeOf(
      entry({
        model: 'm',
        kind: 'quota_exhausted',
        dispatched: false,
        skipReason: 'plan_cooldown',
        stopReason: 'deadline',
      }),
    );
    expect([paused.label, paused.stop]).toEqual([PAUSE_LABEL, null]);
  });

  it('the escalated success row draws the cut call under the cheap leg, never “unavailable”', () => {
    const texts = traceTexts(DEADLINE_ESCALATION);
    expect(texts).toEqual([
      'Lobechat',
      'router · cascade',
      'cheap leg',
      'cheap-1 · no reply by the cheap deadline',
      'escalation · cheap leg did not serve',
      'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
    ]);
    expect(texts.join(' ')).not.toContain(ATTEMPTS_NOT_RECORDED);
    expect(texts.join(' ')).not.toContain('unavailable');
    expect(toErrorView(DEADLINE_ESCALATION)).toBeNull(); // a served row has no ERROR card
  });

  it('an escalated success keeps a cheap refusal under the cheap leg, with no ERROR card', () => {
    const row: RequestRow = {
      ...UNRECORDED_ESCALATION,
      attemptFailures: [
        entry({
          index: 0,
          model: 'cheap-1',
          kind: 'bad_request',
          status: 400,
          markers: ['context_length_exceeded'],
          leg: 'cheap',
        }),
      ],
    };
    expect(traceTexts(row)).toEqual([
      'Lobechat',
      'router · cascade',
      'cheap leg',
      'cheap-1 · bad_request · HTTP 400 · context_length_exceeded',
      'escalation · cheap leg did not serve',
      'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
    ]);
    expect(toErrorView(row)).toBeNull();
  });
});

/* ---- record-route-legs (task 7.2): the route trace draws the route record ------------- */

/** One recorded leg: `endedMs` 1,200 unless overridden. */
const leg = (over: Partial<RouteLeg> & Pick<RouteLeg, 'leg' | 'end'>): RouteLeg => ({
  endedMs: 1_200,
  ...over,
});
/** A capability deferral of the member at `index`. */
const lacking = (
  index: number,
  model: string,
  capabilities: ('tools' | 'vision')[],
): RouteDeferral => ({ index, model, reason: 'capability', capabilities });
/** An output-cap deferral of the member at `index`. */
const capped = (index: number, model: string, cap: number): RouteDeferral => ({
  index,
  model,
  reason: 'output_cap',
  cap,
});
/** The trace's deferral rows, in drawn order. */
const deferralsOf = (nodes: readonly RouteTraceNode[]): RouteTraceDeferralNode[] =>
  nodes.filter((n): n is RouteTraceDeferralNode => n.kind === 'deferral');

describe('the route record: contract strings (record-route-legs design D7)', () => {
  it('exports every contract string DESIGN.md quotes', () => {
    expect([
      DEFERRED,
      LACKS_TOOLS,
      LACKS_VISION,
      LACKS_TOOLS_AND_VISION,
      OUTPUT_CAP,
      ASKED,
      OUTPUT_CAPPED_AT,
      IN_FLIGHT,
      CAUSE_CHEAP_EXHAUSTED,
      CAUSE_CHEAP_DEADLINE,
      CAUSE_NOT_DELIVERED,
      CAUSE_CHEAP_STOPPED,
      ENDED_AT,
    ]).toEqual([
      'deferred',
      'lacks tools',
      'lacks vision',
      'lacks tools and vision',
      'output cap',
      'asked',
      'output capped at',
      'in flight',
      'cheap leg exhausted',
      'cheap deadline',
      'cheap answer not delivered',
      'cheap leg stopped',
      'at',
    ]);
    expect(outputCapText('4,096', '100,000')).toBe('output cap 4,096 < 100,000 asked');
    expect(outputCapText('4,096', null)).toBe('output cap 4,096');
    expect(clampText('4,096')).toBe('output capped at 4,096');
    expect(clampText('4,096', '100,000')).toBe('output capped at 4,096 of 100,000 asked');
  });

  it("DESIGN.md's Route Trace section quotes each one exactly", () => {
    const design = readFileSync(join(import.meta.dirname, '../../../../DESIGN.md'), 'utf8');
    const section = /### Route Trace \(signature\)\n([\s\S]*?)\n### /.exec(design)?.[1] ?? '';
    expect(section, 'the Route Trace section').not.toBe('');
    for (const quoted of [
      'deferred · <model> · lacks vision',
      LACKS_TOOLS,
      LACKS_TOOLS_AND_VISION,
      'output cap <cap> < <ask> asked',
      'output capped at <to>',
      'output capped at <to> of <ask> asked',
      `<model> · ${IN_FLIGHT}`,
      `escalation · ${CAUSE_QUALITY_GATE} · ${ENDED_AT} <t>`,
      CAUSE_CHEAP_EXHAUSTED,
      CAUSE_CHEAP_DEADLINE,
      CAUSE_NOT_DELIVERED,
      CAUSE_CHEAP_STOPPED,
    ])
      expect(section, quoted).toContain(`\`${quoted}`);
  });
});

/** dashboard-analytics "A deferred member is named on a spine row". */
describe('a deferred member is named on a spine row (record-route-legs 7.2)', () => {
  it('a capability deferral is named on the spine, between the decision chip and the outcome', () => {
    const r: RequestRow = {
      ...ROW,
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'served',
          servedIndex: 1,
          deferred: [lacking(0, 'gpt-4o-mini', ['vision'])],
        }),
      ],
    };
    const trace = toRouteTrace(r);
    expect(trace.map((n) => n.text)).toEqual([
      'openclaw',
      'router · structural',
      'deferred · gpt-4o-mini · lacks vision',
      'OpenAI · GPT · served · 1.20s',
    ]);
    expect(deferralsOf(trace)).toEqual([
      {
        kind: 'deferral',
        emphasis: 'neutral',
        model: 'gpt-4o-mini',
        lacks: 'lacks vision',
        outputCap: null,
        text: 'deferred · gpt-4o-mini · lacks vision',
      },
    ]);
    expect(toInspectorView(r).trace).toEqual(trace);
  });

  it.each([
    ['tools', [lacking(0, 'm', ['tools'])], 'deferred · m · lacks tools'],
    ['vision', [lacking(0, 'm', ['vision'])], 'deferred · m · lacks vision'],
    [
      'tools and vision',
      [lacking(0, 'm', ['vision', 'tools'])],
      'deferred · m · lacks tools and vision',
    ],
    ['its output cap', [capped(0, 'm', 4_096)], 'deferred · m · output cap 4,096 < 100,000 asked'],
    // One row for the member, the capability reason first, whatever the record's order.
    [
      'both, output cap listed first',
      [capped(0, 'm', 4_096), lacking(0, 'm', ['vision'])],
      'deferred · m · lacks vision · output cap 4,096 < 100,000 asked',
    ],
  ] as const)('a member deferred for %s reads its reason', (_why, deferred, text) => {
    const r: RequestRow = {
      ...ROW,
      routeLegs: [leg({ leg: 'primary', end: 'served', servedIndex: 1, ask: 100_000, deferred })],
    };
    expect(deferralsOf(toRouteTrace(r)).map((n) => n.text)).toEqual([text]);
  });

  it('an output-cap deferral with no recorded ask states the cap alone, never blank', () => {
    const r: RequestRow = {
      ...ROW,
      routeLegs: [
        leg({ leg: 'primary', end: 'served', servedIndex: 1, deferred: [capped(0, 'm', 4_096)] }),
      ],
    };
    expect(deferralsOf(toRouteTrace(r))[0]?.text).toBe('deferred · m · output cap 4,096');
  });

  it('one row per deferred member, in index order', () => {
    const r: RequestRow = {
      ...ROW,
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'served',
          servedIndex: 0,
          ask: 100_000,
          deferred: [
            lacking(2, 'c', ['tools']),
            capped(1, 'b', 8_192),
            lacking(1, 'b', ['vision']),
          ],
        }),
      ],
    };
    expect(deferralsOf(toRouteTrace(r)).map((n) => n.text)).toEqual([
      'deferred · b · lacks vision · output cap 8,192 < 100,000 asked',
      'deferred · c · lacks tools',
    ]);
  });

  it('a deferred member is never a branch, and a row without a record draws no deferral row', () => {
    const r: RequestRow = {
      ...ROW,
      status: 'fallback',
      attemptFailures: [entry({ index: 0, model: 'a', status: 429 })],
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'served',
          servedIndex: 1,
          deferred: [lacking(2, 'never-reached', ['tools'])],
        }),
      ],
    };
    const trace = toRouteTrace(r);
    expect(trace.map((n) => n.kind)).toEqual([
      'source',
      'decision',
      'deferral',
      'attempt',
      'outcome',
    ]);
    for (const a of attemptsOf(trace)) expect(a.model).not.toBe('never-reached');
    // The routing reason never stands in for the record.
    for (const routingReason of [
      'auto → output_cap_deferred ~gpt-a(4096<100000)',
      'auto → capability_deferred ~z-ai/glm-latest(vision)',
    ]) {
      const legacy = toRouteTrace({ ...ROW, routingReason });
      expect(legacy.map((n) => n.kind)).toEqual(['source', 'decision', 'outcome']);
      expect(legacy.map((n) => n.text).join(' ')).not.toMatch(/deferred|lacks|output cap/);
    }
    expect(deferralsOf(toRouteTrace(UNRECORDED_ESCALATION))).toEqual([]);
  });

  it("a leg's deferrals sit directly under its leg row, with no leg tag", () => {
    const r: RequestRow = {
      ...UNRECORDED_ESCALATION,
      status: 'fallback',
      attemptFailures: [
        entry({ index: 0, model: 'cheap-1', kind: 'timeout', leg: 'cheap' }),
        entry({ index: 0, model: 'strong-1', status: 429, leg: 'escalation' }),
      ],
      routeLegs: [
        leg({
          leg: 'cheap',
          end: 'exhausted',
          endedMs: 2_450,
          deferred: [lacking(1, 'cheap-vl', ['vision'])],
        }),
        leg({
          leg: 'escalation',
          end: 'served',
          endedMs: 38_000,
          servedIndex: 1,
          deferred: [lacking(2, 'strong-text', ['vision'])],
        }),
      ],
    };
    expect(traceTexts(r)).toEqual([
      'Lobechat',
      'router · cascade',
      'cheap leg',
      'deferred · cheap-vl · lacks vision',
      'cheap-1 · timeout',
      'escalation · cheap leg exhausted · at 2.45s',
      'deferred · strong-text · lacks vision',
      'strong-1 · rate_limit · HTTP 429',
      'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
    ]);
    for (const d of deferralsOf(toRouteTrace(r)))
      expect(d.text).not.toMatch(/cheap leg|escalation/);
  });
});

/** dashboard-analytics "A clamped call states its output cap". */
describe('a clamped call states its output cap (record-route-legs 7.2)', () => {
  it('a clamped served call states its cap on the lit outcome, with the ask or without', () => {
    const served = (ask: number | undefined): RequestRow => ({
      ...ROW,
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'served',
          servedIndex: 0,
          ...(ask === undefined ? {} : { ask }),
          clamps: [{ index: 0, model: 'GPT', to: 4_096 }],
        }),
      ],
    });
    const withAsk = outcomeOf(toRouteTrace(served(100_000)));
    expect(withAsk).toMatchObject({ emphasis: 'lit', clamp: { to: '4,096', ask: '100,000' } });
    expect(withAsk.text).toBe(
      'OpenAI · GPT · served · 1.20s · output capped at 4,096 of 100,000 asked',
    );
    const noAsk = outcomeOf(toRouteTrace(served(undefined)));
    expect(noAsk.clamp).toEqual({ to: '4,096', ask: null });
    expect(noAsk.text).toBe('OpenAI · GPT · served · 1.20s · output capped at 4,096');
  });

  it('a kept cheap answer states its cap above its verdict', () => {
    const r: RequestRow = {
      ...CASCADE,
      qualitySignal: 0.87,
      routeLegs: [
        leg({
          leg: 'cheap',
          end: 'served',
          servedIndex: 0,
          ask: 100_000,
          clamps: [{ index: 0, model: 'Cheap', to: 4_096 }],
        }),
      ],
    };
    expect(outcomeOf(toRouteTrace(r)).text).toBe(
      'Groq · Cheap · served · 1.20s · output capped at 4,096 of 100,000 asked · quality gate passed · q=0.87',
    );
  });

  it('a clamped failed attempt states its cap after its markers, at the same leg and index', () => {
    const r: RequestRow = {
      ...ROW,
      status: 'fallback',
      attemptFailures: [
        entry({ index: 0, model: 'a', status: 429, markers: ['tokens_per_minute'] }),
      ],
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'served',
          servedIndex: 1,
          ask: 100_000,
          clamps: [{ index: 0, model: 'a', to: 4_096 }],
        }),
      ],
    };
    const [a] = attemptsOf(toRouteTrace(r));
    expect(a).toMatchObject({ emphasis: 'failed', label: 'rate_limit · HTTP 429', clamp: '4,096' });
    expect(a?.text).toBe('a · rate_limit · HTTP 429 · tokens_per_minute · output capped at 4,096');
    // The served member was not clamped, so the outcome states none.
    expect(outcomeOf(toRouteTrace(r)).clamp).toBeNull();
  });

  it('a clamp is read only at its own leg and index, and never on a skipped member', () => {
    const r: RequestRow = {
      ...UNRECORDED_ESCALATION,
      status: 'fallback',
      attemptFailures: [
        entry({ index: 0, model: 'cheap-1', kind: 'timeout', leg: 'cheap' }),
        entry({ index: 1, model: 'cheap-2', kind: 'unavailable', dispatched: false, leg: 'cheap' }),
        entry({ index: 0, model: 'strong-1', status: 429, leg: 'escalation' }),
      ],
      routeLegs: [
        leg({
          leg: 'cheap',
          end: 'exhausted',
          clamps: [{ index: 1, model: 'cheap-2', to: 2_048 }],
        }),
        leg({
          leg: 'escalation',
          end: 'served',
          servedIndex: 1,
          clamps: [{ index: 0, model: 'strong-1', to: 8_192 }],
        }),
      ],
    };
    expect(attemptsOf(toRouteTrace(r)).map((a) => [a.model, a.clamp])).toEqual([
      ['cheap-1', null],
      ['cheap-2', null],
      ['strong-1', '8,192'],
    ]);
  });

  it('a clamp is read from the route record, never from the reason', () => {
    const r: RequestRow = {
      ...ROW,
      status: 'fallback',
      routingReason: 'auto → output_cap_clamped ~gpt-a→4096 → GPT',
      attemptFailures: [entry({ index: 0, model: 'a', status: 429 })],
    };
    expect(traceTexts(r).join(' ')).not.toContain('output cap');
  });

  it('a superseded node and an unlit outcome state no cap', () => {
    const gated: RequestRow = {
      ...UNRECORDED_ESCALATION,
      escalationSource: 'quality_gate',
      qualitySignal: 0.42,
      attemptCostMicros: 3_100,
      priceSource: 'bundled',
      routeLegs: [
        leg({
          leg: 'cheap',
          end: 'gate_failed',
          servedIndex: 0,
          ask: 100_000,
          clamps: [{ index: 0, model: 'cheap-1', to: 4_096 }],
        }),
        leg({ leg: 'escalation', end: 'served', servedIndex: 0 }),
      ],
    };
    const committedError: RequestRow = {
      ...ROW,
      status: 'error',
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'served',
          servedIndex: 0,
          ask: 100_000,
          clamps: [{ index: 0, model: 'GPT', to: 4_096 }],
        }),
      ],
    };
    for (const r of [gated, committedError]) {
      expect(traceTexts(r).join(' ')).not.toMatch(/output cap|4,096/);
      expect(outcomeOf(toRouteTrace(r)).clamp).toBeNull();
    }
  });
});

/** dashboard-analytics "The member that stopped a walk is drawn". */
describe('the member that stopped a walk is drawn (record-route-legs 7.2)', () => {
  const failedA = entry({ index: 0, providerId: 'p1', model: 'gpt-a', status: 429 });

  it('a non-retryable stop at a later member is a failed attempt, and the outcome names no one', () => {
    const r: RequestRow = {
      ...ROW,
      status: 'error',
      attemptFailures: [failedA],
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'stopped',
          stopped: { index: 1, model: 'gpt-b', sent: true, kind: 'policy_block', status: 451 },
        }),
      ],
    };
    const trace = toRouteTrace(r);
    expect(trace.map((n) => n.text)).toEqual([
      'openclaw',
      'router · structural',
      'gpt-a · rate_limit · HTTP 429',
      'gpt-b · policy_block · HTTP 451',
      'failed · 1.20s',
    ]);
    expect(attemptsOf(trace)[1]).toMatchObject({
      emphasis: 'failed',
      label: 'policy_block · HTTP 451',
      stop: null,
    });
    expect(outcomeOf(trace)).toMatchObject({ emphasis: 'neutral', provider: null, model: null });
    // What the outcome no longer names, the Decision section states as recorded.
    expect(toInspectorView(r).recordedProvider).toBe('OpenAI');
    // A stopper that recorded no status reads like any failed attempt without one.
    const oversized: RequestRow = {
      ...r,
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'stopped',
          stopped: { index: 1, model: 'gpt-b', sent: true, kind: 'oversized_response' },
        }),
      ],
    };
    expect(attemptsOf(toRouteTrace(oversized))[1]?.text).toBe('gpt-b · oversized_response');
  });

  it("a cancel's in-flight member is drawn neutral, never red, and the outcome names no one", () => {
    const r: RequestRow = {
      ...ROW,
      status: 'cancelled',
      durationMs: 800,
      attemptFailures: [failedA],
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'cancelled',
          stopped: { index: 1, model: 'gpt-b', sent: true },
        }),
      ],
    };
    const trace = toRouteTrace(r);
    expect(trace.map((n) => n.text)).toEqual([
      'openclaw',
      'router · structural',
      'gpt-a · rate_limit · HTTP 429',
      'gpt-b · in flight',
      'cancelled by client · 800ms',
    ]);
    expect(attemptsOf(trace)[1]).toEqual({
      kind: 'attempt',
      emphasis: 'in_flight',
      model: 'gpt-b',
      label: 'in flight',
      stop: null,
      markers: null,
      clamp: null,
      text: 'gpt-b · in flight',
    });
    expect(outcomeOf(trace)).toMatchObject({ provider: null, model: null });
  });

  it('a route record adds its deferrals and its stopper to the walk, read as text in walk order', () => {
    const r: RequestRow = {
      ...ROW,
      status: 'cancelled',
      durationMs: 800,
      attemptFailures: [failedA],
      routeLegs: [
        leg({
          leg: 'primary',
          end: 'cancelled',
          ask: 100_000,
          stopped: { index: 1, model: 'gpt-b', sent: true },
          deferred: [lacking(2, 'gpt-text', ['tools'])],
          clamps: [{ index: 1, model: 'gpt-b', to: 4_096 }],
        }),
      ],
    };
    const trace = toRouteTrace(r);
    expect(trace.map((n) => n.kind)).toEqual([
      'source',
      'decision',
      'deferral',
      'attempt',
      'attempt',
      'outcome',
    ]);
    expect(trace.slice(2).map((n) => n.text)).toEqual([
      'deferred · gpt-text · lacks tools',
      'gpt-a · rate_limit · HTTP 429',
      'gpt-b · in flight · output capped at 4,096',
      'cancelled by client · 800ms',
    ]);
    // The in-flight and the failed member differ in their text alone.
    const [failed, inFlight] = attemptsOf(trace);
    expect(failed?.label).not.toBe(inFlight?.label);
  });

  it('a deadline stopper is drawn once: by its trail entry, or, with none, as that entry reads', () => {
    const cut = entry({
      index: 0,
      model: 'cheap-1',
      kind: 'unavailable',
      leg: 'cheap',
      stopReason: 'deadline',
    });
    const record: RouteLeg[] = [
      leg({
        leg: 'cheap',
        end: 'deadline',
        endedMs: 30_020,
        stopped: { index: 0, model: 'cheap-1', sent: true },
      }),
      leg({ leg: 'escalation', end: 'served', endedMs: 38_100, servedIndex: 0 }),
    ];
    const expected = [
      'Lobechat',
      'router · cascade',
      'cheap leg',
      'cheap-1 · no reply by the cheap deadline',
      'escalation · cheap deadline · at 30.02s',
      'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
    ];
    for (const attemptFailures of [[cut], null]) {
      const texts = traceTexts({ ...UNRECORDED_ESCALATION, attemptFailures, routeLegs: record });
      expect(texts).toEqual(expected);
      expect(texts.filter((t) => t.includes('cheap-1'))).toHaveLength(1);
      expect(texts.join(' ')).not.toContain('unavailable');
    }
  });

  it.each(['stopped', 'deadline', 'cancelled'] as const)(
    'an unsent stopper on a `%s` end is not drawn, and its end is still stated',
    (end) => {
      const stopped = {
        index: 1,
        model: 'unsent-b',
        sent: false,
        ...(end === 'stopped' ? { kind: 'policy_block' } : {}),
      };
      // On a final leg: no node, and the outcome names no provider or model.
      const finalRow: RequestRow = {
        ...ROW,
        status: end === 'cancelled' ? 'cancelled' : 'error',
        attemptFailures: [failedA],
        routeLegs: [leg({ leg: 'primary', end, stopped })],
      };
      const trace = toRouteTrace(finalRow);
      expect(trace.map((n) => n.text).join(' ')).not.toContain('unsent-b');
      expect(attemptsOf(trace)).toHaveLength(1);
      expect(outcomeOf(trace)).toMatchObject({ provider: null, model: null });
      // On an escalated cheap leg: no node, and the escalation row states how it ended.
      const cheapRow: RequestRow = {
        ...UNRECORDED_ESCALATION,
        routeLegs: [
          leg({ leg: 'cheap', end, endedMs: 2_450, stopped }),
          leg({ leg: 'escalation', end: 'served', servedIndex: 0 }),
        ],
      };
      const texts = traceTexts(cheapRow);
      expect(texts.join(' ')).not.toContain('unsent-b');
      if (end !== 'cancelled')
        expect(texts[3]).toMatch(/^escalation · cheap (leg stopped|deadline) · at 2\.45s$/);
    },
  );

  it('a cascade that ended in its cheap leg draws its stopper under the one leg row', () => {
    const stoppedRow: RequestRow = {
      ...CASCADE,
      status: 'error',
      attemptFailures: [entry({ index: 0, model: 'cheap-0', leg: 'cheap' })],
      routeLegs: [
        leg({
          leg: 'cheap',
          end: 'stopped',
          stopped: { index: 1, model: 'cheap-1', sent: true, kind: 'policy_block', status: 451 },
        }),
      ],
    };
    expect(traceTexts(stoppedRow)).toEqual([
      'openclaw',
      'router · cascade',
      'cheap leg',
      'cheap-0 · rate_limit',
      'cheap-1 · policy_block · HTTP 451',
      'failed · 1.20s',
    ]);
    const cancelledRow: RequestRow = {
      ...CASCADE,
      status: 'cancelled',
      durationMs: 800,
      routeLegs: [
        leg({
          leg: 'cheap',
          end: 'cancelled',
          stopped: { index: 0, model: 'cheap-0', sent: true },
        }),
      ],
    };
    expect(traceTexts(cancelledRow)).toEqual([
      'openclaw',
      'router · cascade',
      'cheap leg',
      'cheap-0 · in flight',
      'cancelled by client · 800ms',
    ]);
  });

  it("an escalation leg's stopper is that leg's last node, after its trail", () => {
    const r: RequestRow = {
      ...UNRECORDED_ESCALATION,
      status: 'error',
      durationMs: 3_100,
      attemptFailures: [
        entry({ index: 0, model: 'cheap-1', kind: 'timeout', leg: 'cheap', terminal: false }),
        entry({ index: 0, model: 'strong-1', status: 429, leg: 'escalation' }),
      ],
      routeLegs: [
        leg({ leg: 'cheap', end: 'exhausted', endedMs: 2_450 }),
        leg({
          leg: 'escalation',
          end: 'stopped',
          endedMs: 3_000,
          // The same index as a CHEAP entry: legs keep their own index spaces.
          stopped: { index: 0, model: 'strong-0', sent: true, kind: 'policy_block', status: 451 },
        }),
      ],
    };
    // strong-1 at escalation index 0 is the trail entry: the stopper there is drawn once, by it.
    expect(traceTexts(r).slice(2)).toEqual([
      'cheap leg',
      'cheap-1 · timeout',
      'escalation · cheap leg exhausted · at 2.45s',
      'strong-1 · rate_limit · HTTP 429',
      'failed · 3.10s',
    ]);
    const atNextIndex: RequestRow = {
      ...r,
      routeLegs: [
        leg({ leg: 'cheap', end: 'exhausted', endedMs: 2_450 }),
        leg({
          leg: 'escalation',
          end: 'stopped',
          endedMs: 3_000,
          stopped: { index: 1, model: 'strong-2', sent: true, kind: 'policy_block', status: 451 },
        }),
      ],
    };
    expect(traceTexts(atNextIndex).slice(-3)).toEqual([
      'strong-1 · rate_limit · HTTP 429',
      'strong-2 · policy_block · HTTP 451',
      'failed · 3.10s',
    ]);
  });

  it('a row without a route record draws no stopper', () => {
    for (const status of ['error', 'cancelled'] as const) {
      const r: RequestRow = { ...ROW, status, attemptFailures: [failedA] };
      expect(toRouteTrace(r).map((n) => n.kind)).toEqual([
        'source',
        'decision',
        'attempt',
        'outcome',
      ]);
    }
  });
});

/** dashboard-analytics "The escalation row states how and when the cheap leg ended". */
describe('the escalation row states how and when the cheap leg ended (record-route-legs 7.2)', () => {
  const escalation = (r: RequestRow): RouteTraceLegNode | undefined =>
    toRouteTrace(r).find((n): n is RouteTraceLegNode => n.kind === 'leg' && n.leg === 'escalation');
  const withCheap = (cheap: RouteLeg, over: Partial<RequestRow> = {}): RequestRow => ({
    ...UNRECORDED_ESCALATION,
    ...over,
    routeLegs: [cheap, leg({ leg: 'escalation', end: 'served', endedMs: 38_000, servedIndex: 0 })],
  });

  it('a cheap deadline states the cause and the recorded time, never `30.0s`', () => {
    const row = escalation(
      withCheap(leg({ leg: 'cheap', end: 'deadline', endedMs: 30_020 }), { durationMs: 38_890 }),
    );
    expect(row).toMatchObject({ emphasis: 'neutral', detail: 'cheap deadline', at: '30.02s' });
    expect(row?.text).toBe('escalation · cheap deadline · at 30.02s');
    expect(row?.text).not.toContain('30.0s');
  });

  it.each([
    [
      'gate_failed',
      { escalationSource: 'quality_gate' as const },
      'escalation · quality gate · at 2.45s',
    ],
    ['exhausted', {}, 'escalation · cheap leg exhausted · at 2.45s'],
    ['replay_failed', {}, 'escalation · cheap answer not delivered · at 2.45s'],
    ['stopped', {}, 'escalation · cheap leg stopped · at 2.45s'],
  ] as const)('a recorded `%s` cheap end reads its words', (end, over, text) => {
    const r = withCheap(leg({ leg: 'cheap', end, endedMs: 2_450 }), over);
    expect(escalation(r)?.text).toBe(text);
    expect(traceTexts(r).join(' ')).not.toContain(CAUSE_CHEAP_DID_NOT_SERVE);
    // A `cheap_error` row draws no `q=` anywhere (a `quality_gate` row's superseded node does).
    if (r.escalationSource === 'cheap_error') expect(traceTexts(r).join(' ')).not.toContain('q=');
  });

  it('the time is the recorded `endedMs`, never the latency, the reason or another leg', () => {
    const r = withCheap(leg({ leg: 'cheap', end: 'exhausted', endedMs: 2_450 }), {
      durationMs: 9_999,
      routingReason: 'cascade: escalated cheap→heavy after 5.00s (q=0.00)',
    });
    expect(escalation(r)?.at).toBe('2.45s');
  });

  it('without a cheap end that states a cause, the row keeps the recorded source, untimed', () => {
    const untimed: RequestRow[] = [
      UNRECORDED_ESCALATION,
      { ...UNRECORDED_ESCALATION, routeLegs: [] },
      withCheap(leg({ leg: 'cheap', end: 'cancelled', endedMs: 800 })),
      withCheap(leg({ leg: 'cheap', end: 'served', endedMs: 800, servedIndex: 0 })),
    ];
    for (const r of untimed) {
      expect(escalation(r)).toMatchObject({ detail: 'cheap leg did not serve', at: null });
      expect(escalation(r)?.text).toBe('escalation · cheap leg did not serve');
    }
    expect(escalation({ ...UNRECORDED_ESCALATION, escalationSource: null })?.text).toBe(
      'escalation',
    );
  });

  it("a route record's quality-gate escalation keeps its superseded node and states the time", () => {
    const r: RequestRow = {
      ...UNRECORDED_ESCALATION,
      escalationSource: 'quality_gate',
      qualitySignal: 0.42,
      attemptCostMicros: 3_100,
      priceSource: 'bundled',
      routeLegs: [
        leg({ leg: 'cheap', end: 'gate_failed', endedMs: 2_450, servedIndex: 0 }),
        leg({ leg: 'escalation', end: 'served', endedMs: 38_000, servedIndex: 0 }),
      ],
    };
    expect(traceTexts(r)).toEqual([
      'Lobechat',
      'router · cascade',
      'cheap leg',
      'cheap attempt superseded · q=0.42 · $0.0031',
      'escalation · quality gate · at 2.45s',
      'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
    ]);
    expect(supersededOf(toRouteTrace(r))?.text).not.toMatch(/cheap-|Groq/);
  });
});

/** dashboard-analytics "The cheap leg row says when its attempts were not recorded". */
describe('`attempts not recorded` only without a recorded cheap leg (record-route-legs 7.2)', () => {
  it('a recorded cheap end with nothing attempted carries no note', () => {
    const r: RequestRow = {
      ...UNRECORDED_ESCALATION,
      routeLegs: [
        leg({ leg: 'cheap', end: 'deadline', endedMs: 30_000 }),
        leg({ leg: 'escalation', end: 'served', endedMs: 38_000, servedIndex: 0 }),
      ],
    };
    expect(traceTexts(r)).toEqual([
      'Lobechat',
      'router · cascade',
      'cheap leg',
      'escalation · cheap deadline · at 30.00s',
      'XiaomiMiMo · mimo-v2.6-pro · served · 38.89s',
    ]);
    expect(traceTexts(r).join(' ')).not.toMatch(/Groq|Cheap|cheap-model/);
  });

  it('a cheap answer that was not delivered carries no note and draws no superseded node', () => {
    const r: RequestRow = {
      ...UNRECORDED_ESCALATION,
      routeLegs: [
        leg({ leg: 'cheap', end: 'replay_failed', endedMs: 2_450, servedIndex: 0 }),
        leg({ leg: 'escalation', end: 'served', endedMs: 38_000, servedIndex: 0 }),
      ],
    };
    expect(traceTexts(r).slice(2, 4)).toEqual([
      'cheap leg',
      'escalation · cheap answer not delivered · at 2.45s',
    ]);
    expect(supersededOf(toRouteTrace(r))).toBeUndefined();
  });

  it('a row whose record holds no cheap leg keeps the note', () => {
    for (const routeLegs of [null, []])
      expect(traceTexts({ ...UNRECORDED_ESCALATION, routeLegs })[2]).toBe(
        'cheap leg · attempts not recorded',
      );
  });
});

/** dashboard-analytics "The route trace lights only a served outcome" (the outcome-naming rule). */
describe('the outcome names what the route record proves (record-route-legs 7.2)', () => {
  /** Two trail entries on the row's provider, so `unlitProvider` alone would name none. */
  const trail = [entry({ index: 0, providerId: 'p1', model: 'gpt-a', status: 429 })];

  it.each([
    ['error', 'stopped', 'failed · 1.20s'],
    ['error', 'deadline', 'failed · 1.20s'],
    ['cancelled', 'cancelled', 'cancelled by client · 1.20s'],
    ['throttled', 'stopped', 'throttled · 1.20s'],
  ] as const)(
    'a `%s` row whose final leg ended `%s` names no provider or model',
    (status, end, text) => {
      for (const sent of [true, false]) {
        const r: RequestRow = {
          ...ROW,
          status,
          routeLegs: [
            leg({
              leg: 'primary',
              end,
              stopped: {
                index: 1,
                model: 'gpt-b',
                sent,
                ...(end === 'stopped' ? { kind: 'policy_block' } : {}),
              },
            }),
          ],
        };
        expect(outcomeOf(toRouteTrace(r))).toMatchObject({ provider: null, model: null, text });
      }
      // With no member being attempted (a cancel or a deadline between members), the same.
      const between: RequestRow = { ...ROW, status, routeLegs: [leg({ leg: 'primary', end })] };
      expect(outcomeOf(toRouteTrace(between)).text).toBe(text);
    },
  );

  it('a failure or cancel after commit names the recorded provider and model', () => {
    for (const [status, result] of [
      ['error', 'failed'],
      ['cancelled', 'cancelled by client'],
    ] as const) {
      const r: RequestRow = {
        ...ROW,
        status,
        attemptFailures: trail,
        routeLegs: [leg({ leg: 'primary', end: 'served', servedIndex: 1 })],
      };
      expect(outcomeOf(toRouteTrace(r))).toMatchObject({
        emphasis: 'neutral',
        provider: 'OpenAI',
        model: 'GPT',
        text: `OpenAI · GPT · ${result} · 1.20s`,
      });
      // The same row without its record names the model only (flag RF-1).
      expect(outcomeOf(toRouteTrace({ ...r, routeLegs: null })).provider).toBeNull();
    }
  });

  it('an exhausted final leg names exactly what the same row without a record names', () => {
    const shapes: Partial<RequestRow>[] = [
      {
        status: 'error',
        attemptFailures: [entry({ index: 0, providerId: 'p1', model: 'gpt-a', terminal: true })],
      },
      {
        status: 'error',
        attemptFailures: [entry({ index: 0, providerId: 'p9', model: 'gpt-a', terminal: true })],
      },
      {
        status: 'error',
        attemptFailures: [
          entry({ index: 0, providerId: 'p1', model: 'gpt-a', dispatched: false, terminal: true }),
        ],
      },
      { status: 'cancelled', attemptFailures: trail },
      { status: 'throttled', attemptFailures: trail },
    ];
    for (const shape of shapes) {
      const bare: RequestRow = { ...ROW, ...shape };
      const recorded: RequestRow = {
        ...bare,
        routeLegs: [leg({ leg: 'primary', end: 'exhausted' })],
      };
      expect(outcomeOf(toRouteTrace(recorded))).toEqual(outcomeOf(toRouteTrace(bare)));
    }
    // The scenario's row: a terminal entry on the row's provider reads `<provider> · failed`.
    expect(
      outcomeOf(
        toRouteTrace({
          ...ROW,
          ...shapes[0],
          routeLegs: [leg({ leg: 'primary', end: 'exhausted' })],
        }),
      ).text,
    ).toBe('OpenAI · failed · 1.20s');
  });

  it('a served row is lit as before, its record adding only a clamp', () => {
    for (const status of ['success', 'fallback'] as const) {
      const r: RequestRow = {
        ...ROW,
        status,
        routeLegs: [leg({ leg: 'primary', end: 'served', servedIndex: 0 })],
      };
      expect(outcomeOf(toRouteTrace(r))).toEqual(
        outcomeOf(toRouteTrace({ ...r, routeLegs: null })),
      );
    }
  });
});

/** dashboard-analytics "The Decision section prints no quality signal on a cheap-leg escalation". */
describe('the Decision section shows a replay-failed cheap answer’s signal (record-route-legs 7.2)', () => {
  it('a passing cheap answer that was not delivered shows its signal; other cheap ends do not', () => {
    const at = (end: RouteLeg['end']): RequestRow => ({
      ...UNRECORDED_ESCALATION,
      qualitySignal: 0.81,
      routeLegs: [
        leg({
          leg: 'cheap',
          end,
          endedMs: 2_450,
          ...(end === 'replay_failed' ? { servedIndex: 0 } : {}),
        }),
        leg({ leg: 'escalation', end: 'served', servedIndex: 0 }),
      ],
    });
    const replayed = at('replay_failed');
    expect(toInspectorView(replayed).qualitySignal).toBe(0.81);
    // The trace still draws no `q=`, and its escalation row says what happened.
    expect(traceTexts(replayed).join(' ')).not.toContain('q=');
    expect(traceTexts(replayed)).toContain('escalation · cheap answer not delivered · at 2.45s');
    for (const end of ['exhausted', 'deadline', 'stopped', 'cancelled'] as const)
      expect(toInspectorView(at(end)).qualitySignal, end).toBeNull();
    expect(
      toInspectorView({ ...UNRECORDED_ESCALATION, qualitySignal: 0.81 }).qualitySignal,
    ).toBeNull();
  });
});

/** "Rows without `routeLegs` keep" every reading: the empty record is no record. The rendered
 * proof against the code before this change is the golden in `routeTrace.view.test.tsx`. */
describe('a row without a route record reads as before (record-route-legs 7.2)', () => {
  it('an empty record and a null one build the same inspector view, over every fixture here', () => {
    const fixtures: RequestRow[] = [
      ROW,
      CASCADE,
      UNRECORDED_ESCALATION,
      { ...ROW, status: 'fallback', attemptFailures: [entry({ model: 'a', status: 429 })] },
      { ...ROW, status: 'error', attemptFailures: [entry({ model: 'a', terminal: true })] },
      { ...ROW, status: 'cancelled' },
      { ...CASCADE, status: 'error', attemptFailures: [entry({ model: 'c', leg: 'cheap' })] },
      { ...UNRECORDED_ESCALATION, escalationSource: 'quality_gate', attemptCostMicros: 3_100 },
    ];
    for (const r of fixtures) {
      const none = toInspectorView({ ...r, routeLegs: null });
      expect(toInspectorView({ ...r, routeLegs: [] })).toEqual(none);
      // No node a record would add, and no recorded time.
      expect(none.trace.map((n) => n.kind)).not.toContain('deferral');
      for (const n of none.trace) {
        if (n.kind === 'leg') expect(n.at).toBeNull();
        if (n.kind === 'attempt') {
          expect(n.clamp).toBeNull();
          expect(n.emphasis).not.toBe('in_flight');
        }
        if (n.kind === 'outcome') expect(n.clamp).toBeNull();
      }
    }
  });
});
