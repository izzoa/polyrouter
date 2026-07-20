import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import {
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  type PersistencePort,
} from '@polyrouter/shared/server';
import { BODY_CAPTURE_CONFIG, type BodyCaptureConfig } from './body-capture.config';

const QUEUE_NAME = 'body-capture-purge';
const SCHEDULER_ID = 'body-capture-purge-daily';
const JOB_NAME = 'purge-expired-bodies';
const CRON_DAILY = '30 3 * * *'; // 03:30 UTC — off the pricing refresh's slot
const RECONCILE_TIMEOUT_MS = 10_000;
const RECONCILE_RETRY_MS = 60_000;

const withDeadline = async <T>(p: Promise<T>, ms: number, tag: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(tag)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Daily retention purge (add-body-capture) on its own BullMQ queue — the
 * established Job-Scheduler discipline: fail-open bootstrap (a down Redis
 * never gates boot), always-created producer (a cloud node removes a stale
 * schedule), Worker only on selfhosted (cloud has no bodies to purge), one
 * privileged `purgeExpiredAllOwners()` sweep per occurrence.
 */
@Injectable()
export class BodyPurgeScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BodyPurgeScheduler');
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
    @Inject(BODY_CAPTURE_CONFIG) cfg: BodyCaptureConfig,
  ) {
    this.enabled = cfg.selfhosted;
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
        this.logger.warn(`body purge ${job?.id ?? '?'} failed: ${String(err?.message ?? 'error')}`),
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
      this.logger.warn(`body purge scheduler reconcile deferred: ${String((err as Error).message)}`);
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
        { pattern: CRON_DAILY, tz: 'UTC' },
        {
          name: JOB_NAME,
          opts: { removeOnComplete: { age: 3_600 }, removeOnFail: { age: 86_400 } },
        },
      );
    } else {
      // Removal failures PROPAGATE (pricing-scheduler precedent): a swallowed
      // error would leave a stale schedule registered after a cloud startup.
      await this.queue.removeJobScheduler(SCHEDULER_ID);
    }
  }

  private async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAME) return;
    // Failures PROPAGATE (clink impl-High-1): a swallowed error would mark the
    // occurrence successful in BullMQ and skip its retry.
    const r = await this.db.bodyCapture.purgeExpiredAllOwners();
    if (r.purged > 0) {
      this.logger.log(`body purge: ${String(r.purged)} row(s) across ${String(r.owners)} owner(s)`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    await this.worker?.close();
    await this.queue.close();
    this.producerConn.disconnect();
    this.workerConn?.disconnect();
  }
}
