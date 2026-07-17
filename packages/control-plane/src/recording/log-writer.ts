import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Link,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import {
  PERSISTENCE_PORT,
  type PersistencePort,
  type Principal,
  type RequestAttemptInsertInput,
  type RequestLogInsertInput,
} from '@polyrouter/shared/server';
import { computeCost, type ResolvedUsage } from '@polyrouter/data-plane';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { TRACER_NAME } from '../observability/tracing';
import { PricingService } from '../pricing/pricing.service';

/** Pricing inputs captured at request-completion time, resolved later in the
 * writer against the effective-dated catalog at `at` (so cost stays immutable). */
export interface DraftPricing {
  readonly externalModelId: string;
  readonly modelInputPricePer1m: number | null;
  readonly modelOutputPricePer1m: number | null;
  readonly modelIsFree: boolean;
  readonly providerBaseUrl: string | null;
  readonly providerKind: string;
  readonly at: Date;
}

/** A metadata-only request-log job. `id` is pre-allocated so a retry is
 * idempotent; the owner is the `principal` (forced at insert, not client input). */
export interface RequestLogDraft {
  readonly id: string;
  readonly principal: Principal;
  readonly agentId: string | null;
  readonly providerId: string | null;
  /** Provider display name — #21 metric label only, never persisted. */
  readonly providerName: string;
  readonly modelId: string | null;
  readonly tierAssigned: string | null;
  readonly decisionLayer: string;
  readonly routingReason: string;
  readonly durationMs: number;
  readonly status: 'success' | 'error' | 'fallback';
  readonly usage: ResolvedUsage;
  readonly pricing: DraftPricing;
  /** #14 cascade: whether the request escalated cheap→strong. */
  readonly escalated?: boolean;
  /** #14 cascade: the numeric quality score (or null on a fail-open error). */
  readonly qualitySignal?: number | null;
  /** The originating request's span context (#21 `recording.write` link);
   * absent when tracing is off. Never persisted. */
  readonly spanContext?: SpanContext;
}

/** A per-billable-call ledger job (#14 cascade) — the superseded cheap attempt.
 * `requestLogId` links it to its request's served `request_log` row. */
export interface RequestAttemptDraft {
  readonly id: string;
  readonly requestLogId: string;
  readonly principal: Principal;
  readonly attemptIndex: number;
  readonly tierKey: string | null;
  readonly providerId: string | null;
  /** Provider display name — #21 metric label only, never persisted. */
  readonly providerName: string;
  readonly modelId: string | null;
  readonly status: 'success' | 'error' | 'fallback';
  readonly usage: ResolvedUsage;
  readonly pricing: DraftPricing;
  /** The originating request's span context (#21); never persisted. */
  readonly spanContext?: SpanContext;
}

