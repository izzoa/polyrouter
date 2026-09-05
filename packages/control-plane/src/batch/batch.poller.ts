import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  BatchUpstreamNotFoundError,
  CallCancelledError,
  ProviderError,
  type BatchAdapter,
  type BatchStatusView,
} from '@polyrouter/data-plane';
import {
  isBatchJobTerminal,
  type BatchJobErrorKind,
  type BatchJobStatus,
  type BatchJobTerminalStatus,
} from '@polyrouter/shared';
import {
  PERSISTENCE_MAINTENANCE,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  userPrincipal,
  type BatchJobRow,
  type PersistenceMaintenance,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { DashboardEvents } from '../events/dashboard-events';
import { jobFailureReason, withDeadline } from '../notifications/notify.queue';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { NotificationProducers } from '../producers/notification-producers';
import { BudgetService } from '../budgets/budget-service';
import { BatchService } from './batch.service';
import { BatchSettlement } from './batch-settlement';
import { BATCH_CONFIG, type BatchConfig } from './batch.config';

const QUEUE_NAME = 'batch-poll';
const SCHEDULER_ID = 'batch-poll';
const JOB_NAME = 'batch_poll';
const RECONCILE_TIMEOUT_MS = 3_000;
const RECONCILE_RETRY_MS = 30_000;
/** Jobs advanced per sweep. Bounds one occurrence's upstream calls; the next
 * sweep continues from the oldest-updated rows (the accessor's order). */
const SWEEP_LIMIT = 200;
/** A `submitting` row older than this has no upstream id and no answer: it moves
 * to `submission_unknown` for reconciliation rather than being failed on a guess. */
const SUBMITTING_GRACE_MS = 120_000;
/** How long a job may stay unresolved before the operator is told, and — for
 * `submission_unknown` — before it is finally failed as `submit_unresolved`. */
const STALL_NOTIFY_MS = 900_000;
const SUBMISSION_UNKNOWN_WINDOW_MS = 6 * 3_600_000;
/** Every state a job can be terminated FROM when it has nothing to settle. */
const NON_TERMINAL: readonly BatchJobStatus[] = [
  'submitting',
  'submission_unknown',
  'validating',
  'in_progress',
  'finalizing',
  'cancelling',
];

/** What one job's advance produced, for the sweep's accounting. */
interface Advance {
  readonly settled: boolean;
  readonly terminal: BatchJobStatus | null;
}

/**
 * The batch poller (add-batch-inference task 4.1): a Redis-backed scheduler that
 * drives every non-terminal job to a terminal state, resuming from the DATABASE
 * after a restart and draining on shutdown (invariant 12).
 *
 * It sweeps through the instance-level maintenance accessor because it has no
 * principal of its own; every write it performs goes through the OWNER-SCOPED
 * accessors under the principal derived from each row (tenant-isolation, D19).
 *
 * Two rules keep a budget honest (D21): a status polyrouter cannot map is NOT
 * terminal — the job keeps its reservation and keeps polling — and a job past its
 * local completion window is `expired` only when the UPSTREAM says so. Releasing
 * on a guess is how a budget stays wrong.
 *
 * Its upstream calls never touch the synchronous circuit breaker (task 4.2): a
 * status probe failing says nothing about the provider's ability to serve a
 * request, and counting it would open a breaker for traffic that is fine.
 */
@Injectable()
export class BatchPoller implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BatchPoller');
  private readonly producerConn: Redis;
  private readonly workerConn: Redis | undefined;
  private readonly queue: Queue;
  private readonly worker: Worker | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconciled = false;
  private shuttingDown = false;
  /** Jobs this instance is mid-advance on: one sweep never doubles up on a job,
   * and a settlement in flight is not restarted by the next occurrence. */
  private readonly inFlight = new Set<string>();
  /** The sweep in progress, awaited by the shutdown drain. */
  private sweeping: Promise<void> | null = null;

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PERSISTENCE_MAINTENANCE) private readonly maintenance: PersistenceMaintenance,
    @Inject(BATCH_CONFIG) private readonly cfg: BatchConfig,
    private readonly batches: BatchService,
    private readonly settlement: BatchSettlement,
    private readonly budgets: BudgetService,
    private readonly producers: NotificationProducers,
    private readonly metrics: ProxyMetrics,
    private readonly events: DashboardEvents,
  ) {
    this.producerConn = redis.duplicate({
      maxRetriesPerRequest: 3,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    this.producerConn.on('error', () => {});
    if (this.producerConn.status === 'wait') void this.producerConn.connect().catch(() => {});
    this.queue = new Queue(QUEUE_NAME, { connection: this.producerConn });
    this.queue.on('error', () => {});
    // The poller runs even when submissions are disabled: in-flight jobs must
    // drain to a terminal state and release their reservations (D23).
    this.workerConn = redis.duplicate({ maxRetriesPerRequest: null });
    this.workerConn.on('error', () => {});
    if (this.workerConn.status === 'wait') void this.workerConn.connect().catch(() => {});
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
      connection: this.workerConn,
    });
    this.worker.on('error', () => {});
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`batch poll ${job?.id ?? '?'} failed: ${jobFailureReason(err)}`),
    );
  }

  onApplicationBootstrap(): void {
    void this.reconcile();
  }

  private async reconcile(): Promise<void> {
    if (this.reconciled || this.reconciling || this.shuttingDown) return;
    this.reconciling = true;
    try {
      await withDeadline(this.applySchedule(), RECONCILE_TIMEOUT_MS, 'reconcile_timeout');
      this.reconciled = true;
    } catch (err) {
      this.logger.warn(
        `batch poll scheduler reconcile deferred: ${String((err as Error).message)}`,
      );
      if (!this.shuttingDown) {
        this.reconcileTimer = setTimeout(() => {
          this.reconcileTimer = undefined;
          void this.reconcile();
        }, RECONCILE_RETRY_MS);
        this.reconcileTimer.unref();
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async applySchedule(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: this.cfg.pollIntervalMs },
      {
        name: JOB_NAME,
        opts: { removeOnComplete: { age: 3_600 }, removeOnFail: { age: 86_400 } },
      },
    );
  }

  private async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAME) return;
    await this.sweep();
  }

  /**
   * One occurrence: advance every non-terminal job it can, oldest-updated first.
   * A single job's failure is contained — the sweep continues — because one bad
   * provider must not stall every other tenant's jobs.
   */
  async sweep(): Promise<void> {
    if (this.shuttingDown) return;
    const run = this.runSweep();
    this.sweeping = run;
    try {
      await run;
    } finally {
      if (this.sweeping === run) this.sweeping = null;
    }
  }

  private async runSweep(): Promise<void> {
    let rows: BatchJobRow[];
    try {
      rows = await this.maintenance.batchJobs.listNonTerminal(SWEEP_LIMIT);
    } catch (err) {
      this.logger.warn(`batch sweep could not read jobs: ${jobFailureReason(err)}`);
      return;
    }
    const now = Date.now();
    const lag = rows.map((r) => (now - (r.lastPolledAt ?? r.submittedAt).getTime()) / 1000);
    this.metrics.observeBatchSweep(rows.length, lag);
    for (const row of rows) {
      if (this.shuttingDown) return;
      if (this.inFlight.has(row.id)) continue;
      this.inFlight.add(row.id);
      try {
        await this.advance(row);
      } catch (err) {
        // Contained per job: an unreachable provider, a deleted credential, a
        // malformed upstream object. The job stays non-terminal and is retried
        // on the next sweep; nothing is released on a failure.
        this.logger.warn(`batch ${row.id} advance failed: ${jobFailureReason(err)}`);
      } finally {
        this.inFlight.delete(row.id);
      }
    }
  }

  /** Advance ONE job under the principal derived from its own row. */
  private async advance(row: BatchJobRow): Promise<Advance> {
    const principal = userPrincipal(row.ownerUserId);
    const status = row.status as BatchJobStatus;
    const provider = await this.db.providers.findById(principal, row.providerId);
    if (provider === null) {
      // The provider was deleted while the job was in flight: nothing can advance
      // it, so it is definitively failed and its reservation released.
      return this.finish(principal, row, 'failed', 'provider_missing');
    }
    await this.db.batchJobs.update(principal, row.id, { lastPolledAt: new Date() });

    if (status === 'submitting') {
      // Before the grace elapses the submit call may simply still be running.
      if (Date.now() - row.submittedAt.getTime() < SUBMITTING_GRACE_MS) {
        return { settled: false, terminal: null };
      }
      const moved = await this.db.batchJobs.update(
        principal,
        row.id,
        { status: 'submission_unknown', errorKind: null, stalledSince: new Date() },
        { whenStatusIn: ['submitting'] },
      );
      if (moved !== null) this.publish(principal, moved);
      return { settled: false, terminal: null };
    }

    const batch = await this.batches.batchFor(principal, provider);
    if (status === 'submission_unknown' || row.upstreamBatchId === null) {
      return this.reconcileSubmission(principal, row, provider, batch);
    }
    // A cancel recorded before an upstream id existed is honoured now that one does.
    if (row.cancelRequested && status !== 'cancelling') {
      await this.tryCancel(batch, row.upstreamBatchId);
      const moved = await this.db.batchJobs.update(
        principal,
        row.id,
        { status: 'cancelling' },
        { whenStatusIn: ['validating', 'in_progress', 'finalizing'] },
      );
      if (moved !== null) this.publish(principal, moved);
    }

    let view: BatchStatusView;
    try {
      view = await batch.status(row.upstreamBatchId);
    } catch (err) {
      if (err instanceof BatchUpstreamNotFoundError) {
        // The upstream no longer knows it. Past the local window that IS the
        // confirmation the expiry rule waits for; before it, the job was never
        // really created and is provably lost.
        return this.expiredOrLost(principal, row, provider);
      }
      throw err;
    }
    return this.applyStatus(principal, row, provider, batch, view);
  }

  /** `submission_unknown`: find the job upstream by the id polyrouter attached, or
   * fail it only when it is provably absent / the window has elapsed (D6). */
  private async reconcileSubmission(
    principal: Principal,
    row: BatchJobRow,
    provider: ProviderRow,
    batch: BatchAdapter,
  ): Promise<Advance> {
    const entries = await batch.list();
    const found = entries.find((e) => e.jobId === row.id);
    if (found !== undefined) {
      const adopted = await this.db.batchJobs.update(principal, row.id, {
        status: found.status ?? 'in_progress',
        upstreamBatchId: found.upstreamId,
        errorKind: null,
        stalledSince: null,
      });
      if (adopted !== null) {
        this.logger.log(`batch ${row.id}: adopted upstream id after reconciliation`);
        this.publish(principal, adopted);
        // A cancel recorded while the id was unknown applies the moment it is adopted.
        if (adopted.cancelRequested) await this.tryCancel(batch, found.upstreamId);
      }
      return { settled: false, terminal: null };
    }
    const stalledFor = Date.now() - (row.stalledSince ?? row.submittedAt).getTime();
    if (stalledFor >= SUBMISSION_UNKNOWN_WINDOW_MS) {
      // The upstream has not shown this job for the whole window: it is provably
      // absent from everything the upstream lists, so nothing was billed.
      return this.finish(
        principal,
        row,
        'failed',
        row.cancelRequested ? 'submit_lost' : 'submit_unresolved',
      );
    }
    this.notifyStall(row, 'submission_unknown', stalledFor);
    return { settled: false, terminal: null };
  }

  /** Map the upstream's view onto the job, settling when it is definitive. */
  private async applyStatus(
    principal: Principal,
    row: BatchJobRow,
    provider: ProviderRow,
    batch: BatchAdapter,
    view: BatchStatusView,
  ): Promise<Advance> {
    const upstream = view.status;
    if (upstream === null) {
      // Unmapped: NOT terminal. The reservation is held and the job re-polled;
      // after a bound the operator is told (D21).
      const since = row.stalledSince ?? new Date();
      const updated = await this.db.batchJobs.update(principal, row.id, {
        errorKind: 'upstream_status_unknown',
        stalledSince: since,
        ...(view.resultsExpireAt !== null ? { resultsExpireAt: view.resultsExpireAt } : {}),
      });
      if (updated !== null) this.publish(principal, updated);
      this.notifyStall(row, 'upstream_status_unknown', Date.now() - since.getTime());
      return { settled: false, terminal: null };
    }
    const patch = {
      status: upstream,
      errorKind: null,
      stalledSince: null,
      ...(view.counts !== null
        ? { completedCount: view.counts.completed, failedCount: view.counts.failed }
        : {}),
      ...(view.resultsExpireAt !== null ? { resultsExpireAt: view.resultsExpireAt } : {}),
    };
    if (!isBatchJobTerminal(upstream)) {
      const updated = await this.db.batchJobs.update(principal, row.id, patch, {
        whenStatusIn: [
          'validating',
          'in_progress',
          'finalizing',
          'cancelling',
          'submission_unknown',
        ],
      });
      if (updated !== null) this.publish(principal, updated);
      return { settled: false, terminal: null };
    }
    // Definitive. Hold `finalizing` (reservation kept) while settlement runs, then
    // flip terminal and release — never the other way round (D9).
    const finalizing = await this.db.batchJobs.update(
      principal,
      row.id,
      {
        status:
          row.status === 'cancelling' || upstream === 'cancelled' ? 'cancelling' : 'finalizing',
        errorKind: null,
        stalledSince: null,
        ...(view.resultsExpireAt !== null ? { resultsExpireAt: view.resultsExpireAt } : {}),
      },
      {
        whenStatusIn: [
          'validating',
          'in_progress',
          'finalizing',
          'cancelling',
          'submission_unknown',
        ],
      },
    );
    const job = finalizing ?? row;
    if (finalizing !== null) this.publish(principal, finalizing);
    return this.settleAndFinish(principal, job, provider, batch, upstream);
  }

  /** Stream the results once, record them durably, then flip terminal + release. */
  private async settleAndFinish(
    principal: Principal,
    job: BatchJobRow,
    provider: ProviderRow,
    batch: BatchAdapter,
    terminal: BatchJobTerminalStatus,
  ): Promise<Advance> {
    let completed = 0;
    let failed = 0;
    let settledCostMicros = 0;
    if (job.upstreamBatchId !== null) {
      try {
        const outcome = await this.settlement.settle(
          job,
          batch.results(job.upstreamBatchId),
          new Date(),
          provider.name,
        );
        completed = outcome.completed;
        failed = outcome.failed;
        settledCostMicros = outcome.settledCostMicros;
      } catch (err) {
        if (!(err instanceof BatchUpstreamNotFoundError)) throw err;
        // Results are gone (retention lapsed while we finalized). Nothing ran that
        // we can price; the job still terminates and releases.
        this.logger.warn(`batch ${job.id}: results unavailable at settlement`);
      }
    }
    const status = terminal === 'cancelled' || job.status === 'cancelling' ? 'cancelled' : terminal;
    return this.finish(principal, job, status, null, { completed, failed, settledCostMicros });
  }

  /** The single place a job becomes terminal and its reservation is released. */
  private async finish(
    principal: Principal,
    job: BatchJobRow,
    status: 'completed' | 'failed' | 'expired' | 'cancelled',
    errorKind: BatchJobErrorKind | null,
    counts: { completed: number; failed: number; settledCostMicros: number } = {
      completed: 0,
      failed: 0,
      settledCostMicros: 0,
    },
  ): Promise<Advance> {
    const settlement = {
      status,
      completedCount: counts.completed,
      failedCount: counts.failed,
      settledCostMicros: counts.settledCostMicros,
      terminalAt: new Date(),
      ...(errorKind !== null ? { errorKind } : {}),
    };
    // A job that ran items flips terminal only from the state its settlement held
    // it in; one with nothing to settle (a confirmed expiry, a lost submission, a
    // deleted provider) may finish from any non-terminal state.
    const done = await this.db.batchJobs.settle(
      principal,
      job.id,
      settlement,
      counts.completed + counts.failed > 0 ? {} : { whenStatusIn: NON_TERMINAL },
    );
    if (done === null) return { settled: false, terminal: null };
    if (job.reservedCeilingMicros !== null) {
      await this.budgets.releaseForBatch(
        principal,
        job.agentId,
        job.submittedAt,
        job.reservedCeilingMicros,
      );
    }
    this.metrics.recordBatch(job.providerId, status);
    this.publish(principal, done);
    return { settled: counts.completed + counts.failed > 0, terminal: status };
  }

  /** The upstream cannot find the job: past its local window that confirms
   * expiry; before it, the create never really landed. */
  private async expiredOrLost(
    principal: Principal,
    row: BatchJobRow,
    provider: ProviderRow,
  ): Promise<Advance> {
    void provider;
    const deadline = row.submittedAt.getTime() + row.completionWindowMs + this.cfg.windowMarginMs;
    if (Date.now() >= deadline) return this.finish(principal, row, 'expired', null);
    return this.finish(principal, row, 'failed', 'submit_lost');
  }

  /** Best-effort upstream cancel: a failure here never blocks the sweep — the
   * next occurrence retries, and the job's own status is the record. */
  private async tryCancel(batch: BatchAdapter, upstreamId: string): Promise<void> {
    try {
      await batch.cancel(upstreamId);
    } catch (err) {
      if (err instanceof BatchUpstreamNotFoundError) return;
      if (err instanceof ProviderError || err instanceof CallCancelledError) return;
      throw err;
    }
  }

  /** The owner-scoped, metadata-only nudge (D18). Best-effort and synchronous-
   * bounded: the bus never awaits a consumer. */
  private publish(principal: Principal, row: BatchJobRow): void {
    try {
      this.events.publishToOwner(principal, {
        type: 'batch.updated',
        id: row.id,
        status: row.status,
        completed: row.completedCount,
        failed: row.failedCount,
        total: row.itemCount,
        updatedAt: row.updatedAt.toISOString(),
      });
    } catch {
      /* a broken consumer must never affect the sweep */
    }
  }

  /** Tell the operator once per `(job, kind)` stall, past the bound. */
  private notifyStall(row: BatchJobRow, kind: string, stalledForMs: number): void {
    if (stalledForMs < STALL_NOTIFY_MS) return;
    this.producers.batchStalled({
      ownerUserId: row.ownerUserId,
      agentId: row.agentId,
      jobId: row.id,
      kind,
      status: row.status,
      stalledMinutes: Math.round(stalledForMs / 60_000),
      modelId: row.modelId,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    const bounded = (p: Promise<unknown>): Promise<void> =>
      Promise.race([
        p.then(
          () => {},
          () => {},
        ),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5_000);
          t.unref();
        }),
      ]);
    // Let an in-flight settlement finish: its chunks are durable, but a job left
    // in `finalizing` holds its reservation until the next boot's sweep.
    if (this.sweeping !== null) await bounded(this.sweeping);
    if (this.worker) await bounded(this.worker.close());
    await bounded(this.queue.close());
    this.producerConn.disconnect();
    this.workerConn?.disconnect();
  }
}
