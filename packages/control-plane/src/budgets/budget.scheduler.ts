import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { REDIS_CLIENT, type BudgetRow } from '@polyrouter/shared/server';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { withDeadline } from '../notifications/notify.queue';
import { BUDGET_READER, type BudgetReader } from '../database/budget.reader';
import { NotificationProducers } from '../producers/notification-producers';
import { SpendCounter } from './spend-counter';
import { periodInfo, toMicros, type BudgetWindow } from './period';
import { BUDGETS_CONFIG, type BudgetsConfig } from './budgets.config';

const QUEUE_NAME = 'budget-eval';
const SCHEDULER_ID = 'budget-eval';
const JOB_NAME = 'budget_eval';
const RECONCILE_TIMEOUT_MS = 3_000;
const RECONCILE_RETRY_MS = 30_000;
/** Counter/marker TTL grace past the period end (clock skew + late log rows). */
const GRACE_MS = 60_000;

function parseCsv(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface KeyGroup {
  readonly key: string;
  readonly owner: string;
  readonly scope: string;
  readonly scopeId: string;
  readonly window: BudgetWindow;
  readonly periodId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly budgets: BudgetRow[];
}

/**
 * Run one reconcile occurrence: recompute each active budget's current-period
 * spend from the request-log ledgers and monotonically SET its shared counter
 * (the scheduler is the SOLE writer — no live per-request increment), emit
 * `budget_alert` for at/over-threshold alert budgets (deduped once per period),
 * then stamp the reconcile heartbeat. `atMs` is the evaluation instant (the
 * caller passes `prevMillis − 1` so a run at a boundary reconciles the just-closed
 * period). Extracted (no queue/worker) so it is directly unit-testable.
 */
/** Best-effort logger for the free-function occurrence (alert-dedup faults). */
const occurrenceLogger = new Logger('BudgetReconcile');

export async function runBudgetOccurrence(
  reader: BudgetReader,
  counter: SpendCounter,
  producers: NotificationProducers,
  atMs: number,
  staleMs: number,
): Promise<void> {
  const at = new Date(atMs);
  const active = await reader.listActiveBudgets();

  // Group by distinct counter key so each ledger scan + counter write happens
  // once even when several budgets share a scope/window/period.
  const groups = new Map<string, KeyGroup>();
  for (const b of active) {
    const window = b.window as BudgetWindow;
    const { periodId, startMs, endMs } = periodInfo(window, at);
    const scopeId = b.scope === 'agent' ? (b.agentId ?? 'global') : 'global';
    const key = counter.key(b.ownerUserId, b.scope, scopeId, window, periodId);
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        key,
        owner: b.ownerUserId,
        scope: b.scope,
        scopeId,
        window,
        periodId,
        startMs,
        endMs,
        budgets: [],
      };
      groups.set(key, g);
    }
    g.budgets.push(b);
  }

  for (const g of groups.values()) {
    const agentId = g.scope === 'agent' ? g.scopeId : null;
    const spend = await reader.spendMicrosFor(
      g.owner,
      agentId,
      new Date(g.startMs),
      new Date(g.endMs),
    );
    const micros = spend.micros;
    const ttlMs = g.endMs - atMs + GRACE_MS;
    await counter.reconcileMax(g.key, micros, ttlMs);

    for (const b of g.budgets) {
      if (b.action !== 'alert' || micros < toMicros(b.amount)) continue;
      const markKey = `budget-alerted:${b.id}:${g.periodId}`;
      // Alert dedup/emit is best-effort and NOT required for counter correctness:
      // a marker fault must never abort the occurrence and skip the heartbeat
      // (which would degrade block enforcement). Contain it per budget. (E6.3)
      try {
        if (await counter.markAlertOnce(markKey, ttlMs)) {
          producers.budgetAlert({
            ownerUserId: b.ownerUserId,
            ...(b.agentId !== null ? { agentId: b.agentId } : {}),
            budgetId: b.id,
            periodId: g.periodId,
            name: b.name,
            spent: micros,
            threshold: toMicros(b.amount),
            // Display provenance only — metering is identical either way.
            spendEstimated: spend.estimatedMicros > 0,
            channelIds: parseCsv(b.notifyChannelIds),
          });
        }
      } catch (err) {
        occurrenceLogger.warn(
          `budget alert dedup failed for ${b.id}: ${err instanceof Error ? err.constructor.name : 'unknown'}`,
        );
      }
    }
  }

  // Prove reconciliation is alive (TTL comfortably past the freshness horizon so a
  // fresh heartbeat is never GC'd early; a stopped scheduler trips staleness).
  await counter.heartbeatSet(atMs, staleMs * 2);
}

/**
 * Reconcile + alert scheduler (#16), on its OWN dedicated BullMQ queue
 * (`budget-eval` — never the shared `producers` queue, so two workers can't steal
 * each other's jobs). Mirrors #15b's Job-Scheduler discipline: fail-open bootstrap
 * (a down Redis never gates boot — invariant 1), a consuming Worker only when
 * enabled (default on — this IS the enforcement engine), bounded shutdown.
 */
@Injectable()
export class BudgetScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BudgetScheduler');
  private readonly producerConn: Redis;
  private readonly workerConn: Redis | undefined;
  private readonly queue: Queue;
  private readonly worker: Worker | undefined;
  private readonly enabled: boolean;
  private readonly cron: string;
  private readonly staleMs: number;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconciled = false;
  private shuttingDown = false;

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(BUDGET_READER) private readonly reader: BudgetReader,
    private readonly counter: SpendCounter,
    private readonly producers: NotificationProducers,
    @Inject(BUDGETS_CONFIG) cfg: BudgetsConfig,
  ) {
    this.enabled = cfg.schedEnabled;
    this.cron = cfg.schedCron;
    this.staleMs = cfg.staleMs;
    // Always a lightweight producer Queue (so reconcile can remove a stale
    // schedule even when disabled); the consuming Worker only when enabled.
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
          `budget eval ${job?.id ?? '?'} failed: ${String(err?.message ?? 'error')}`,
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
      this.logger.warn(`budget scheduler reconcile deferred: ${String((err as Error).message)}`);
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
        { pattern: this.cron, tz: 'UTC' },
        // Bounded retention (E6.2): don't accumulate job records forever in the
        // enforcement Redis (mirrors notify.queue's BASE_JOB_OPTS).
        { name: JOB_NAME, opts: { removeOnComplete: { age: 3_600 }, removeOnFail: { age: 86_400 } } },
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

  /** Run one occurrence (evaluate the period at `prevMillis − 1`). */
  runOccurrence(prevMillis: number): Promise<void> {
    return runBudgetOccurrence(
      this.reader,
      this.counter,
      this.producers,
      prevMillis - 1,
      this.staleMs,
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
