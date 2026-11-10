import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { PlanUsageStore } from '@polyrouter/data-plane';
import {
  PERSISTENCE_MAINTENANCE,
  REDIS_CLIENT,
  type PersistenceMaintenance,
} from '@polyrouter/shared/server';
import { jobFailureReason } from '../notifications/notify.queue';
import { ProvidersService } from '../providers/providers.service';
import {
  runPlanUsageTick,
  type PlanUsageTickDeps,
  type PlanUsageTickOptions,
} from './plan-usage-tick';
import { PLAN_USAGE_STORE } from './plan-usage.tokens';

/** The schedule's BullMQ queue name. Injectable only so an e2e can isolate its own queue from a
 * dev stack sharing the same Redis; production binds nothing and gets the default. */
export const PLAN_USAGE_SCHEDULE_QUEUE = 'polyrouter:plan-usage-schedule-queue';

const DEFAULT_QUEUE_NAME = 'plan-usage-schedule';
const SCHEDULER_ID = 'plan-usage-every-15m';
const JOB_NAME = 'read-plan-usage';
/** FD1: one tick every 15 minutes. */
export const PLAN_USAGE_SCHEDULE_EVERY_MS = 15 * 60 * 1000;
const RECONCILE_TIMEOUT_MS = 10_000;
const RECONCILE_RETRY_MS = 60_000;
const FRESH_KEY_PREFIX = 'plan-usage-sched:';
const CURSOR_KEY = 'plan-usage-sched-cursor';

/** The schedule's constants (design D1/D4, FD1/FD4). A row is read about every 15 minutes: its
 * freshness lasts one minute less than a tick, so jitter and a slow tick never stretch the cadence
 * to two ticks. Samples are kept 35 days, pruned in batches of 5,000. */
export const PLAN_USAGE_SCHEDULE_OPTIONS: PlanUsageTickOptions = {
  budget: 40,
  concurrency: 4,
  perRowDeadlineMs: 20_000,
  tickBudgetMs: 10 * 60 * 1000, // well inside one 15-minute tick
  pageSize: 200,
  jitterMaxMs: 2_000,
  freshTtlMs: PLAN_USAGE_SCHEDULE_EVERY_MS - 60_000,
  retentionMs: 35 * 24 * 60 * 60 * 1000,
  pruneBatch: 5_000,
  pruneMaxBatches: 20,
};

const freshKey = (id: string): string => `${FRESH_KEY_PREFIX}${id}`;

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
 * The plan-usage schedule (add-subscription-usage-history, design D1) on its own BullMQ queue,
 * the model-catalog refresh's discipline: a fail-open bootstrap (a down Redis never gates boot),
 * ONE occurrence per tick across instances (a single repeatable job scheduler), and a bounded
 * shutdown. Each tick reads the usage endpoint of every eligible subscription provider about once
 * per 15 minutes through `ProvidersService.readUsageUnattended` (the SAME shared cooldown as
 * Refresh usage), then samples the merged snapshots into the history and prunes it. It is never
 * on the request path and never part of the OAuth sweep. Lives in its own controller-free module:
 * it needs `PERSISTENCE_MAINTENANCE`, which a request-handling module never injects.
 */