export interface LogWriterConfig {
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly maxQueue: number;
  readonly maxRetries: number;
  readonly backoffMs: number;
  /** Per-batch DB deadline (price lookup + insert). Bounds the shutdown drain so a
   * hung database cannot leave it (and the drop accounting) blocked forever. */
  readonly opTimeoutMs: number;
}
export const LOG_WRITER_CONFIG = 'polyrouter:log-writer-config';
export const DEFAULT_LOG_WRITER_CONFIG: LogWriterConfig = {
  intervalMs: 1000,
  batchSize: 100,
  maxQueue: 10_000,
  maxRetries: 3,
  backoffMs: 200,
  opTimeoutMs: 5000,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reject after `ms` if `op` hasn't settled. The underlying DB call keeps running
 * (no driver AbortSignal); a retry reuses the same idempotent row ids, so a late
 * commit is conflict-ignored, not double-counted. */
async function withTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(ms)}ms`)), ms);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Off-request-path, batched, failure-isolated request-log writer (#11, spec
 * §3.2.4; invariant 9). `enqueue` is O(1) and never throws. Flush resolves the
 * price snapshot + cost per draft, then batch-inserts PER PRINCIPAL with bounded
 * retry (so a transient DB failure doesn't create gaps and a deleted owner can't
 * poison another tenant). Best-effort durability: overflow / past-budget drops
 * are counted and logged, never silent.
 */
@Injectable()
export class LogWriter implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LogWriter.name);
  private readonly queue: RequestLogDraft[] = [];
  private readonly attemptQueue: RequestAttemptDraft[] = [];
  private dropped = 0;
  private flushing = false;
  private flushPromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    private readonly pricing: PricingService,
    @Inject(LOG_WRITER_CONFIG) private readonly cfg: LogWriterConfig,
    private readonly metrics: ProxyMetrics,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), this.cfg.intervalMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.drain();
  }

  /** Enqueue a draft — O(1), never throws, never awaits the DB. */
  enqueue(draft: RequestLogDraft): void {
    if (this.queue.length >= this.cfg.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
      this.metrics.logRowsDroppedBy(1);
    }
    this.queue.push(draft);
    if (this.queue.length >= this.cfg.batchSize) void this.flush();
  }

  /** Flush a batch. If a flush is already in flight, COALESCE onto it (await it)
   * rather than early-returning — so a shutdown flush racing a periodic one never
   * abandons the drafts enqueued after that flush's splice (E5.1). */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushPromise;
      return;
    }
    if (this.queue.length === 0 && this.attemptQueue.length === 0) return;
    this.flushing = true;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushing = false;
      if (this.dropped > 0) {
        this.logger.warn(`request-log writer dropped ${this.dropped} row(s)`);
        this.dropped = 0;
      }
    });
    await this.flushPromise;
  }

  /** Drain both queues to completion — used on shutdown. Bounded by the per-op
   * timeout × retry budget (a hung DB times out and its rows are counted-as-
   * dropped), so it always terminates before the drop accounting is complete. */
  private async drain(): Promise<void> {
    while (this.flushing || this.queue.length > 0 || this.attemptQueue.length > 0) {
      await this.flush();
    }
  }

  private async flushOnce(): Promise<void> {
    // Snapshot BOTH queues before any await: a cascade log and its attempt
    // enqueued during a write must land in the SAME cycle, or the child attempt's
    // FK to its not-yet-written parent fails and the row is avoidably dropped.
    const batch = this.queue.splice(0, this.queue.length);
    const attempts = this.attemptQueue.splice(0, this.attemptQueue.length);
    for (const [, drafts] of groupByOwner(batch)) {
      await this.writeGroup(drafts);
    }
    // Attempt ledger AFTER the logs (FK: request_attempt.request_log_id → request_log.id).
    for (const [, drafts] of groupByOwner(attempts)) {
      await this.writeAttemptGroup(drafts);
    }
  }

  /** Resolve prices + insert one principal's rows, with bounded retry wrapping
   * the WHOLE attempt (a pricing lookup can fail during a DB outage too). The
   * batch runs under a `recording.write` span LINKED to the originating request
   * spans (#21 — the spec's traced "DB write"); the cost counters are emitted
   * exactly once per row, only after ITS batch insert succeeded (a retry
   * rebuilds rows but must never re-emit; a dropped row emits no cost). */
  private async writeGroup(drafts: RequestLogDraft[]): Promise<void> {
    const principal = drafts[0]!.principal;
    const span = writeSpan(drafts);
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const rows: RequestLogInsertInput[] = [];
          for (const d of drafts) rows.push(await this.toRow(d)); // each price lookup is per-op bounded
          await withTimeout(
            this.db.requestLogs.insertMany(principal, rows),
            this.cfg.opTimeoutMs,
            'request-log insert',
          );
          rows.forEach((row, i) => {
            const d = drafts[i]!;
            this.metrics.recordCost(d.providerName, d.pricing.externalModelId, row.cost ?? null);
          });
          return;
        } catch (err) {
          if (attempt >= this.cfg.maxRetries) {
            this.dropped += drafts.length;
            this.metrics.logRowsDroppedBy(drafts.length);
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute('polyrouter.dropped', drafts.length);
            this.logger.warn(
              `request-log write failed after ${attempt + 1} attempts; dropped ${drafts.length} row(s): ${String(err)}`,
            );
            return;
          }
          await sleep(this.cfg.backoffMs * (attempt + 1));
        }
      }
    } finally {
      span.end();
    }
  }

  private async toRow(d: RequestLogDraft): Promise<RequestLogInsertInput> {
    const price = await withTimeout(
      this.pricing.resolveForModel(
        {
          externalModelId: d.pricing.externalModelId,
          inputPricePer1m: d.pricing.modelInputPricePer1m,
          outputPricePer1m: d.pricing.modelOutputPricePer1m,
          isFree: d.pricing.modelIsFree,
        },
        d.pricing.providerBaseUrl,
        d.pricing.providerKind,
        d.pricing.at,
      ),
      this.cfg.opTimeoutMs,
      'price lookup',
    );
    return {
      id: d.id,
      agentId: d.agentId,
      providerId: d.providerId,
      modelId: d.modelId,
      tierAssigned: d.tierAssigned,
      decisionLayer: d.decisionLayer,
      routingReason: d.routingReason,
      inputTokens: d.usage.inputTokens,
      outputTokens: d.usage.outputTokens,
      cacheReadTokens: d.usage.cacheReadTokens ?? null,
      cacheWriteTokens: d.usage.cacheWriteTokens ?? null,
      inputPriceSnapshot: price?.inputPricePer1m ?? null,
      outputPriceSnapshot: price?.outputPricePer1m ?? null,
      cacheReadPriceSnapshot: price?.cacheReadPricePer1m ?? null,
      cacheWritePriceSnapshot: price?.cacheWritePricePer1m ?? null,
      priceVersionId: price?.priceVersionId ?? null,
      usageEstimated: d.usage.estimated,
      cost: computeCost(d.usage, price),
      durationMs: d.durationMs,
      status: d.status,
      escalated: d.escalated ?? false,
      qualitySignal: d.qualitySignal ?? null,
    };
  }

  /** Enqueue a per-attempt ledger row (#14) — O(1), never throws. */
  enqueueAttempt(draft: RequestAttemptDraft): void {
    if (this.attemptQueue.length >= this.cfg.maxQueue) {
      this.attemptQueue.shift();
      this.dropped += 1;
      this.metrics.logRowsDroppedBy(1);
    }
    this.attemptQueue.push(draft);
  }

  /** Resolve prices + insert one principal's attempt ledger rows (bounded retry;
   * same #21 persistence-span + exactly-once cost discipline as `writeGroup`). */
  private async writeAttemptGroup(drafts: RequestAttemptDraft[]): Promise<void> {
    const principal = drafts[0]!.principal;
    const span = writeSpan(drafts);
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const rows: RequestAttemptInsertInput[] = [];
          for (const d of drafts) rows.push(await this.toAttemptRow(d)); // per-op bounded price lookup
          await withTimeout(
            this.db.requestAttempts.insertMany(principal, rows),
            this.cfg.opTimeoutMs,
            'request-attempt insert',
          );
          rows.forEach((row, i) => {
            const d = drafts[i]!;
            this.metrics.recordCost(d.providerName, d.pricing.externalModelId, row.cost ?? null);
          });
          return;
        } catch (err) {
          if (attempt >= this.cfg.maxRetries) {
            this.dropped += drafts.length;
            this.metrics.logRowsDroppedBy(drafts.length);
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute('polyrouter.dropped', drafts.length);
            this.logger.warn(
              `request-attempt write failed after ${attempt + 1} attempts; dropped ${drafts.length} row(s): ${String(err)}`,
            );
            return;
          }
          await sleep(this.cfg.backoffMs * (attempt + 1));
        }
      }
    } finally {
      span.end();
    }
  }

  private async toAttemptRow(d: RequestAttemptDraft): Promise<RequestAttemptInsertInput> {
    const price = await withTimeout(
      this.pricing.resolveForModel(
        {
          externalModelId: d.pricing.externalModelId,
          inputPricePer1m: d.pricing.modelInputPricePer1m,
          outputPricePer1m: d.pricing.modelOutputPricePer1m,
          isFree: d.pricing.modelIsFree,
        },
        d.pricing.providerBaseUrl,
        d.pricing.providerKind,
        d.pricing.at,
      ),
      this.cfg.opTimeoutMs,
      'price lookup',
    );
    return {
      id: d.id,
      requestLogId: d.requestLogId,
      attemptIndex: d.attemptIndex,
      tierKey: d.tierKey,
      providerId: d.providerId,
      modelId: d.modelId,
      inputTokens: d.usage.inputTokens,
      outputTokens: d.usage.outputTokens,
      cacheReadTokens: d.usage.cacheReadTokens ?? null,
      cacheWriteTokens: d.usage.cacheWriteTokens ?? null,
      inputPriceSnapshot: price?.inputPricePer1m ?? null,
      outputPriceSnapshot: price?.outputPricePer1m ?? null,
      cacheReadPriceSnapshot: price?.cacheReadPricePer1m ?? null,
      cacheWritePriceSnapshot: price?.cacheWritePricePer1m ?? null,
      priceVersionId: price?.priceVersionId ?? null,
      usageEstimated: d.usage.estimated,
      cost: computeCost(d.usage, price),
      status: d.status,
    };
  }
}

/** The #21 `recording.write` batch span: one per persist group, LINKED to each
 * draft's originating request span (one batch serves many requests — links,
 * not parenting). Started under ROOT_CONTEXT explicitly: a threshold-triggered
 * flush runs synchronously inside SOME request's ALS context, and the batch
 * must never become a child of that arbitrary request. A no-op when tracing is
 * off (no valid contexts collected). */
function writeSpan(drafts: readonly { readonly spanContext?: SpanContext }[]): Span {
  const links: Link[] = [];
  for (const d of drafts) {
    if (d.spanContext !== undefined) links.push({ context: d.spanContext });
  }
  return trace
    .getTracer(TRACER_NAME)
    .startSpan(
      'recording.write',
      { links, attributes: { 'polyrouter.rows': drafts.length } },
      ROOT_CONTEXT,
    );
}

function groupByOwner<T extends { readonly principal: Principal }>(batch: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const d of batch) {
    const key = d.principal.kind === 'user' ? `u:${d.principal.userId}` : `o:${d.principal.orgId}`;
    const group = groups.get(key);
    if (group) group.push(d);
    else groups.set(key, [d]);
  }
  return groups;
}
