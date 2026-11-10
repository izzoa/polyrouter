/**
 * One occurrence of the plan-usage schedule (add-subscription-usage-history, design D1/D4). A
 * plain function over injected capabilities, like the model-catalog refresh, so its policy is
 * unit-testable without BullMQ, Redis or Postgres.
 *
 * Policy:
 *  1. READS. Scan the preset-bound subscription rows by id through the maintenance listing,
 *     ROUND-ROBIN from a persisted cursor (wrapping once), keeping only rows the schedule may read
 *     (`canRead`: switch on, no reconnect, an enabled endpoint on a coherent row) whose last
 *     scheduled read is not fresh (a Redis key, ~15 minutes). Neither filter spends budget. At
 *     most `budget` reads per tick, `concurrency` at a time, each after a small random delay and
 *     under a per-row deadline. A row whose shared cooldown is held (a click or another instance
 *     read it) is skipped WITHOUT counting against the budget. An unreachable shared store ENDS
 *     the tick: nothing more is read, sampled or pruned (a per-instance cooldown would let every
 *     instance read). An unreadable freshness cache marks every row fresh: a Redis blip never
 *     turns into a read stampede.
 *  2. SAMPLES. After the reads, the merged snapshot of every row the schedule may sample
 *     (`canSample`: switch on, any usage source) is read in one batched read per page and one row
 *     per window is written to the history, keyed on the window's OWN observation instant, so a
 *     passive reading that arrived between ticks is recorded once and an unchanged one is never
 *     repeated (the database's `ON CONFLICT DO NOTHING`). Unknown stays null, never 0.
 *  3. PRUNES samples older than the retention, in bounded batches.
 * It never runs on the request path, calls no model API, and writes no health record.
 */
import type { PlanUsageSampleInput, PlanUsageScheduleRow } from '@polyrouter/shared/server';
import type { PlanUsageSnapshot } from '@polyrouter/data-plane';
import {
  PlanUsageStoreUnavailableError,
  type UnattendedUsageOutcome,
} from './plan-usage-unattended';

export interface PlanUsageTickDeps {
  listPage(afterId: string | null, limit: number): Promise<readonly PlanUsageScheduleRow[]>;
  /** Whether the schedule may READ the row (see `ProvidersService.canScheduleUsageRead`). */
  canRead(row: PlanUsageScheduleRow): boolean;
  /** Whether the schedule may SAMPLE the row's snapshot (`ProvidersService.canSampleUsage`). */
  canSample(row: PlanUsageScheduleRow): boolean;
  /** One unattended read (`ProvidersService.readUsageUnattended`). Rejects with
   * `PlanUsageStoreUnavailableError` when the shared cooldown store is unreachable. */
  read(row: PlanUsageScheduleRow): Promise<UnattendedUsageOutcome>;
  /** The ids (of those given) whose last scheduled read is still fresh. */
  freshAmong(ids: readonly string[]): Promise<ReadonlySet<string>>;
  markFresh(id: string, ttlMs: number): Promise<void>;
  /** The round-robin cursor: the id of the furthest row a tick started (null = none). */
  readCursor(): Promise<string | null>;
  writeCursor(id: string): Promise<void>;
  /** The merged snapshots of `ids`, in ONE batched store read. */
  snapshots(ids: readonly string[]): Promise<ReadonlyMap<string, PlanUsageSnapshot | null>>;
  insertSamples(samples: readonly PlanUsageSampleInput[]): Promise<number>;
  prune(before: Date, limit: number): Promise<number>;
  sleep(ms: number): Promise<void>;
  now(): number;
  random(): number;
  shouldStop(): boolean;
  warn(message: string): void;
}

