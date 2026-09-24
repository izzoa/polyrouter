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
  PERSISTENCE_MAINTENANCE,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  type PersistenceMaintenance,
  type PersistencePort,
} from '@polyrouter/shared/server';
import { jobFailureReason } from '../notifications/notify.queue';
import { runOauthRefreshSweep, type SweepOptions } from './oauth-refresh.sweep';
import {
  SubscriptionOauthService,
  VERIFIED_RETRY_TTL_MS,
  verifiedKey,
} from './subscription-oauth.service';

const QUEUE_NAME = 'oauth-refresh-sweep';
const SCHEDULER_ID = 'oauth-refresh-every-15m';
const JOB_NAME = 'refresh-oauth-credentials';
const EVERY_MS = 15 * 60 * 1000;
const RECONCILE_TIMEOUT_MS = 10_000;
const RECONCILE_RETRY_MS = 60_000;

/** The sweep's constants (design D6) — tunable without a spec change. */
export const OAUTH_SWEEP_OPTIONS: SweepOptions = {
  nearExpiryMs: 60 * 60 * 1000, // > the cadence + the lazy refresh margin
  livenessBudget: 25,
  concurrency: 4,
  perRowDeadlineMs: 20_000,
  tickBudgetMs: 12 * 60 * 1000, // finish well inside one 15-minute tick
  pageSize: 200,
  jitterMaxMs: 2_000,
  retryTtlMs: VERIFIED_RETRY_TTL_MS,
};

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
 * The OAuth proactive-refresh sweep (add-provider-health-signals) on its own BullMQ
 * queue — the established Job-Scheduler discipline (body-purge precedent):
 * fail-open bootstrap (a down Redis never gates boot), one occurrence per tick
 * across instances. The worker runs in BOTH modes (presets exist in both). Lives
 * in its own controller-free module: it needs `PERSISTENCE_MAINTENANCE`, which a
 * request-handling module never injects.
 */
@Injectable()
export class OauthRefreshScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OauthRefreshScheduler');
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
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PERSISTENCE_MAINTENANCE) private readonly maintenance: PersistenceMaintenance,
    private readonly oauth: SubscriptionOauthService,
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
    this.workerConn = redis.duplicate({ maxRetriesPerRequest: null });
    this.workerConn.on('error', () => {});
    if (this.workerConn.status === 'wait') void this.workerConn.connect().catch(() => {});
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
      connection: this.workerConn,
    });
    this.worker.on('error', () => {});
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`oauth refresh sweep ${job?.id ?? '?'} failed: ${jobFailureReason(err)}`),
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
          { every: EVERY_MS },
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
        `oauth refresh scheduler reconcile deferred: ${String((err as Error).message)}`,
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
    const r = await this.sweepOnce();
    const touched = r.outcomes.refreshed + r.outcomes.reauthorize_required;
    if (touched > 0 || r.outcomes.failed > 0) {
      this.logger.log(
        `oauth refresh sweep: ${String(r.examined)} examined, ${String(r.outcomes.refreshed)} refreshed, ` +
          `${String(r.outcomes.reauthorize_required)} need reconnect, ${String(r.outcomes.transient)} deferred, ` +
          `${String(r.carriedOver)} carried over`,
      );
    }
  }

  /** One sweep over the real collaborators (exposed for the e2e). */
  sweepOnce(options: SweepOptions = OAUTH_SWEEP_OPTIONS): ReturnType<typeof runOauthRefreshSweep> {
    return runOauthRefreshSweep(
      {
        listPage: (afterId, limit) =>
          this.maintenance.providers.listOauthConnected({ afterId, limit }),
        findById: (principal, id) => this.db.providers.findById(principal, id),
        forceRefresh: (principal, id, envelope) =>
          this.oauth.forceRefresh(principal, id, envelope, 'scheduled'),
        verifiedAmong: async (ids) => {
          if (ids.length === 0) return new Set();
          const vals = await this.redis.mget(...ids.map(verifiedKey)).catch(() => null);
          // Redis unreadable: treat every grant as verified — never a liveness
          // stampede on a cache outage (near-expiry work is unaffected).
          if (vals === null) return new Set(ids);
          return new Set(ids.filter((_, i) => vals[i] !== null));
        },
        markChecked: async (id, ttlMs) => {
          await this.redis.set(verifiedKey(id), '1', 'PX', ttlMs).catch(() => undefined);
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref()),
        now: () => Date.now(),
        random: () => Math.random(),
        shouldStop: () => this.shuttingDown,
        warn: (m) => this.logger.warn(m),
      },
      options,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // Stop the sweep first: an in-progress occurrence checks this between rows.
    this.shuttingDown = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    // Bound the graceful close (the notify-queue / batch-poller precedent): a worker
    // blocked on an unreachable Redis, or waiting on an in-flight row refresh, must
    // not hang shutdown — fall through to a forced disconnect (invariant 12).
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
