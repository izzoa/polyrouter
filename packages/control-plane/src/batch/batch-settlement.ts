import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { computeCost, type BatchItemOutcome, type ResolvedUsage } from '@polyrouter/data-plane';
import {
  PERSISTENCE_PORT,
  userPrincipal,
  type BatchJobRow,
  type PersistencePort,
  type PriceSnapshot,
  type Principal,
  type RequestLogInsertInput,
} from '@polyrouter/shared/server';
import { ProxyMetrics } from '../observability/proxy-metrics';

/** Rows per confirmed insert. Small enough that a crash loses little work,
 * large enough that a 100k-item batch is a few hundred round trips. */
const CHUNK_SIZE = 250;

/**
 * A settled item's identity is `hash(jobId, custom_id)` — derived from the
 * upstream's OWN echo, so a re-run after a crash produces the same ids and the
 * insert-once semantics absorb it. The `custom_id` is hashed, never stored
 * (invariant 8): the digest is one-way and the plaintext never reaches a column.
 */
export function itemRowId(jobId: string, customId: string): string {
  return createHash('sha256').update(jobId).update('|').update(customId).digest('hex').slice(0, 32);
}

/** The job's stored snapshot, read back as a `PriceSnapshot` for the cost math.
 * Copied VERBATIM onto every item row, never re-resolved (D7). */
export function snapshotOf(job: BatchJobRow): PriceSnapshot | null {
  if (job.inputPriceSnapshot === null || job.outputPriceSnapshot === null) return null;
  return {
    priceVersionId: job.priceVersionId,
    modelKey: null,
    inputPricePer1m: job.inputPriceSnapshot,
    outputPricePer1m: job.outputPriceSnapshot,
    cacheReadPricePer1m: job.cacheReadPriceSnapshot,
    cacheWritePricePer1m: job.cacheWritePriceSnapshot,
    isFree: job.inputPriceSnapshot === 0 && job.outputPriceSnapshot === 0,
    source: (job.priceSource ?? 'bundled') as PriceSnapshot['source'],
    validFrom: null,
    mode: 'batch',
  };
}

export interface SettlementOutcome {
  /** Items seen in the result stream, after de-duplication by `custom_id`. */
  readonly seen: number;
  readonly completed: number;
  readonly failed: number;
  /** Sum of every item's immutable cost in micro-USD: `settled_cost_micros`. */
  readonly settledCostMicros: number;
  /** Rows this run actually inserted (a replay reports zero). */
  readonly inserted: number;
}

/**
 * Durable, awaited, chunked settlement (add-batch-inference D9, task 4.3).
 *
 * NOT the asynchronous audit writer: its queue eviction and retry-exhaustion drops
 * are acceptable for a synchronous request's audit row, but these rows carry a
 * batch's ONLY record of cost. Each chunk is inserted owner-scoped and confirmed
 * before the next; the insert reports which ids actually landed, so per-row cost
 * metrics fire once per row across any number of replays.
 */
@Injectable()
export class BatchSettlement {
  private readonly logger = new Logger('BatchSettlement');

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    private readonly metrics: ProxyMetrics,
  ) {}

  /**
   * Consume the job's result stream ONCE and record it. Counts come from the
   * STREAM (not from the insert), so a replay that lands no new rows still
   * reports the job's true totals; `settledAt` fixes the wall-time `duration_ms`
   * every item of one job shares.
   */
  async settle(
    job: BatchJobRow,
    results: AsyncIterable<BatchItemOutcome>,
    settledAt: Date,
    providerName: string,
  ): Promise<SettlementOutcome> {
    const principal: Principal = userPrincipal(job.ownerUserId);
    const snapshot = snapshotOf(job);
    // Missing usage falls back to the job's routing-grade aggregate, divided
    // evenly: a number on the job row, never a body (D9).
    const perItemInput =
      job.itemCount > 0 ? Math.ceil(job.estimatedInputTokens / job.itemCount) : 0;
    const durationMs = Math.max(0, settledAt.getTime() - job.submittedAt.getTime());

    const seen = new Set<string>();
    let completed = 0;
    let failed = 0;
    let costMicros = 0;
    let inserted = 0;
    let pending: RequestLogInsertInput[] = [];

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const chunk = pending;
      pending = [];
      const { insertedIds } = await this.db.requestLogs.insertManyReturning(principal, chunk);
      inserted += insertedIds.length;
      // Cost metrics ride the LANDED rows only, so a replay cannot double-count.
      const landed = new Set(insertedIds);
      for (const row of chunk) {
        if (!landed.has(row.id)) continue;
        this.metrics.recordBatchItem(providerName, row.status);
        this.metrics.recordCost(providerName, 'batch', row.cost ?? null);
      }
    };

    for await (const outcome of results) {
      // An upstream that yields a `custom_id` twice must neither double-count nor
      // trip `completed + failed <= item_count` and strand the job in `finalizing`.
      if (seen.has(outcome.customId)) continue;
      seen.add(outcome.customId);
      const usage: ResolvedUsage = outcome.ok
        ? usageOf(outcome, perItemInput)
        : { inputTokens: perItemInput, outputTokens: 0, estimated: true };
      const cost = computeCost(usage, snapshot);
      if (outcome.ok) completed += 1;
      else failed += 1;
      if (cost !== null) costMicros += Math.round(cost * 1_000_000);
      pending.push({
        id: itemRowId(job.id, outcome.customId),
        agentId: job.agentId,
        providerId: job.providerId,
        modelId: job.modelId,
        tierAssigned: job.tierAssigned,
        // A batch is never produced by `auto` (D3/D12): the decision is explicit,
        // and the recorded reason carries the fixed ` batch` fragment.
        decisionLayer: 'explicit',
        routingReason: reasonFor(job),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        inputPriceSnapshot: job.inputPriceSnapshot,
        outputPriceSnapshot: job.outputPriceSnapshot,
        cacheReadPriceSnapshot: job.cacheReadPriceSnapshot,
        cacheWritePriceSnapshot: job.cacheWritePriceSnapshot,
        priceVersionId: job.priceVersionId,
        priceSource: job.priceSource,
        priceMode: 'batch',
        batchId: job.id,
        providerKind: job.providerKind,
        usageEstimated: usage.estimated,
        cost,
        // The time the CALLER actually waited: the job's wall time. Latency
        // aggregates exclude batch rows precisely because of this (D10).
        durationMs,
        status: outcome.ok ? 'success' : 'error',
        ...(outcome.ok ? {} : { errorKind: outcome.kind, errorStatus: outcome.statusCode ?? null }),
        escalated: false,
      });
      if (pending.length >= CHUNK_SIZE) await flush();
    }
    await flush();
    if (inserted > 0) {
      this.logger.log(`batch ${job.id}: settled ${String(inserted)} new item row(s)`);
    }
    return { seen: seen.size, completed, failed, settledCostMicros: costMicros, inserted };
  }
}

/** The recorded decision, with the fixed ` batch` fragment appended. */
function reasonFor(job: BatchJobRow): string {
  const base = job.tierAssigned === null ? 'explicit model' : `explicit tier ${job.tierAssigned}`;
  return `${base} batch`;
}

/** A successful item's usage, with the job's aggregate estimate standing in when
 * the upstream reported none (flagged `usage_estimated`, never a silent zero). */
function usageOf(outcome: BatchItemOutcome & { ok: true }, perItemInput: number): ResolvedUsage {
  const u = outcome.response.usage;
  if (u === undefined) {
    return { inputTokens: perItemInput, outputTokens: 0, estimated: true };
  }
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
    estimated: false,
  };
}