export interface PlanUsageTickOptions {
  /** At most this many reads per tick. */
  readonly budget: number;
  readonly concurrency: number;
  readonly perRowDeadlineMs: number;
  /** The tick stops starting reads (and pages) after this long. */
  readonly tickBudgetMs: number;
  readonly pageSize: number;
  readonly jitterMaxMs: number;
  /** How long a scheduled read keeps its row fresh. */
  readonly freshTtlMs: number;
  /** Samples observed longer ago than this are pruned. */
  readonly retentionMs: number;
  readonly pruneBatch: number;
  /** At most this many prune batches per tick. */
  readonly pruneMaxBatches: number;
}

export interface PlanUsageTickResult {
  /** Listing rows looked at for reading (eligible or not). */
  readonly examined: number;
  /** Reads that called the endpoint, by outcome. */
  readonly read: number;
  readonly failed: number;
  readonly timeout: number;
  /** Rows skipped after a pick: cooldown held, vanished, or no longer eligible. */
  readonly skipped: number;
  /** True when the shared store was unreachable and the tick ended early. */
  readonly storeUnavailable: boolean;
  readonly sampled: number;
  readonly pruned: number;
}

const DEADLINE = Symbol('deadline');

/** The sample rows for one provider's snapshot: one per window, at its own observation instant. */
export function samplesFromSnapshot(
  providerId: string,
  snapshot: PlanUsageSnapshot | null | undefined,
): PlanUsageSampleInput[] {
  if (snapshot === null || snapshot === undefined) return [];
  return snapshot.windows.map((w) => ({
    providerId,
    windowKey: w.key,
    usedPercent: w.usedPercent,
    resetAt: w.resetMs === null ? null : new Date(w.resetMs),
    observedAt: new Date(w.observedAt),
  }));
}

