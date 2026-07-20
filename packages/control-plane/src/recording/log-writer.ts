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
  encryptSecret,
  type PersistencePort,
  type Principal,
  type RequestBodyInsertItem,
  type RequestLogInsertInput,
  type RequestAttemptInsertInput,
} from '@polyrouter/shared/server';
import {
  computeCost,
  sanitizeRequestId,
  scrubSecrets,
  type ResolvedUsage,
} from '@polyrouter/data-plane';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { TRACER_NAME } from '../observability/tracing';
import { BODY_CAPTURE_CONFIG, type BodyCaptureConfig } from '../body-capture/body-capture.config';
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

/** One captured body direction (add-body-capture) — PLAINTEXT held only in
 * writer memory under the byte budget; encrypted at flush, never logged. */
export interface CapturedBodyDraft {
  readonly direction: 'request' | 'response';
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly partial: boolean;
  readonly epoch: number;
  readonly capturedAt: Date;
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
  /** The header that chose the route (add-routing-header-visibility) — grouped
   * pair, split into the two columns only at the row mapping; absent ⇒ nulls. */
  readonly routingHeader?: { readonly name: string; readonly value: string | null };
  readonly durationMs: number;
  readonly status: 'success' | 'error' | 'fallback' | 'cancelled';
  readonly usage: ResolvedUsage;
  readonly pricing: DraftPricing;
  /** L1 decision telemetry (add-auto-decision-telemetry); absent = null columns. */
  readonly structuralBand?: string;
  readonly structuralScore?: number;
  readonly structuralBandSource?: string;
  /** Decision-time calibration epoch (add-auto-threshold-calibration). */
  readonly structuralEpoch?: number;
  /** #14 cascade: whether the request escalated cheap→strong. */
  readonly escalated?: boolean;
  /** #14 cascade: the numeric quality score (or null on a fail-open error). */
  readonly qualitySignal?: number | null;
  /** Escalation provenance (add-auto-threshold-calibration); only on escalated drafts. */
  readonly escalationSource?: 'quality_gate' | 'cheap_error';
  /** Terminal provider-error detail (add-request-error-detail) — present only
   * on `status='error'` drafts (the recorder enforces exclusivity). The message
   * arrives factory-sanitized; the writer re-applies the CREDENTIAL-FREE scrub
   * defensively (no secret is ever queued to enable more). */
  readonly error?: {
    readonly kind: string;
    readonly status?: number;
    readonly providerMessage?: string;
    readonly requestId?: string;
  };
  /** The originating request's span context (#21 `recording.write` link);
   * absent when tracing is off. Never persisted. */
  readonly spanContext?: SpanContext;
  /** Captured bodies (add-body-capture) riding their PARENT draft — flushed
   * only after the log row lands (parent-first by construction; a failed or
   * evicted parent takes its bodies with it, never orphans). MUTABLE seam:
   * queue-budget eviction strips this field (drops counted). */
  bodies?: readonly CapturedBodyDraft[];
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
  readonly status: 'success' | 'error' | 'fallback' | 'cancelled';
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

/** Retained plaintext bytes of a draft's bodies (the byte-ledger unit). */
const bodyBytesOf = (bodies: readonly CapturedBodyDraft[]): number =>
  bodies.reduce((n, b) => n + Buffer.byteLength(b.content, 'utf8'), 0);

/** Map a draft's terminal-error detail to the four columns. Defense in depth is
 * CREDENTIAL-FREE (add-request-error-detail): the capture layer already ran the
 * exact-credential redaction (no secret is queued), so the writer re-applies
 * only the idempotent generic scrub + cap + request-id allowlist. */
function errorColumns(d: { readonly error?: RequestLogDraft['error'] }): {
  errorKind?: string;
  errorStatus?: number;
  errorMessage?: string;
  errorRequestId?: string;
} {
  const e = d.error;
  if (e === undefined) return {};
  const message =
    e.providerMessage !== undefined ? scrubSecrets(e.providerMessage).slice(0, 300) : undefined;
  const requestId = sanitizeRequestId(e.requestId);
  return {
    errorKind: e.kind,
    ...(e.status !== undefined ? { errorStatus: e.status } : {}),
    ...(message !== undefined && message !== '' ? { errorMessage: message } : {}),
    ...(requestId !== undefined ? { errorRequestId: requestId } : {}),
  };
}

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
  /** Total PLAINTEXT bytes of queued body drafts (add-body-capture, D5) — the
   * body queue is bounded by BYTES, not draft count (a count bound alone
   * admits GiB at cap-sized bodies). */
  private bodyBytesQueued = 0;
  /** Per-owner body drops awaiting best-effort persistence (visible counter). */
  private readonly bodyDrops = new Map<string, { principal: Principal; n: number }>();

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    private readonly pricing: PricingService,
    @Inject(LOG_WRITER_CONFIG) private readonly cfg: LogWriterConfig,
    private readonly metrics: ProxyMetrics,
    @Inject(BODY_CAPTURE_CONFIG) private readonly bodyCfg: BodyCaptureConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), this.cfg.intervalMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.drain();
  }

  /** Enqueue a draft — O(1) amortized, never throws, never awaits the DB. */
  enqueue(draft: RequestLogDraft): void {
    if (this.queue.length >= this.cfg.maxQueue) {
      const evicted = this.queue.shift();
      // Its bodies leave the ledger AND the visible drop counter (impl-Med-4).
      if (evicted) this.stripBodies(evicted, true);
      this.dropped += 1;
      this.metrics.logRowsDroppedBy(1);
    }
    // Byte-budgeted body admission (D5): evict OLDEST queued bodies until the
    // new draft's bodies fit; a single over-budget payload drops its own
    // bodies. The LOG ROW is never evicted for body pressure.
    if (draft.bodies !== undefined) {
      const incoming = bodyBytesOf(draft.bodies);
      if (incoming > this.bodyCfg.queueBudgetBytes) {
        this.countBodyDrop(draft.principal, draft.bodies.length);
        delete draft.bodies;
      } else {
        for (const queued of this.queue) {
          if (this.bodyBytesQueued + incoming <= this.bodyCfg.queueBudgetBytes) break;
          this.stripBodies(queued, true);
        }
        if (this.bodyBytesQueued + incoming > this.bodyCfg.queueBudgetBytes) {
          // Nothing left to evict (an in-flight flush holds the spliced batch's
          // bytes) — the NEW bodies drop rather than busting the budget
          // (impl-confirm-Med-a: the bound is a bound, not a suggestion).
          this.countBodyDrop(draft.principal, draft.bodies.length);
          delete draft.bodies;
        } else {
          this.bodyBytesQueued += incoming;
        }
      }
    }
    this.queue.push(draft);
    // Defer the threshold flush to a microtask: a cascade served-log and its attempt(s)
    // are enqueued back-to-back in the SAME synchronous tick (record() then
    // recordAttempt()). A synchronous flush here would splice the log queue mid-tick —
    // BEFORE the sibling attempt is enqueued — stranding that valid attempt in the next
    // cycle where its now-durable parent is absent from `writtenLogIds` and it would be
    // wrongly dropped as orphaned (A-14). The microtask runs after the tick completes,
    // so parent + attempts always flush in one cycle.
    if (this.queue.length >= this.cfg.batchSize) queueMicrotask(() => void this.flush());
  }

  /** Flush a batch. If a flush is already in flight, COALESCE onto it (await it)
   * rather than early-returning — so a shutdown flush racing a periodic one never
   * abandons the drafts enqueued after that flush's splice (E5.1). */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushPromise;
      return;
    }
    if (this.queue.length === 0 && this.attemptQueue.length === 0 && this.bodyDrops.size === 0)
      return;
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
    // Pending drop counts get ONE bounded shutdown attempt (impl-Med-4) — a
    // dead DB forfeits the counter update, never the shutdown.
    if (this.bodyDrops.size > 0) await this.flushBodyDropCounts();
  }

  private async flushOnce(): Promise<void> {
    // Snapshot BOTH queues before any await: a cascade log and its attempt
    // enqueued during a write must land in the SAME cycle, or the child attempt's
    // FK to its not-yet-written parent fails and the row is avoidably dropped.
    const batch = this.queue.splice(0, this.queue.length);
    const attempts = this.attemptQueue.splice(0, this.attemptQueue.length);
    const writtenLogIds = new Set<string>();
    for (const [, drafts] of groupByOwner(batch)) {
      await this.writeGroup(drafts, writtenLogIds);
    }
    // Attempt ledger AFTER the logs (FK: request_attempt.request_log_id → request_log.id).
    // Drop any attempt whose parent log was NOT written this cycle (its group's insert
    // gave up, or the parent draft was queue-evicted): it can't be inserted regardless,
    // and left in the batch its FK violation would fail the whole per-owner attempt
    // insert — dropping valid sibling rows whose parents WERE written (A-14). A served
    // log and its attempts enqueue in the same tick, so a non-orphan's parent is here.
    const insertable: RequestAttemptDraft[] = [];
    let orphaned = 0;
    for (const a of attempts) {
      if (writtenLogIds.has(a.requestLogId)) insertable.push(a);
      else orphaned += 1;
    }
    if (orphaned > 0) {
      this.dropped += orphaned;
      this.metrics.logRowsDroppedBy(orphaned);
      this.logger.warn(
        `dropped ${orphaned} orphaned attempt row(s): parent request_log not written this cycle`,
      );
    }
    for (const [, drafts] of groupByOwner(insertable)) {
      await this.writeAttemptGroup(drafts);
    }
    await this.flushBodyDropCounts();
  }

  /** Resolve prices + insert one principal's rows, with bounded retry wrapping
   * the WHOLE attempt (a pricing lookup can fail during a DB outage too). The
   * batch runs under a `recording.write` span LINKED to the originating request
   * spans (#21 — the spec's traced "DB write"); the cost counters are emitted
   * exactly once per row, only after ITS batch insert succeeded (a retry
   * rebuilds rows but must never re-emit; a dropped row emits no cost). */
  private async writeGroup(drafts: RequestLogDraft[], writtenLogIds: Set<string>): Promise<void> {
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
            writtenLogIds.add(row.id); // parent is now durable → its attempts may insert (A-14)
            this.metrics.recordCost(d.providerName, d.pricing.externalModelId, row.cost ?? null);
          });
          // Bodies flush ONLY after their parent rows landed (parent-first,
          // add-body-capture); a body failure never re-runs the log insert.
          await this.flushBodies(principal, drafts);
          return;
        } catch (err) {
          if (attempt >= this.cfg.maxRetries) {
            this.dropped += drafts.length;
            this.metrics.logRowsDroppedBy(drafts.length);
            // A dropped parent takes its bodies with it (counted, off the ledger).
            for (const d of drafts) this.stripBodies(d, true);
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
      routingHeaderName: d.routingHeader?.name ?? null,
      routingHeaderValue: d.routingHeader?.value ?? null,
      inputTokens: d.usage.inputTokens,
      outputTokens: d.usage.outputTokens,
      cacheReadTokens: d.usage.cacheReadTokens ?? null,
      cacheWriteTokens: d.usage.cacheWriteTokens ?? null,
      inputPriceSnapshot: price?.inputPricePer1m ?? null,
      outputPriceSnapshot: price?.outputPricePer1m ?? null,
      cacheReadPriceSnapshot: price?.cacheReadPricePer1m ?? null,
      cacheWritePriceSnapshot: price?.cacheWritePricePer1m ?? null,
      priceVersionId: price?.priceVersionId ?? null,
      priceSource: price?.source ?? null,
      usageEstimated: d.usage.estimated,
      cost: computeCost(d.usage, price),
      durationMs: d.durationMs,
      status: d.status,
      escalated: d.escalated ?? false,
      qualitySignal: d.qualitySignal ?? null,
      escalationSource: d.escalationSource ?? null,
      structuralBand: d.structuralBand ?? null,
      structuralScore: d.structuralScore ?? null,
      structuralBandSource: d.structuralBandSource ?? null,
      structuralEpoch: d.structuralEpoch ?? null,
      ...errorColumns(d),
    };
  }

  /** Strip a queued draft's bodies (byte-budget eviction / queue eviction);
   * `count` marks it a visible body drop. */
  private stripBodies(draft: RequestLogDraft, count = false): void {
    if (draft.bodies === undefined) return;
    this.bodyBytesQueued -= bodyBytesOf(draft.bodies);
    if (count) this.countBodyDrop(draft.principal, draft.bodies.length);
    delete draft.bodies;
  }

  private countBodyDrop(principal: Principal, n: number): void {
    if (n <= 0) return;
    const key = principal.kind === 'user' ? `u:${principal.userId}` : `o:${principal.orgId}`;
    const cur = this.bodyDrops.get(key);
    if (cur) {
      cur.n += n;
    } else if (this.bodyDrops.size < 512) {
      this.bodyDrops.set(key, { principal, n });
    } else {
      // Bounded map (impl-Med-4): past the cap the count is forfeited to the
      // log rather than growing memory during a prolonged DB outage.
      this.logger.warn(`body-drop counter overflow: forfeited ${String(n)} drop(s)`);
    }
  }

  /** Encrypt + guarded-insert the batch's bodies, chunked by the batch byte
   * budget. NEVER throws (a throw would re-run the parent log insert); every
   * failure or guard-discard lands in the visible drop counter instead. */
  private async flushBodies(principal: Principal, drafts: RequestLogDraft[]): Promise<void> {
    const withBodies = drafts.filter((d) => d.bodies !== undefined && d.bodies.length > 0);
    if (withBodies.length === 0) return;
    // Counted BEFORE any stripping so the failure path can't undercount drops
    // (stripped drafts report zero bodies).
    const totalBodies = withBodies.reduce((n, d) => n + (d.bodies?.length ?? 0), 0);
    let settled = 0; // bodies whose insert call completed (inserted OR guard-discarded+counted)
    try {
      // ONE byte-limited chunk at a time: form → encrypt → insert → release
      // (impl-Med-4: the batch budget bounds ciphertext MATERIALIZATION, not
      // just DB round-trips). Plaintext references release per draft as its
      // last body is consumed.
      // Cursor iteration — no retained flat copy (impl-confirm-Med-a): the
      // ONLY live references to a body's plaintext are the draft's own, and
      // each draft is stripped the moment its last body's chunk settles.
      let di = 0;
      let bi = 0;
      while (di < withBodies.length) {
        const chunkRefs: { d: RequestLogDraft; b: CapturedBodyDraft }[] = [];
        let bytes = 0;
        while (di < withBodies.length) {
          const d = withBodies[di]!;
          const list = d.bodies ?? [];
          if (bi >= list.length) {
            di += 1;
            bi = 0;
            continue;
          }
          const b = list[bi]!;
          const cost = Buffer.byteLength(b.content, 'utf8');
          if (chunkRefs.length > 0 && bytes + cost > this.bodyCfg.batchBudgetBytes) break;
          chunkRefs.push({ d, b });
          bytes += cost;
          bi += 1;
        }
        if (chunkRefs.length === 0) break;
        const items: RequestBodyInsertItem[] = chunkRefs.map(({ d, b }) => ({
          requestLogId: d.id,
          direction: b.direction,
          contentEncrypted: encryptSecret(b.content, this.bodyCfg.credentialKey),
          bytes: b.bytes,
          truncated: b.truncated,
          partial: b.partial,
          epoch: b.epoch,
          capturedAt: b.capturedAt,
        }));
        const r = await withTimeout(
          this.db.bodyCapture.insertBodies(principal, items),
          this.cfg.opTimeoutMs,
          'request-body insert',
        );
        settled += items.length;
        if (r.discarded > 0) this.countBodyDrop(principal, r.discarded);
        // Release: strip every draft this chunk finished (its cursor moved past
        // the draft, or it is the current draft with all bodies consumed).
        for (const d of new Set(chunkRefs.map((c) => c.d))) {
          const isCurrent = withBodies[di] === d;
          if (!isCurrent || bi >= (d.bodies?.length ?? 0)) this.stripBodies(d);
        }
      }
    } catch (err) {
      // Bodies are debug data — count what never settled and continue; the log
      // rows already landed. NEVER rethrows (a throw would re-run the parent
      // log insert). The error string carries no body content.
      this.countBodyDrop(principal, totalBodies - settled);
      this.logger.warn(`request-body write failed: ${String(err)}`);
    } finally {
      for (const d of withBodies) this.stripBodies(d); // idempotent
    }
  }

  /** Best-effort persistence of accumulated body-drop counts (the settings
   * card's visible counter). Failures keep the counts for the next cycle. */
  private async flushBodyDropCounts(): Promise<void> {
    for (const [key, entry] of [...this.bodyDrops.entries()]) {
      // Deleted BEFORE the attempt: a timed-out increment is not cancelled and
      // may still commit, so retrying a kept count could DOUBLE-apply it
      // (impl-confirm-2). The counter is advisory — a failure forfeits the
      // delta (logged): undercount is acceptable, overcount is a lie.
      this.bodyDrops.delete(key);
      try {
        await withTimeout(
          this.db.bodyCapture.incrementDropped(entry.principal, entry.n),
          this.cfg.opTimeoutMs,
          'body-drop counter',
        );
      } catch {
        this.logger.warn(`body-drop counter update forfeited ${String(entry.n)} drop(s)`);
        break; // DB unhappy — later cycles handle later drops
      }
    }
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
      priceSource: price?.source ?? null,
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
