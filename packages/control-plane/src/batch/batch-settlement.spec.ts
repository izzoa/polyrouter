import { computeCost, type BatchItemOutcome } from '@polyrouter/data-plane';
import type {
  BatchJobRow,
  PersistencePort,
  RequestLogInsertInput,
} from '@polyrouter/shared/server';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { BatchSettlement, itemRowId, snapshotOf } from './batch-settlement';

// zero-cost-unbilled-errors: every batch item row is written BILLED, explicitly —
// a new row is never NULL — and a failed item's cost is exactly what it was before
// (the job's per-item input estimate at the batch snapshot). Zero-costing failed
// batch items is a separate follow-up (proposal non-goals).

const job = {
  id: 'job-1',
  ownerUserId: 'u1',
  agentId: 'a1',
  providerId: 'p1',
  modelId: 'm1',
  tierAssigned: null,
  providerKind: 'api_key',
  itemCount: 4,
  estimatedInputTokens: 4000, // 1000 per item
  inputPriceSnapshot: 1,
  outputPriceSnapshot: 2,
  cacheReadPriceSnapshot: null,
  cacheWritePriceSnapshot: null,
  priceVersionId: 'v1',
  priceSource: 'bundled',
  submittedAt: new Date('2026-10-28T00:00:00Z'),
} as unknown as BatchJobRow;

const okResponse = (usage?: { inputTokens: number; outputTokens: number }) =>
  ({
    id: 'r',
    model: 'm',
    content: [],
    stopReason: 'stop',
    ...(usage !== undefined ? { usage } : {}),
  }) as const;

async function* stream(items: BatchItemOutcome[]): AsyncIterable<BatchItemOutcome> {
  for (const i of items) yield await Promise.resolve(i);
}

function make(): { settlement: BatchSettlement; rows: RequestLogInsertInput[] } {
  const rows: RequestLogInsertInput[] = [];
  const db = {
    requestLogs: {
      insertManyReturning: jest.fn((_p: unknown, chunk: RequestLogInsertInput[]) => {
        rows.push(...chunk);
        return Promise.resolve({ insertedIds: chunk.map((r) => r.id) });
      }),
    },
  } as unknown as PersistencePort;
  return { settlement: new BatchSettlement(db, new ProxyMetrics()), rows };
}

describe('BatchSettlement billed marker (zero-cost-unbilled-errors)', () => {
  it('writes billed=true on completed AND failed items, with costs unchanged', async () => {
    const { settlement, rows } = make();
    const outcomes: BatchItemOutcome[] = [
      // reported usage
      {
        customId: 'a',
        ok: true,
        statusCode: 200,
        response: okResponse({ inputTokens: 300, outputTokens: 100 }),
      },
      // no usage: falls back to the per-item estimate (flagged), still billed
      { customId: 'b', ok: true, statusCode: 200, response: okResponse() },
      // failed with a status
      { customId: 'c', ok: false, statusCode: 429, kind: 'rate_limit' },
      // failed with no status (the index-last member: not only the first row is checked)
      { customId: 'd', ok: false, statusCode: null, kind: 'unavailable' },
    ];
    const out = await settlement.settle(
      job,
      stream(outcomes),
      new Date('2026-10-28T00:10:00Z'),
      'p',
    );
    expect(out).toMatchObject({ seen: 4, completed: 2, failed: 2, inserted: 4 });
    expect(rows).toHaveLength(4);

    const byId = new Map(rows.map((r) => [r.id, r]));
    const snap = snapshotOf(job);
    const row = (customId: string): RequestLogInsertInput => byId.get(itemRowId(job.id, customId))!;

    for (const r of rows) expect(r.billed).toBe(true); // never undefined / null / false

    // Costs exactly as before this change.
    expect(row('a').cost).toBe(
      computeCost({ inputTokens: 300, outputTokens: 100, estimated: false }, snap),
    );
    const estimate = { inputTokens: 1000, outputTokens: 0, estimated: true } as const;
    expect(row('b').cost).toBe(computeCost(estimate, snap));
    expect(row('c')).toMatchObject({ status: 'error', usageEstimated: true, inputTokens: 1000 });
    expect(row('c').cost).toBe(computeCost(estimate, snap));
    expect(row('c').cost).toBeGreaterThan(0); // a failed item is NOT zero-costed here
    expect(row('d').cost).toBe(computeCost(estimate, snap));
    expect(row('d').billed).toBe(true);
    // Settled cost is still the sum of the rows' costs.
    expect(out.settledCostMicros).toBe(
      rows.reduce((acc, r) => acc + Math.round((r.cost ?? 0) * 1_000_000), 0),
    );
  });
});
