import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  type PersistencePort,
  type Principal,
  type RequestLogInsertInput,
} from '@polyrouter/shared/server';
import { computeCost, type ResolvedUsage } from '@polyrouter/data-plane';
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
  readonly modelId: string | null;
  readonly tierAssigned: string | null;
  readonly decisionLayer: string;
  readonly routingReason: string;
  readonly durationMs: number;
  readonly status: 'success' | 'error';
  readonly usage: ResolvedUsage;
  readonly pricing: DraftPricing;
}

export interface LogWriterConfig {
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly maxQueue: number;
  readonly maxRetries: number;
  readonly backoffMs: number;
}
export const LOG_WRITER_CONFIG = 'polyrouter:log-writer-config';
export const DEFAULT_LOG_WRITER_CONFIG: LogWriterConfig = {
  intervalMs: 1000,
  batchSize: 100,
  maxQueue: 10_000,
  maxRetries: 3,
  backoffMs: 200,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  private dropped = 0;
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    private readonly pricing: PricingService,
    @Inject(LOG_WRITER_CONFIG) private readonly cfg: LogWriterConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), this.cfg.intervalMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /** Enqueue a draft — O(1), never throws, never awaits the DB. */
  enqueue(draft: RequestLogDraft): void {
    if (this.queue.length >= this.cfg.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(draft);
    if (this.queue.length >= this.cfg.batchSize) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.queue.splice(0, this.queue.length);
      for (const [, drafts] of groupByOwner(batch)) {
        await this.writeGroup(drafts);
      }
    } finally {
      this.flushing = false;
      if (this.dropped > 0) {
        this.logger.warn(`request-log writer dropped ${this.dropped} row(s)`);
        this.dropped = 0;
      }
    }
  }

  /** Resolve prices + insert one principal's rows, with bounded retry wrapping
   * the WHOLE attempt (a pricing lookup can fail during a DB outage too). */
  private async writeGroup(drafts: RequestLogDraft[]): Promise<void> {
    const principal = drafts[0]!.principal;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const rows: RequestLogInsertInput[] = [];
        for (const d of drafts) rows.push(await this.toRow(d)); // sequential → bounded pricing work
        await this.db.requestLogs.insertMany(principal, rows);
        return;
      } catch (err) {
        if (attempt >= this.cfg.maxRetries) {
          this.dropped += drafts.length;
          this.logger.warn(
            `request-log write failed after ${attempt + 1} attempts; dropped ${drafts.length} row(s): ${String(err)}`,
          );
          return;
        }
        await sleep(this.cfg.backoffMs * (attempt + 1));
      }
    }
  }

  private async toRow(d: RequestLogDraft): Promise<RequestLogInsertInput> {
    const price = await this.pricing.resolveForModel(
      {
        externalModelId: d.pricing.externalModelId,
        inputPricePer1m: d.pricing.modelInputPricePer1m,
        outputPricePer1m: d.pricing.modelOutputPricePer1m,
        isFree: d.pricing.modelIsFree,
      },
      d.pricing.providerBaseUrl,
      d.pricing.providerKind,
      d.pricing.at,
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
    };
  }
}

function groupByOwner(batch: RequestLogDraft[]): Map<string, RequestLogDraft[]> {
  const groups = new Map<string, RequestLogDraft[]>();
  for (const d of batch) {
    const key = d.principal.kind === 'user' ? `u:${d.principal.userId}` : `o:${d.principal.orgId}`;
    const group = groups.get(key);
    if (group) group.push(d);
    else groups.set(key, [d]);
  }
  return groups;
}