@Injectable()
export class PlanUsageScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PlanUsageScheduler');
  private readonly producerConn: Redis;
  private readonly workerConn: Redis;
  private readonly queue: Queue;
  private readonly worker: Worker;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconciled = false;
  private shuttingDown = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PERSISTENCE_MAINTENANCE) private readonly maintenance: PersistenceMaintenance,
    private readonly providers: ProvidersService,
    @Inject(PLAN_USAGE_STORE) private readonly store: PlanUsageStore,
    @Optional() @Inject(PLAN_USAGE_SCHEDULE_QUEUE) queueName?: string,
  ) {
    const name = queueName ?? DEFAULT_QUEUE_NAME;
    this.producerConn = redis.duplicate({
      maxRetriesPerRequest: 3,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    this.producerConn.on('error', () => {});
    if (this.producerConn.status === 'wait') void this.producerConn.connect().catch(() => {});
    this.queue = new Queue(name, { connection: this.producerConn });
    this.queue.on('error', () => {});
    this.workerConn = redis.duplicate({ maxRetriesPerRequest: null });
    this.workerConn.on('error', () => {});
    if (this.workerConn.status === 'wait') void this.workerConn.connect().catch(() => {});
    this.worker = new Worker(name, (job) => this.process(job), { connection: this.workerConn });
    this.worker.on('error', () => {});
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`plan usage schedule ${job?.id ?? '?'} failed: ${jobFailureReason(err)}`),
    );
  }

  onApplicationBootstrap(): void {
    void this.reconcile();
  }

  private async reconcile(): Promise<void> {
    if (this.reconciled || this.reconciling || this.shuttingDown) return;
    this.reconciling = true;
    try {
      await withDeadline(
        this.queue.upsertJobScheduler(
          SCHEDULER_ID,
          { every: PLAN_USAGE_SCHEDULE_EVERY_MS },
          {
            name: JOB_NAME,
            opts: { removeOnComplete: { age: 3_600 }, removeOnFail: { age: 86_400 } },
          },
        ),
        RECONCILE_TIMEOUT_MS,
        'reconcile_timeout',
      );
      this.reconciled = true;
    } catch (err) {
      this.logger.warn(
        `plan usage scheduler reconcile deferred: ${String((err as Error).message)}`,
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

  private async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAME) return;
    const r = await this.usageOnce();
    if (r.storeUnavailable) {
      this.logger.warn('plan usage schedule: the shared usage store is unreachable; tick ended');
    }
    if (r.read > 0 || r.failed > 0 || r.timeout > 0 || r.sampled > 0 || r.pruned > 0) {
      // Counts only: never a provider id, a percent or an upstream message.
      this.logger.log(
        `plan usage schedule: ${String(r.read)} read, ${String(r.failed + r.timeout)} failed, ` +
          `${String(r.skipped)} skipped, ${String(r.sampled)} samples, ${String(r.pruned)} pruned`,
      );
    }
  }

  /** The real collaborators of one tick. Exposed so an e2e can narrow the listing to its own
   * rows (a dev database may hold other rows); production always uses them unchanged. */
  tickDeps(): PlanUsageTickDeps {
    return {
      listPage: (afterId, limit) =>
        this.maintenance.providers.listPlanUsageScheduled({ afterId, limit }),
      canRead: (row) => this.providers.canScheduleUsageRead(row),
      canSample: (row) => this.providers.canSampleUsage(row),
      read: (row) => this.providers.readUsageUnattended(row),
      freshAmong: async (ids) => {
        if (ids.length === 0) return new Set();
        const vals = await this.redis.mget(...ids.map(freshKey)).catch(() => null);
        // Redis unreadable: treat every row as fresh — never a read stampede.
        if (vals === null) return new Set(ids);
        return new Set(ids.filter((_, i) => vals[i] !== null));
      },
      markFresh: async (id, ttlMs) => {
        await this.redis.set(freshKey(id), '1', 'PX', ttlMs).catch(() => undefined);
      },
      readCursor: () => this.redis.get(CURSOR_KEY).catch(() => null),
      writeCursor: async (id) => {
        await this.redis.set(CURSOR_KEY, id).catch(() => undefined);
      },
      snapshots: async (ids) => {
        const found = await this.store.readMany(ids);
        return new Map(ids.map((id) => [id, found.get(id)?.snapshot ?? null]));
      },
      insertSamples: (samples) => this.maintenance.planUsageSamples.insertPlanUsageSamples(samples),
      prune: (before, limit) =>
        this.maintenance.planUsageSamples.prunePlanUsageSamples(before, limit),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref()),
      now: () => Date.now(),
      random: () => Math.random(),
      shouldStop: () => this.shuttingDown,
      warn: (m) => this.logger.warn(m),
    };
  }

  /** One tick over the real collaborators (exposed for the e2e). */
  usageOnce(
    options: PlanUsageTickOptions = PLAN_USAGE_SCHEDULE_OPTIONS,
    deps: PlanUsageTickDeps = this.tickDeps(),
  ): ReturnType<typeof runPlanUsageTick> {
    return runPlanUsageTick(deps, options);
  }

  async onApplicationShutdown(): Promise<void> {
    // Stop between rows; an in-flight read finishes on its own deadline (10 s) and writes only
    // its own snapshot.
    this.shuttingDown = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    // Bounded graceful close (invariant 12): a worker blocked on an unreachable Redis must not
    // hang shutdown — fall through to a forced disconnect.
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
    await bounded(this.worker.close());
    await bounded(this.queue.close());
    this.producerConn.disconnect();
    this.workerConn.disconnect();
  }
}