export async function runPlanUsageTick(
  deps: PlanUsageTickDeps,
  opts: PlanUsageTickOptions,
): Promise<PlanUsageTickResult> {
  const startedAt = deps.now();
  let storeUnavailable = false;
  const outOfTime = (): boolean =>
    storeUnavailable || deps.shouldStop() || deps.now() - startedAt >= opts.tickBudgetMs;

  // ------------------------------------------------------------------ 1. reads

  // A lazy round-robin scan: rows after the cursor first, then from the start up to and
  // including it. Lanes pull from it, so a skipped row is replaced by the next due one and never
  // costs a read of the budget. One page is fetched at a time, shared by every waiting lane.
  const cursor = await deps.readCursor().catch(() => null);
  const buffer: PlanUsageScheduleRow[] = [];
  let order = 0;
  const orderOf = new Map<string, number>();
  let examined = 0;
  let stage: { afterId: string | null; through: string | null } | null = {
    afterId: cursor,
    through: null,
  };
  let fetching: Promise<void> | null = null;

  const fillPage = async (): Promise<void> => {
    if (stage === null) return;
    if (outOfTime()) {
      stage = null;
      return;
    }
    const { afterId, through } = stage;
    const page = await deps.listPage(afterId, opts.pageSize);
    const inRange = through === null ? page : page.filter((r) => r.id <= through);
    examined += inRange.length;
    const candidates = inRange.filter((r) => deps.canRead(r));
    const fresh = await deps
      .freshAmong(candidates.map((r) => r.id))
      .catch((): ReadonlySet<string> => new Set(candidates.map((r) => r.id)));
    for (const row of candidates) {
      if (fresh.has(row.id)) continue;
      orderOf.set(row.id, order++);
      buffer.push(row);
    }
    const ended = page.length === 0 || inRange.length < page.length || page.length < opts.pageSize;
    if (!ended) stage = { afterId: page[page.length - 1]!.id, through };
    else stage = through === null && cursor !== null ? { afterId: null, through: cursor } : null;
  };

  const nextDue = async (): Promise<PlanUsageScheduleRow | null> => {
    for (;;) {
      const row = buffer.shift();
      if (row !== undefined) return row;
      if (stage === null) return null;
      fetching ??= fillPage().finally(() => {
        fetching = null;
      });
      try {
        await fetching;
      } catch {
        // Every lane waiting on the failed page lands here; warn once.
        if (stage !== null) deps.warn('plan usage schedule: listing providers failed');
        stage = null;
      }
    }
  };

  let read = 0;
  let failed = 0;
  let timeout = 0;
  let skipped = 0;
  let inFlight = 0;
  let furthest = -1;
  let furthestId: string | null = null;
  const markFresh = (id: string): Promise<void> =>
    deps.markFresh(id, opts.freshTtlMs).catch(() => undefined);

  const readRow = async (row: PlanUsageScheduleRow): Promise<void> => {
    const work = deps.read(row);
    let timer: NodeJS.Timeout | undefined;
    try {
      const r = await Promise.race([
        work,
        new Promise<typeof DEADLINE>((resolve) => {
          timer = setTimeout(() => resolve(DEADLINE), opts.perRowDeadlineMs);
          timer.unref();
        }),
      ]);
      if (r === DEADLINE) {
        timeout += 1;
        work.catch(() => undefined); // it settles on its own; never unhandled
        deps.warn('plan usage schedule: a usage read passed its deadline');
        await markFresh(row.id);
        return;
      }
      if (r.status === 'skipped') {
        skipped += 1;
        return;
      }
      if (r.ok) read += 1;
      else failed += 1;
      await markFresh(row.id);
    } catch (err) {
      if (err instanceof PlanUsageStoreUnavailableError) {
        // Nothing was sent. End the tick: every lane stops before its next row.
        storeUnavailable = true;
        skipped += 1;
        return;
      }
      failed += 1;
      deps.warn('plan usage schedule: a usage read failed');
      await markFresh(row.id);
    } finally {
      clearTimeout(timer);
    }
  };

  const lane = async (): Promise<void> => {
    for (;;) {
      // A slot is taken only while reads done plus reads in flight stay under the budget, so a
      // skipped row frees its slot for the next due one.
      if (outOfTime() || read + failed + timeout + inFlight >= opts.budget) return;
      inFlight += 1;
      let row: PlanUsageScheduleRow | null;
      try {
        row = await nextDue();
        if (row === null) return;
        await deps.sleep(Math.floor(deps.random() * opts.jitterMaxMs));
        if (outOfTime()) return;
        const at = orderOf.get(row.id) ?? -1;
        if (at > furthest) {
          furthest = at;
          furthestId = row.id;
        }
        await readRow(row);
      } finally {
        inFlight -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => lane()));
  if (furthestId !== null) await deps.writeCursor(furthestId).catch(() => undefined);

  const result = { examined, read, failed, timeout, skipped, storeUnavailable };
  if (storeUnavailable || deps.shouldStop()) return { ...result, sampled: 0, pruned: 0 };

  // ------------------------------------------------------------------ 2. samples

  let sampled = 0;
  try {
    let afterId: string | null = null;
    for (;;) {
      if (deps.shouldStop() || deps.now() - startedAt >= opts.tickBudgetMs) break;
      const page = await deps.listPage(afterId, opts.pageSize);
      if (page.length === 0) break;
      const ids = page.filter((r) => deps.canSample(r)).map((r) => r.id);
      if (ids.length > 0) {
        const snapshots = await deps.snapshots(ids);
        const samples = ids.flatMap((id) => samplesFromSnapshot(id, snapshots.get(id)));
        if (samples.length > 0) sampled += await deps.insertSamples(samples);
      }
      if (page.length < opts.pageSize) break;
      afterId = page[page.length - 1]!.id;
    }
  } catch {
    deps.warn('plan usage schedule: sampling the usage history failed');
  }

  // ------------------------------------------------------------------ 3. prune

  let pruned = 0;
  try {
    const before = new Date(deps.now() - opts.retentionMs);
    for (let i = 0; i < opts.pruneMaxBatches && !deps.shouldStop(); i += 1) {
      const n = await deps.prune(before, opts.pruneBatch);
      pruned += n;
      if (n < opts.pruneBatch) break;
    }
  } catch {
    deps.warn('plan usage schedule: pruning the usage history failed');
  }

  return { ...result, sampled, pruned };
}
