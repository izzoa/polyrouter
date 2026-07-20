import { randomUUID } from 'node:crypto';
import type { PersistencePort, PriceSnapshot, Principal } from '@polyrouter/shared/server';
import { userPrincipal } from '@polyrouter/shared/server';
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
    usage: { inputTokens: 10, outputTokens: 5, estimated: false },
    pricing: {
      externalModelId: 'gpt-4o',
      modelInputPricePer1m: null,
      modelOutputPricePer1m: null,
      modelIsFree: false,
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
  } as unknown as PersistencePort;
  const pricing = { resolveForModel } as unknown as PricingService;
  const metrics = new ProxyMetrics();
  return {
    writer: new LogWriter(db, pricing, { ...CONFIG, ...overrides.config }, metrics),
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
