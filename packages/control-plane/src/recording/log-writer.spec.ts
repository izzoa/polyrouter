import { randomUUID } from 'node:crypto';
import type { PersistencePort, PriceSnapshot, Principal } from '@polyrouter/shared/server';
import { userPrincipal } from '@polyrouter/shared/server';
import { computeCost } from '@polyrouter/data-plane';
import { ProxyMetrics } from '../observability/proxy-metrics';
import type { PricingService } from '../pricing/pricing.service';
import {
  LogWriter,
  type LogWriterConfig,
  type RequestAttemptDraft,
  type RequestLogDraft,
} from './log-writer';

const CONFIG: LogWriterConfig = {
  intervalMs: 1_000_000, // never auto-fire in tests
  batchSize: 1_000_000,
  maxQueue: 3,
  maxRetries: 2,
  backoffMs: 1,
  opTimeoutMs: 1_000, // generous; tests that exercise it override with a small value
};

function draft(over: Partial<RequestLogDraft> = {}): RequestLogDraft {
  return {
    id: over.id ?? randomUUID(),
    principal: over.principal ?? userPrincipal('u1'),
    agentId: 'a1',
    providerId: 'p1',
    providerName: 'openai',
    modelId: 'm1',
    tierAssigned: 'default',
    decisionLayer: 'default',
    routingReason: 'default tier',
    durationMs: 5,
    status: 'success',
    billed: true,
    usage: { inputTokens: 10, outputTokens: 5, estimated: false },
    pricing: {
      externalModelId: 'gpt-4o',
      modelInputPricePer1m: null,
      modelOutputPricePer1m: null,
      modelIsFree: false,
      listedInputPricePer1m: null,
      listedOutputPricePer1m: null,
      listedIsFree: false,
      providerBaseUrl: 'https://api.openai.com/v1',
      providerKind: 'api_key',
      at: new Date('2026-07-15T00:00:00Z'),
    },
    ...over,
  };
}

function attemptDraft(over: Partial<RequestAttemptDraft> = {}): RequestAttemptDraft {
  return {
    id: over.id ?? randomUUID(),
    requestLogId: over.requestLogId ?? randomUUID(),
    principal: over.principal ?? userPrincipal('u1'),
    attemptIndex: 0,
    tierKey: 'cheap',
    providerId: 'p1',
    providerName: 'openai',
    modelId: 'm1',
    status: 'fallback',
    usage: { inputTokens: 3, outputTokens: 1, estimated: false },
    pricing: {
      externalModelId: 'gpt-4o',
      modelInputPricePer1m: null,
      modelOutputPricePer1m: null,
      modelIsFree: false,
      listedInputPricePer1m: null,
      listedOutputPricePer1m: null,
      listedIsFree: false,
      providerBaseUrl: 'https://api.openai.com/v1',
      providerKind: 'api_key',
      at: new Date('2026-07-15T00:00:00Z'),
    },
    ...over,
  };
}

const snapshot = (): PriceSnapshot => ({
  priceVersionId: 'v1',
  modelKey: 'openai:gpt-4o',
  inputPricePer1m: 2.5,
  outputPricePer1m: 10,
  cacheReadPricePer1m: null,
  cacheWritePricePer1m: null,
  isFree: false,
  source: 'bundled',
  validFrom: new Date('2026-07-15T00:00:00Z'),
  mode: 'sync',
});

