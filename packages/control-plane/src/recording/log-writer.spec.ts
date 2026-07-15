import { randomUUID } from 'node:crypto';
import type { PersistencePort, PriceSnapshot, Principal } from '@polyrouter/shared/server';
import { userPrincipal } from '@polyrouter/shared/server';
import type { PricingService } from '../pricing/pricing.service';
import { LogWriter, type LogWriterConfig, type RequestLogDraft } from './log-writer';

const CONFIG: LogWriterConfig = {
  intervalMs: 1_000_000, // never auto-fire in tests
  batchSize: 1_000_000,
  maxQueue: 3,
  maxRetries: 2,
  backoffMs: 1,
};

function draft(over: Partial<RequestLogDraft> = {}): RequestLogDraft {
  return {
    id: over.id ?? randomUUID(),
    principal: over.principal ?? userPrincipal('u1'),
    agentId: 'a1',
    providerId: 'p1',
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

function makeWriter(overrides: { insertMany?: jest.Mock; resolveForModel?: jest.Mock }): {
  writer: LogWriter;
  insertMany: jest.Mock;
  resolveForModel: jest.Mock;
} {
  const insertMany = overrides.insertMany ?? jest.fn().mockResolvedValue(undefined);
  const resolveForModel = overrides.resolveForModel ?? jest.fn().mockResolvedValue(snapshot());
  const db = { requestLogs: { insertMany } } as unknown as PersistencePort;
  const pricing = { resolveForModel } as unknown as PricingService;
  return { writer: new LogWriter(db, pricing, CONFIG), insertMany, resolveForModel };
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
});
