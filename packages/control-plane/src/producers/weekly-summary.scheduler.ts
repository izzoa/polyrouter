import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { NotificationService } from '../notifications/notification.service';
import { withDeadline } from '../notifications/notify.queue';
import { WEEKLY_SPEND_READER, type WeeklySpendReader } from '../database/weekly-spend.reader';
import { PRODUCERS_CONFIG, type ProducersConfig } from './producers.config';

const QUEUE_NAME = 'producers';
const SCHEDULER_ID = 'weekly-summary';
const JOB_NAME = 'weekly_summary';
const WEEK_MS = 7 * 86_400_000;
const RECONCILE_TIMEOUT_MS = 3_000;
const RECONCILE_RETRY_MS = 30_000;

function formatMoney(total: number): string {
  return `$${(Number.isFinite(total) ? total : 0).toFixed(2)}`;
}

/** Run one occurrence: aggregate `[prevMillis-7d, prevMillis)` and emit one
 * summary per owner, keyed by the occurrence (idempotent under re-run). Extracted
 * (no queue/worker) so it's directly unit-testable. */
export async function runWeeklyOccurrence(
  reader: WeeklySpendReader,
  notifications: Pick<NotificationService, 'emit'>,
  prevMillis: number,
): Promise<void> {
  const endExclusive = new Date(prevMillis);
  const start = new Date(prevMillis - WEEK_MS);
  const occurrenceKey = String(prevMillis);
  const rows = await reader.weeklySpendByOwner(start, endExclusive);
  for (const r of rows) {
    await notifications.emit({
      type: 'weekly_spend_summary',
      scope: { ownerUserId: r.ownerUserId, lifecycleId: occurrenceKey },
      fields: {
        total: formatMoney(r.total),
        // Present only when the week includes estimate-priced spend — the renderer
        // marks the total accordingly (add-native-price-fallback).
        ...(r.nativeFamilySpend > 0 ? { nativeFamilySpend: formatMoney(r.nativeFamilySpend) } : {}),
      },
    });
  }
}

/**
 * Schedules the opt-in weekly per-owner spend summary (#15b) as a BullMQ Job
 * Scheduler (single-run across instances, UTC). Reconciliation is **fail-open**
 * so a down Redis can never gate boot (invariant 1); the handler is at-least-once
 * with occurrence-keyed idempotent emits over a bounded `[start, end)` window.
 */
@Injectable()
export class WeeklySummaryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('WeeklySummaryScheduler');
  private readonly producerConn: Redis;
  private readonly workerConn: Redis | undefined;
  private readonly queue: Queue;
  private readonly worker: Worker | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconciled = false;
  private shuttingDown = false;

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(WEEKLY_SPEND_READER) private readonly reader: WeeklySpendReader,
    private readonly notifications: NotificationService,
    @Inject(PRODUCERS_CONFIG) private readonly cfg: ProducersConfig,
  ) {
    // Always a lightweight producer Queue (so reconcile can remove a stale
    // schedule even when now-disabled). The consuming Worker is created ONLY when
    // the feature is enabled — a run-loop worker is what leaks otherwise, and the
    // weekly summary is opt-in (default off) so most apps carry no worker.
    this.producerConn = redis.duplicate({
      maxRetriesPerRequest: 3,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    this.producerConn.on('error', () => {});
    if (this.producerConn.status === 'wait') void this.producerConn.connect().catch(() => {});
    this.queue = new Queue(QUEUE_NAME, { connection: this.producerConn });
    this.queue.on('error', () => {});
    if (cfg.weeklyEnabled) {
      this.workerConn = redis.duplicate({ maxRetriesPerRequest: null });
      this.workerConn.on('error', () => {});
      if (this.workerConn.status === 'wait') void this.workerConn.connect().catch(() => {});
      this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
        connection: this.workerConn,
      });
      this.worker.on('error', () => {});
      this.worker.on('failed', (job, err) =>
        this.logger.warn(
          `weekly summary ${job?.id ?? '?'} failed: ${String(err?.message ?? 'error')}`,
        ),
      );
    }
  }

  onApplicationBootstrap(): void {
    // Fire-and-forget: reconciliation must never gate boot (invariant 1).
    void this.reconcile();
  }

  /** Register/deregister the schedule; on failure retry in a single background
   * loop (bounded, un-refed, cancelled on shutdown). */
  private async reconcile(): Promise<void> {
    if (this.reconciled || this.reconciling || this.shuttingDown) return;
    this.reconciling = true;
    try {
      await withDeadline(this.applySchedule(), RECONCILE_TIMEOUT_MS, 'reconcile_timeout');
      this.reconciled = true;
    } catch (err) {
      this.logger.warn(`weekly scheduler reconcile deferred: ${String((err as Error).message)}`);
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
    if (this.cfg.weeklyEnabled) {
      await this.queue.upsertJobScheduler(
        SCHEDULER_ID,
        { pattern: this.cfg.weeklyCron, tz: 'UTC' },
        {
          name: JOB_NAME,
          opts: {
            // Retry a transient failure (A-32): the weekly-summary occurrence is
            // idempotent (dedup'd per scope+period), so a retry can't double-send —
            // but without `attempts` a single transient fault (DB/Redis blip) drops
            // the whole week's summary silently. Bounded retention (E6.2).
            attempts: 4,
            backoff: { type: 'exponential' as const, delay: 2_000 },
            removeOnComplete: { age: 3_600 },
            removeOnFail: { age: 86_400 },
          },
        },
      );
    } else {
      await this.queue.removeJobScheduler(SCHEDULER_ID).catch(() => undefined);
    }
  }

  private async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAME) return;
    const prevMillis = (job.opts as { prevMillis?: number }).prevMillis ?? job.timestamp;
    await this.runOccurrence(prevMillis);
  }

  /** Run one occurrence (delegates to the extracted, unit-tested function). */
  runOccurrence(prevMillis: number): Promise<void> {
    return runWeeklyOccurrence(this.reader, this.notifications, prevMillis);
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
          const t = setTimeout(resolve, 2_000);
          t.unref();
        }),
      ]);
    if (this.worker) await bounded(this.worker.close());
    await bounded(this.queue.close());
    this.producerConn.disconnect();
    this.workerConn?.disconnect();
  }
}