function makeWriter(overrides: {
  insertMany?: jest.Mock;
  attemptInsertMany?: jest.Mock;
  resolveForModel?: jest.Mock;
  config?: Partial<LogWriterConfig>;
}): {
  writer: LogWriter;
  insertMany: jest.Mock;
  attemptInsertMany: jest.Mock;
  resolveForModel: jest.Mock;
  metrics: ProxyMetrics;
} {
  const insertMany = overrides.insertMany ?? jest.fn().mockResolvedValue(undefined);
  const attemptInsertMany = overrides.attemptInsertMany ?? jest.fn().mockResolvedValue(undefined);
  const resolveForModel = overrides.resolveForModel ?? jest.fn().mockResolvedValue(snapshot());
  const db = {
    requestLogs: { insertMany },
    requestAttempts: { insertMany: attemptInsertMany },
    bodyCapture: {
      insertBodies: jest.fn().mockResolvedValue({ inserted: 0, discarded: 0 }),
      incrementDropped: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as PersistencePort;
  const pricing = { resolveForModel } as unknown as PricingService;
  const metrics = new ProxyMetrics();
  const bodyCfg = {
    selfhosted: true,
    maxBytes: 262_144,
    queueBudgetBytes: 64 * 1024 * 1024,
    batchBudgetBytes: 4 * 1024 * 1024,
    credentialKey: 'c'.repeat(64),
  };
  return {
    writer: new LogWriter(db, pricing, { ...CONFIG, ...overrides.config }, metrics, bodyCfg),
    insertMany,
    attemptInsertMany,
    resolveForModel,
    metrics,
  };
}

describe('LogWriter', () => {
  it('resolves price + cost and inserts on flush', async () => {
    const { writer, insertMany, resolveForModel } = makeWriter({});
    writer.enqueue(draft());
    await writer.flush();
    expect(resolveForModel).toHaveBeenCalledTimes(1);
    expect(insertMany).toHaveBeenCalledTimes(1);
    const [, rows] = insertMany.mock.calls[0] as [
      Principal,
      { cost: number; inputPriceSnapshot: number }[],
    ];
    // 10/1e6*2.5 + 5/1e6*10 = 0.0000250 + 0.0000500 = 0.000075
    expect(rows[0]!.cost).toBeCloseTo(0.000075, 9);
    expect(rows[0]!.inputPriceSnapshot).toBe(2.5);
  });

  it('carries the decision-time scope beside the epoch, both null when absent (add-per-agent-calibration)', async () => {
    // The pair is the key: both counters default to 0 and advance on their own
    // events, so an epoch with no scope cannot say whose evidence a row is.
    // This test exists because the field WAS silently dropped once — a spread
    // of an unknown property is not an excess-property error in TypeScript, so
    // the stamp typechecked and never reached the column.
    const { writer, insertMany } = makeWriter({});
    writer.enqueue(draft({ structuralEpoch: 3, structuralScope: 'agent' }));
    writer.enqueue(draft({ id: randomUUID(), structuralEpoch: 3, structuralScope: 'tenant' }));
    writer.enqueue(draft({ id: randomUUID() })); // non-auto: neither is stamped
    await writer.flush();
    const [, rows] = insertMany.mock.calls[0] as [
      Principal,
      { structuralEpoch: number | null; structuralScope: string | null }[],
    ];
    expect(rows.map((r) => [r.structuralScope, r.structuralEpoch])).toEqual([
      ['agent', 3],
      ['tenant', 3],
      [null, null],
    ]);
  });

  it('maps the per-attempt trail to the attempt_failures column, null when absent (add-fallback-attempt-detail)', async () => {
    const { writer, insertMany } = makeWriter({});
    const attemptFailures = [
      {
        index: 0,
        providerId: 'p1',
        model: 'a',
        kind: 'unavailable',
        status: 529,
        dispatched: true,
      },
      {
        index: 1,
        providerId: 'p2',
        model: 'b',
        kind: 'unavailable',
        dispatched: false,
        terminal: true,
      },
    ];
    writer.enqueue(draft({ status: 'error', attemptFailures }));
    writer.enqueue(draft({ id: randomUUID() }));
    await writer.flush();
    const [, rows] = insertMany.mock.calls[0] as [
      Principal,
      { attemptFailures: unknown; status: string }[],
    ];
    const errorRow = rows.find((r) => r.status === 'error')!;
    const successRow = rows.find((r) => r.status === 'success')!;
    expect(errorRow.attemptFailures).toEqual(attemptFailures);
    expect(successRow.attemptFailures).toBeNull();
  });

  it('records the snapshot priceSource verbatim on BOTH ledgers (add-native-price-fallback)', async () => {
    const native = { ...snapshot(), source: 'native_family' as const };
    const { writer, insertMany, attemptInsertMany } = makeWriter({
      resolveForModel: jest.fn().mockResolvedValue(native),
    });
    writer.enqueue(draft({ id: 'L1' }));
    writer.enqueueAttempt(attemptDraft({ id: 'A1', requestLogId: 'L1' }));
    await writer.flush();
    const [, logRows] = insertMany.mock.calls[0] as [unknown, { priceSource: string }[]];
    expect(logRows[0]!.priceSource).toBe('native_family');
    const [, attemptRows] = attemptInsertMany.mock.calls[0] as [unknown, { priceSource: string }[]];
    expect(attemptRows[0]!.priceSource).toBe('native_family');
    // And an unpriced draft records null, not a stale source.
    const { writer: w2, insertMany: i2 } = makeWriter({
      resolveForModel: jest.fn().mockResolvedValue(null),
    });
    w2.enqueue(draft({ id: 'L2' }));
    await w2.flush();
    const [, unpriced] = i2.mock.calls[0] as [unknown, { priceSource: string | null }[]];
    expect(unpriced[0]!.priceSource).toBeNull();
  });

  it('batches per principal (a deleted owner cannot poison another tenant)', async () => {
    const { writer, insertMany } = makeWriter({});
    writer.enqueue(draft({ principal: userPrincipal('u1') }));
    writer.enqueue(draft({ principal: userPrincipal('u2') }));
    await writer.flush();
    expect(insertMany).toHaveBeenCalledTimes(2); // one batch per principal
  });

  it('retries a failing insert then drops without throwing', async () => {
    const insertMany = jest.fn().mockRejectedValue(new Error('db down'));
    const { writer } = makeWriter({ insertMany });
    writer.enqueue(draft());
    await expect(writer.flush()).resolves.toBeUndefined(); // never throws
    expect(insertMany).toHaveBeenCalledTimes(CONFIG.maxRetries + 1); // tried then dropped
  });

  it('retries a failing PRICE lookup too (the whole attempt is wrapped)', async () => {
    const resolveForModel = jest.fn().mockRejectedValue(new Error('pricing db down'));
    const { writer, insertMany } = makeWriter({ resolveForModel });
    writer.enqueue(draft());
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(resolveForModel).toHaveBeenCalledTimes(CONFIG.maxRetries + 1);
    expect(insertMany).not.toHaveBeenCalled(); // never reached insert
  });

  it('drops the oldest on queue overflow, still flushing the rest', async () => {
    const { writer, insertMany } = makeWriter({});
    for (let i = 0; i < CONFIG.maxQueue + 2; i++) writer.enqueue(draft({ id: `d${i}` }));
    await writer.flush();
    const [, rows] = insertMany.mock.calls[0] as [Principal, { id: string }[]];
    expect(rows.length).toBe(CONFIG.maxQueue); // 2 oldest dropped
    expect(rows.some((r) => r.id === 'd0')).toBe(false);
  });

  // --- #21 metrics at the writer ---

  it('emits cost exactly once when the first insert fails and the retry succeeds', async () => {
    const insertMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    const { writer, metrics } = makeWriter({ insertMany });
    writer.enqueue(draft());
    await writer.flush();
    expect(insertMany).toHaveBeenCalledTimes(2); // failed once, then succeeded
    // 0.000075 USD → 75 µ$, counted ONCE despite the retry rebuilding rows.
    expect(await metrics.metricsText()).toContain(
      'polyrouter_cost_microusd_total{provider="openai",model="gpt-4o"} 75',
    );
  });

  it('emits no cost for unpriced rows or dropped batches; drops hit the counter', async () => {
    // Unpriced: no snapshot → cost null → no cost series.
    const unpriced = makeWriter({ resolveForModel: jest.fn().mockResolvedValue(null) });
    unpriced.writer.enqueue(draft());
    await unpriced.writer.flush();
    expect(await unpriced.metrics.metricsText()).not.toContain('polyrouter_cost_microusd_total{');

    // Give-up: every insert fails → the row drops, no cost, drop counter = 1.
    const failing = makeWriter({ insertMany: jest.fn().mockRejectedValue(new Error('db down')) });
    failing.writer.enqueue(draft());
    await failing.writer.flush();
    const text = await failing.metrics.metricsText();
    expect(text).not.toContain('polyrouter_cost_microusd_total{');
    expect(text).toContain('polyrouter_log_rows_dropped_total 1');
  });

  it('counts queue-overflow drops on the same counter', async () => {
    const { writer, metrics } = makeWriter({});
    for (let i = 0; i < CONFIG.maxQueue + 2; i++) writer.enqueue(draft({ id: `q${i}` }));
    await writer.flush();
    expect(await metrics.metricsText()).toContain('polyrouter_log_rows_dropped_total 2');
  });

  // --- E5.1: the shutdown flush drains to completion, bounded ---

  it('the shutdown drain writes a draft enqueued while a flush is in flight', async () => {
    let resolveFirst!: () => void;
    const firstInsert = new Promise<void>((r) => (resolveFirst = () => r()));
    const insertMany = jest.fn().mockReturnValueOnce(firstInsert).mockResolvedValue(undefined);
    const { writer } = makeWriter({ insertMany });
    writer.enqueue(draft({ id: 'first' }));
    const first = writer.flush(); // flush #1 — insertMany pending on 'first'
    writer.enqueue(draft({ id: 'late' })); // enqueued AFTER flush #1's splice
    const shutdown = writer.onApplicationShutdown(); // coalesces, then re-drains
    resolveFirst();
    await Promise.all([first, shutdown]);
    expect(insertMany).toHaveBeenCalledTimes(2); // NOT a silent no-op
    const secondRows = insertMany.mock.calls[1]![1] as { id: string }[];
    expect(secondRows.map((r) => r.id)).toEqual(['late']); // the late draft survived
  });

  it('body drafts are BYTE-evicted oldest-first under queue pressure, with counted drops (add-body-capture)', async () => {
    // Queue budget below two cap-sized bodies: the second enqueue must evict
    // the FIRST draft's bodies (log rows untouched) and count the drop.
    const h = makeWriter({});
    const bodies = (tag: string) => [
      {
        direction: 'request' as const,
        content: tag.repeat(600), // ~600B per body
        bytes: 600,
        truncated: false,
        partial: false,
        epoch: 0,
        capturedAt: new Date('2026-07-15T00:00:00Z'),
      },
    ];
    (h.writer as unknown as { bodyCfg: { queueBudgetBytes: number } }).bodyCfg.queueBudgetBytes =
      1000;
    const first = draft({ id: 'B1' });
    first.bodies = bodies('a');
    const second = draft({ id: 'B2' });
    second.bodies = bodies('b');
    h.writer.enqueue(first);
    h.writer.enqueue(second);
    expect(first.bodies).toBeUndefined(); // oldest bodies evicted, draft kept
    expect(second.bodies).toBeDefined();
    await h.writer.flush();
    expect(h.insertMany).toHaveBeenCalledTimes(1); // BOTH log rows still landed
    const db = (h.writer as unknown as { db: { bodyCapture: { incrementDropped: jest.Mock } } }).db;
    expect(db.bodyCapture.incrementDropped).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('a concurrent enqueue during a blocked flush DROPS its bodies rather than busting the byte budget', async () => {
    let releaseInsert!: () => void;
    const gate = new Promise<void>((r) => (releaseInsert = r));
    const h = makeWriter({
      insertMany: jest.fn().mockImplementation(async () => {
        await gate; // the flush holds its spliced batch mid-insert
      }),
    });
    const w = h.writer as unknown as {
      bodyCfg: { queueBudgetBytes: number };
      bodyBytesQueued: number;
    };
    w.bodyCfg.queueBudgetBytes = 1000;
    const mk = (id: string) => {
      const d = draft({ id });
      d.bodies = [
        {
          direction: 'request' as const,
          content: 'z'.repeat(600),
          bytes: 600,
          truncated: false,
          partial: false,
          epoch: 0,
          capturedAt: new Date('2026-07-15T00:00:00Z'),
        },
      ];
      return d;
    };
    h.writer.enqueue(mk('F1'));
    const inFlight = h.writer.flush(); // splices F1; insert blocks on the gate
    const second = mk('F2');
    h.writer.enqueue(second); // nothing evictable (queue empty) → must drop, not exceed
    expect(second.bodies).toBeUndefined();
    expect(w.bodyBytesQueued).toBeLessThanOrEqual(1000);
    releaseInsert();
    await inFlight;
  });

  it('the shutdown drain terminates on a hung insert, counting the rows as dropped', async () => {
    const insertMany = jest.fn().mockReturnValue(new Promise<void>(() => undefined)); // never resolves
    const { writer, metrics } = makeWriter({
      insertMany,
      config: { opTimeoutMs: 20, backoffMs: 1 },
    });
    writer.enqueue(draft({ id: 'stuck' }));
    await writer.onApplicationShutdown(); // MUST NOT hang
    expect(insertMany).toHaveBeenCalledTimes(CONFIG.maxRetries + 1); // timed out each attempt
    expect(await metrics.metricsText()).toContain('polyrouter_log_rows_dropped_total 1');
  });

  it('a log + its attempt enqueued during a flush are written in one cycle, attempt after log', async () => {
    let resolveFirst!: () => void;
    const order: string[] = [];
    const firstInsert = new Promise<void>((r) => (resolveFirst = () => r()));
    const insertMany = jest
      .fn()
      .mockReturnValueOnce(firstInsert)
      .mockImplementation((_p: unknown, rows: { id: string }[]) => {
        order.push(`log:${rows.map((r) => r.id).join(',')}`);
        return Promise.resolve();
      });
    const attemptInsertMany = jest
      .fn()
      .mockImplementation((_p: unknown, rows: { id: string }[]) => {
        order.push(`attempt:${rows.map((r) => r.id).join(',')}`);
        return Promise.resolve();
      });
    const { writer } = makeWriter({ insertMany, attemptInsertMany });
    writer.enqueue(draft({ id: 'L1' }));
    const first = writer.flush(); // flush #1 — pending on L1
    writer.enqueue(draft({ id: 'L2' })); // a NEW log + its attempt during the in-flight flush
    writer.enqueueAttempt(attemptDraft({ id: 'A2', requestLogId: 'L2' }));
    const shutdown = writer.onApplicationShutdown();
    resolveFirst();
    await Promise.all([first, shutdown]);
    // L2 (parent) is written before A2 (child) in the same cycle — no FK-order drop.
    expect(order).toEqual(['log:L2', 'attempt:A2']);
  });

  // --- A-14: an orphaned attempt must not FK-poison its per-owner batch ---

  it('drops an orphaned attempt without dropping its valid siblings', async () => {
    const attemptInsertMany = jest.fn().mockResolvedValue(undefined);
    const { writer, metrics } = makeWriter({ attemptInsertMany });
    // A valid parent+attempt pair, plus an attempt whose parent 'L-missing' was never
    // enqueued — all owner u1, so pre-fix they share ONE insertMany batch.
    writer.enqueue(draft({ id: 'L-ok' }));
    writer.enqueueAttempt(attemptDraft({ id: 'A-ok', requestLogId: 'L-ok' }));
    writer.enqueueAttempt(attemptDraft({ id: 'A-orphan', requestLogId: 'L-missing' }));
    await writer.flush();
    // Only the attempt whose parent was written this cycle reaches the insert; the
    // orphan (which would FK-violate and fail the whole batch) is filtered out first.
    const insertedAttemptIds = attemptInsertMany.mock.calls.flatMap(
      ([, rows]: [unknown, { id: string }[]]) => rows.map((r) => r.id),
    );
    expect(insertedAttemptIds).toEqual(['A-ok']);
    // The orphan is a counted/logged drop, never a silent loss.
    expect(await metrics.metricsText()).toContain('polyrouter_log_rows_dropped_total 1');
  });

  it('a threshold-triggered flush keeps a same-tick parent+attempt in one cycle (A-14 race)', async () => {
    const attemptInsertMany = jest.fn().mockResolvedValue(undefined);
    // batchSize=1: enqueue(parent) crosses the threshold. A synchronous flush would
    // splice the log queue before the attempt (enqueued in the SAME tick) lands,
    // orphaning it. The deferred (microtask) flush must keep them together.
    const { writer } = makeWriter({ attemptInsertMany, config: { batchSize: 1 } });
    writer.enqueue(draft({ id: 'P' })); // hits batchSize → schedules a microtask flush
    writer.enqueueAttempt(attemptDraft({ id: 'C', requestLogId: 'P' })); // same tick, after
    await writer.onApplicationShutdown(); // drain to completion
    const attemptIds = attemptInsertMany.mock.calls.flatMap(
      ([, rows]: [unknown, { id: string }[]]) => rows.map((r) => r.id),
    );
    expect(attemptIds).toEqual(['C']); // inserted, NOT dropped as an orphan
  });

  it('orphans an attempt whose parent log insert gave up (parent never durable)', async () => {
    const insertMany = jest.fn().mockRejectedValue(new Error('db down')); // parent always fails
    const attemptInsertMany = jest.fn().mockResolvedValue(undefined);
    const { writer } = makeWriter({ insertMany, attemptInsertMany });
    writer.enqueue(draft({ id: 'L-fail' }));
    writer.enqueueAttempt(attemptDraft({ id: 'A-child', requestLogId: 'L-fail' }));
    await writer.flush();
    // Parent never became durable → its child is orphaned and not inserted (rather than
    // repeatedly FK-failing the attempt batch).
    expect(attemptInsertMany).not.toHaveBeenCalled();
  });
});

// zero-cost-unbilled-errors D3: the writer derives (cost, billed) TOGETHER from the
// draft's verdict + status, so the `request_log_not_billed_consistent` CHECK can
// never be violated from here.
describe('LogWriter not-billed rows (zero-cost-unbilled-errors)', () => {
  type Row = {
    cost: number | null;
    billed: boolean;
    status: string;
    inputTokens: number;
    outputTokens: number;
    usageEstimated: boolean;
    inputPriceSnapshot: number | null;
    priceSource: string | null;
    priceVersionId: string | null;
  };
  const estimated = { inputTokens: 54_040, outputTokens: 0, estimated: true } as const;
  const rowOf = (insertMany: jest.Mock, i = 0): Row =>
    (insertMany.mock.calls[0] as [Principal, Row[]])[1][i]!;

  it('writes cost 0 + billed false, and still stores the snapshot, source, tokens and estimate flag', async () => {
    const native = { ...snapshot(), source: 'native_family' as const };
    const { writer, insertMany, resolveForModel } = makeWriter({
      resolveForModel: jest.fn().mockResolvedValue(native),
    });
    writer.enqueue(draft({ status: 'error', billed: false, usage: estimated }));
    await writer.flush();
    // The snapshot is still resolved: it is the rate that WOULD have applied.
    expect(resolveForModel).toHaveBeenCalledTimes(1);
    expect(rowOf(insertMany)).toMatchObject({
      cost: 0,
      billed: false,
      status: 'error',
      inputTokens: 54_040,
      outputTokens: 0,
      usageEstimated: true,
      inputPriceSnapshot: 2.5,
      priceSource: 'native_family',
      priceVersionId: 'v1',
    });
  });

  it('an UNPRICED not-billed draft writes cost 0 (a known zero), not NULL (unknown)', async () => {
    const { writer, insertMany } = makeWriter({
      resolveForModel: jest.fn().mockResolvedValue(null),
    });
    writer.enqueue(draft({ id: 'nb', status: 'error', billed: false, usage: estimated }));
    writer.enqueue(draft({ id: 'b', status: 'error', billed: true, usage: estimated }));
    await writer.flush();
    const rows = (insertMany.mock.calls[0] as [Principal, (Row & { id: string })[]])[1];
    const notBilled = rows.find((r) => r.id === 'nb')!;
    const billed = rows.find((r) => r.id === 'b')!;
    expect(notBilled.cost).toBe(0);
    expect(notBilled.cost).not.toBeNull();
    expect(notBilled.billed).toBe(false);
    expect(notBilled.inputPriceSnapshot).toBeNull();
    expect(notBilled.priceSource).toBeNull();
    // Contrast: an unpriced BILLED row stays unknown (null), exactly as before.
    expect(billed.cost).toBeNull();
    expect(billed.billed).toBe(true);
  });

  it('a billed draft is written with the byte-identical computed cost and billed true', async () => {
    const { writer, insertMany } = makeWriter({});
    const usage = { inputTokens: 1234, outputTokens: 567, estimated: false } as const;
    writer.enqueue(draft({ id: 'ok', status: 'success', billed: true, usage }));
    writer.enqueue(draft({ id: 'err', status: 'error', billed: true, usage: estimated }));
    await writer.flush();
    const rows = (insertMany.mock.calls[0] as [Principal, (Row & { id: string })[]])[1];
    expect(rows.find((r) => r.id === 'ok')).toMatchObject({
      billed: true,
      cost: computeCost(usage, snapshot()),
    });
    // A billed ERROR keeps today's estimate cost (a first-event timeout, say).
    const billedError = rows.find((r) => r.id === 'err')!;
    expect(billedError.billed).toBe(true);
    expect(billedError.cost).toBe(computeCost(estimated, snapshot()));
    expect(billedError.cost).toBeGreaterThan(0);
  });

  it('a cancelled not-billed draft is written not-billed too', async () => {
    const { writer, insertMany } = makeWriter({});
    writer.enqueue(draft({ status: 'cancelled', billed: false, usage: estimated }));
    await writer.flush();
    expect(rowOf(insertMany)).toMatchObject({ cost: 0, billed: false, status: 'cancelled' });
  });

  it('emits a zero to recordCost for a not-billed row and no cost series', async () => {
    const { writer, metrics } = makeWriter({});
    const spy = jest.spyOn(metrics, 'recordCost');
    writer.enqueue(draft({ id: 'nb', status: 'error', billed: false, usage: estimated }));
    writer.enqueue(draft({ id: 'b', status: 'success', billed: true }));
    await writer.flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]).toEqual(['openai', 'gpt-4o', 0]);
    expect(spy.mock.calls[1]![2]).toBeGreaterThan(0); // the billed sibling still counts
    // 75 µ$ for the billed row only — the not-billed row added nothing.
    expect(await metrics.metricsText()).toContain(
      'polyrouter_cost_microusd_total{provider="openai",model="gpt-4o"} 75',
    );
  });

  it.each(['success', 'fallback'] as const)(
    'a malformed draft (billed=false with status %s) degrades to billed with its computed cost',
    async (status) => {
      const { writer, insertMany } = makeWriter({});
      const usage = { inputTokens: 10, outputTokens: 5, estimated: false } as const;
      // A sibling valid row in the same owner group must survive: one bad draft must
      // not fail the group's insert (which is retried and then DROPPED).
      writer.enqueue(draft({ id: 'bad', status, billed: false, usage }));
      writer.enqueue(draft({ id: 'sib', status: 'error', billed: false, usage: estimated }));
      await writer.flush();
      expect(insertMany).toHaveBeenCalledTimes(1);
      const rows = (insertMany.mock.calls[0] as [Principal, (Row & { id: string })[]])[1];
      expect(rows).toHaveLength(2);
      const bad = rows.find((r) => r.id === 'bad')!;
      expect(bad.billed).toBe(true);
      expect(bad.cost).toBe(computeCost(usage, snapshot()));
      expect(bad.cost).toBeGreaterThan(0);
      expect(rows.find((r) => r.id === 'sib')).toMatchObject({ billed: false, cost: 0 });
    },
  );

  it('never writes the marker on the attempt ledger — a superseded cheap call ran', async () => {
    const { writer, attemptInsertMany } = makeWriter({});
    writer.enqueue(draft({ id: 'L1', status: 'error', billed: false, usage: estimated }));
    writer.enqueueAttempt(attemptDraft({ id: 'A1', requestLogId: 'L1' }));
    await writer.flush();
    const [, attemptRows] = attemptInsertMany.mock.calls[0] as [
      unknown,
      (Record<string, unknown> & { cost: number })[],
    ];
    expect('billed' in attemptRows[0]!).toBe(false);
    expect(attemptRows[0]!.cost).toBeGreaterThan(0); // the cheap call keeps its real cost
  });
});
