import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { withDeadline } from '../notifications/notify.queue';
import type { PricingSchedulerConfig } from './pricing.config';
import { PRICING_RUNTIME, PricingService, type PricingRuntime } from './pricing.service';

export const PRICING_SCHEDULER_CONFIG = 'polyrouter:pricing-scheduler-config';

const QUEUE_NAME = 'pricing-refresh';
const SCHEDULER_ID = 'pricing-refresh';
const JOB_NAME = 'pricing_refresh';
const RECONCILE_TIMEOUT_MS = 3_000;
const RECONCILE_RETRY_MS = 30_000;

/** One scheduled occurrence, queue-free for direct unit testing: delegates to
 * the EXISTING guarded refresh path and never throws outward — a failed pull
 * is a logged retry-next-occurrence, not a crashed worker. */
export async function runPricingRefreshOccurrence(
  pricing: Pick<PricingService, 'refresh'>,
  logger: Pick<Logger, 'log' | 'warn'>,
): Promise<void> {
  try {
    const added = await pricing.refresh({ source: 'litellm' }, new Date());
    logger.log(`scheduled pricing refresh: +${String(added)} version(s)`);
  } catch (err) {
    logger.warn(`scheduled pricing refresh failed: ${String((err as Error).message)}`);
  }
}

/**
 * Scheduled pricing refresh (add-pricing-refresh-ui), on its OWN dedicated
 * BullMQ queue — the budget/calibration Job-Scheduler discipline: fail-open
 * bootstrap (a down Redis never gates boot — invariant 1), an always-created
 * producer Queue (a disabled node can remove a stale schedule), a consuming
 * Worker ONLY when EFFECTIVELY enabled — the env flag ∧ `MODE=selfhosted`
 * (cloud never schedules catalog mutations; the service boundary refuses
 * them anyway) — bounded shutdown. DEFAULT ON, daily: the recorded user
 * decision (opt-out `PRICING_REFRESH_SCHED_ENABLED=false`).
 */
@Injectable()
export class PricingRefreshScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PricingRefreshScheduler');
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
    private readonly pricing: PricingService,
    @Inject(PRICING_RUNTIME) runtime: PricingRuntime,
    @Inject(PRICING_SCHEDULER_CONFIG) private readonly cfg: PricingSchedulerConfig,
  ) {
    // Effective enablement = flag ∧ selfhosted (r2-High-2 scope: the mode
    // gate; cloud instances never construct the worker or register the job).
    this.enabled = cfg.configuredEnabled && runtime.mode === 'selfhosted';
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
          `pricing refresh ${job?.id ?? '?'} failed: ${String(err?.message ?? 'error')}`,
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
        `pricing refresh scheduler reconcile deferred: ${String((err as Error).message)}`,
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
          // Bounded retention (r1-Med-4) — mirrors the sibling schedulers.
          opts: { removeOnComplete: { age: 3_600 }, removeOnFail: { age: 86_400 } },
        },
      );
    } else {
      // Removal failures PROPAGATE (r3-Med-2): a swallowed error would mark
      // reconciliation done and leave a stale schedule registered whenever
      // Redis was down during an opt-out/cloud startup. A missing scheduler
      // resolves false — only real faults throw, and those retry.
      await this.queue.removeJobScheduler(SCHEDULER_ID);
    }
  }

  private async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAME) return;
    await runPricingRefreshOccurrence(this.pricing, this.logger);
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
