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
  REDIS_CLIENT,
  type PersistenceMaintenance,
} from '@polyrouter/shared/server';
import { jobFailureReason } from '../notifications/notify.queue';
import { runModelCatalogRefresh, type CatalogRefreshOptions } from './model-catalog-refresh';
import { ProvidersService } from './providers.service';

const QUEUE_NAME = 'model-catalog-refresh';
const SCHEDULER_ID = 'model-catalog-every-60m';
const JOB_NAME = 'refresh-model-catalogs';
const EVERY_MS = 60 * 60 * 1000;
const RECONCILE_TIMEOUT_MS = 10_000;
const RECONCILE_RETRY_MS = 60_000;
const FRESH_KEY_PREFIX = 'model-catalog:';
const FAIL_KEY_PREFIX = 'model-catalog-fails:';
const FAIL_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CURSOR_KEY = 'model-catalog-cursor';

/** The catalog refresh's constants (design D4): each provider is re-listed about
 * daily (960/day at these values), a failure retried after about an hour. */
export const MODEL_CATALOG_OPTIONS: CatalogRefreshOptions = {
  budget: 40,
  concurrency: 4,
  perRowDeadlineMs: 30_000,
  tickBudgetMs: 10 * 60 * 1000, // well inside one hourly tick
  pageSize: 200,
  jitterMaxMs: 2_000,
  freshTtlMs: 24 * 60 * 60 * 1000,
  retryTtlMs: 60 * 60 * 1000,
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
 * The daily model-catalog refresh (add-live-subscription-models) on its own BullMQ
 * queue — the established Job-Scheduler discipline (the OAuth sweep / body-purge
 * precedent): fail-open bootstrap (a down Redis never gates boot), one occurrence per
 * tick across instances, a bounded shutdown that aborts an in-flight listing. Every
 * provider that can list its models is re-listed about once a day — listing only,
 * never chat or Test, and health-silent. Lives in its own controller-free module: it
 * needs `PERSISTENCE_MAINTENANCE`, which a request-handling module never injects.
 */
@Injectable()
export class ModelCatalogScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ModelCatalogScheduler');
  private readonly producerConn: Redis;
  private readonly workerConn: Redis;
  private readonly queue: Queue;
  private readonly worker: Worker;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconciled = false;
  private shuttingDown = false;
  /** Aborts an in-flight listing on shutdown, so it writes nothing after. */
  private readonly stopping = new AbortController();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PERSISTENCE_MAINTENANCE) private readonly maintenance: PersistenceMaintenance,
    private readonly providers: ProvidersService,
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
      this.logger.warn(`model catalog refresh ${job?.id ?? '?'} failed: ${jobFailureReason(err)}`),
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
        `model catalog scheduler reconcile deferred: ${String((err as Error).message)}`,
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
    const c = await this.catalogOnce();
    if (c.refreshed > 0 || c.failed > 0 || c.timeout > 0) {
      this.logger.log(
        `model catalog refresh: ${String(c.examined)} examined, ${String(c.refreshed)} refreshed, ` +
          `${String(c.failed + c.timeout)} failed, ${String(c.carriedOver)} carried over`,
      );
    }
  }

  /** One catalog refresh over the real collaborators (exposed for the e2e). Each
   * provider is re-listed under its own owner, health-silent; only the listing call
   * is issued. */
  catalogOnce(
    options: CatalogRefreshOptions = MODEL_CATALOG_OPTIONS,
  ): ReturnType<typeof runModelCatalogRefresh> {
    return runModelCatalogRefresh(
      {
        listPage: (afterId, limit) =>
          this.maintenance.providers.listCatalogRefreshable({
            afterId,
            limit,
            includeLocal: this.providers.allowsLocalProviders,
          }),
        // Aborted at the row's deadline OR on shutdown — either way it writes nothing.
        refresh: (principal, id, signal) =>
          this.providers.refreshCatalog(
            principal,
            id,
            AbortSignal.any([signal, this.stopping.signal]),
          ),
        freshAmong: async (ids) => {
          if (ids.length === 0) return new Set();
          const vals = await this.redis.mget(...ids.map(freshKey)).catch(() => null);
          // Redis unreadable: treat every catalog as fresh — never a listing stampede.
          if (vals === null) return new Set(ids);
          return new Set(ids.filter((_, i) => vals[i] !== null));
        },
        markFresh: async (id, ttlMs) => {
          await this.redis.set(freshKey(id), '1', 'PX', ttlMs).catch(() => undefined);
        },
        recordFailure: async (id) => {
          const key = `${FAIL_KEY_PREFIX}${id}`;
          const n = await this.redis.incr(key);
          await this.redis.pexpire(key, FAIL_KEY_TTL_MS).catch(() => undefined);
          return n;
        },
        clearFailures: async (id) => {
          await this.redis.del(`${FAIL_KEY_PREFIX}${id}`).catch(() => undefined);
        },
        readCursor: () => this.redis.get(CURSOR_KEY).catch(() => null),
        writeCursor: async (id) => {
          await this.redis.set(CURSOR_KEY, id).catch(() => undefined);
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
    // Stop between rows, and abort an in-flight listing so it writes nothing after.
    this.shuttingDown = true;
    this.stopping.abort();
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    // Bounded graceful close (invariant 12): a worker blocked on an unreachable Redis
    // must not hang shutdown — fall through to a forced disconnect.
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
