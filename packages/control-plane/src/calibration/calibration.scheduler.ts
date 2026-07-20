import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PERSISTENCE_PORT, REDIS_CLIENT, type PersistencePort } from '@polyrouter/shared/server';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { withDeadline } from '../notifications/notify.queue';
import { ROUTING_CONFIG, type RoutingConfig } from '../proxy/routing.config';
import { CALIBRATION_CONFIG, railsOf, type CalibrationConfig } from './calibration.config';
import { runCalibrationOccurrence } from './calibration.run';

const QUEUE_NAME = 'threshold-calibration';
const SCHEDULER_ID = 'threshold-calibration';
const JOB_NAME = 'calibration_sweep';
const RECONCILE_TIMEOUT_MS = 3_000;
const RECONCILE_RETRY_MS = 30_000;

/**
 * Threshold-calibration scheduler (add-auto-threshold-calibration), on its OWN
 * dedicated BullMQ queue — mirrors the budget scheduler's Job-Scheduler
 * discipline exactly: fail-open bootstrap (a down Redis never gates boot or
 * affects routing — invariant 1), an always-created producer Queue (a
 * disabled node can still remove a stale schedule), a consuming Worker ONLY
 * when `CALIBRATION_SCHED_ENABLED`, bounded shutdown.
 */
@Injectable()
export class CalibrationScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CalibrationScheduler');
  private readonly producerConn: Redis;
  private readonly workerConn: Redis | undefined;
  private readonly queue: Queue;
  private readonly worker: Worker | undefined;
  private readonly enabled: boolean;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconciled = false;
  private shuttingDown = false;

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(ROUTING_CONFIG) private readonly routing: RoutingConfig,
    @Inject(CALIBRATION_CONFIG) private readonly cfg: CalibrationConfig,
  ) {
    this.enabled = cfg.schedEnabled;
    this.producerConn = redis.duplicate({
      maxRetriesPerRequest: 3,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    this.producerConn.on('error', () => {});
    if (this.producerConn.status === 'wait') void this.producerConn.connect().catch(() => {});
    this.queue = new Queue(QUEUE_NAME, { connection: this.producerConn });
    this.queue.on('error', () => {});
    if (this.enabled) {
      this.workerConn = redis.duplicate({ maxRetriesPerRequest: null });
      this.workerConn.on('error', () => {});
      if (this.workerConn.status === 'wait') void this.workerConn.connect().catch(() => {});
      this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
        connection: this.workerConn,
      });
      this.worker.on('error', () => {});
      this.worker.on('failed', (job, err) =>
        this.logger.warn(
          `calibration sweep ${job?.id ?? '?'} failed: ${String(err?.message ?? 'error')}`,
        ),
      );
    }
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
        `calibration scheduler reconcile deferred: ${String((err as Error).message)}`,
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
    if (this.enabled) {
      await this.queue.upsertJobScheduler(
        SCHEDULER_ID,
        { pattern: this.cfg.cron, tz: 'UTC' },
        {
          name: JOB_NAME,
          opts: { removeOnComplete: { age: 3_600 }, removeOnFail: { age: 86_400 } },
        },
      );
    } else {
      await this.queue.removeJobScheduler(SCHEDULER_ID).catch(() => undefined);
    }
  }

  private async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAME) return;
    await this.runOccurrence(Date.now());
  }

  /** One sweep — extracted for tests; the heavy lifting is queue-free. */
  runOccurrence(now: number): Promise<unknown> {
    return runCalibrationOccurrence(
      this.db,
      this.routing.structural,
      this.cfg,
      railsOf(this.cfg),
      now,
      this.logger,
    );
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
