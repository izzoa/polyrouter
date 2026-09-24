/**
 * One occurrence of the model-catalog refresh (add-live-subscription-models). A
 * plain function over injected capabilities — like the OAuth credential sweep — so
 * its policy is unit-testable without BullMQ, Redis, or Postgres.
 *
 * Policy (design D4):
 *  1. scan the providers that can list their models (credentialed, or local where
 *     local is allowed, and not awaiting reauthorization) by id, through a list-only
 *     maintenance accessor — no credential leaves the maintenance port;
 *  2. a row is DUE when its freshness key is absent (refreshed > ~24h ago, a failure
 *     older than its retry spacing — ~1h, doubling per consecutive failure up to a day
 *     — or never); an unreadable cache marks every row fresh — a Redis blip must never
 *     turn into a listing stampede;
 *  3. at most `budget` due rows per tick, `concurrency` at a time, each after a small
 *     random delay and under a per-row deadline that ABORTS the listing; the rest carry
 *     to later ticks. The scan itself is bounded: it starts from a persisted cursor
 *     (the furthest row the last tick started), wraps once, and stops as soon as the
 *     budget is full or the tick runs out — ROUND-ROBIN, never always from the lowest
 *     id, so past one day's capacity the tail is still reached and failing rows never
 *     keep the budget;
 *  4. each refresh runs under the row's OWN owner and does exactly the manual sync —
 *     list, upsert, reconcile — issuing ONLY the model-listing call (never chat, never
 *     test-connection) and writing no health record.
 */
import { userPrincipal, type CatalogRefreshRow, type Principal } from '@polyrouter/shared/server';

export interface CatalogRefreshDeps {
  listPage(afterId: string | null, limit: number): Promise<readonly CatalogRefreshRow[]>;
  /** The provider's listing sync, health-silent. Resolves `ok:false` on a typed
   * failure; may also reject (contained here). `signal` aborts it at the per-row
   * deadline — an aborted listing writes nothing. */
  refresh(principal: Principal, id: string, signal: AbortSignal): Promise<{ readonly ok: boolean }>;
  /** The ids (of those given) whose catalog is currently marked fresh. */
  freshAmong(ids: readonly string[]): Promise<ReadonlySet<string>>;
  /** Mark a catalog fresh (or failed) for `ttlMs`. */
  markFresh(id: string, ttlMs: number): Promise<void>;
  /** Count one more consecutive failure for a provider; resolves the new count. */
  recordFailure(id: string): Promise<number>;
  /** Forget a provider's consecutive failures (after a success). */
  clearFailures(id: string): Promise<void>;
  /** The round-robin cursor: the id of the last row a tick started (null = none). */
  readCursor(): Promise<string | null>;
  writeCursor(id: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  random(): number;
  shouldStop(): boolean;
  warn(message: string): void;
}

export interface CatalogRefreshOptions {
  readonly budget: number;
  readonly concurrency: number;
  readonly perRowDeadlineMs: number;
  readonly tickBudgetMs: number;
  readonly pageSize: number;
  readonly jitterMaxMs: number;
  /** Freshness after a successful refresh (~24h). */
  readonly freshTtlMs: number;
  /** Spacing before a failed refresh is first retried (~1h); consecutive failures
   * double it, capped at `freshTtlMs` — an endpoint that never lists (a server with
   * no models route) settles to about one attempt a day instead of 24. */
  readonly retryTtlMs: number;
}

export interface CatalogRefreshResult {
  readonly examined: number;
  readonly due: number;
  readonly refreshed: number;
  readonly failed: number;
  readonly timeout: number;
  readonly carriedOver: number;
}

const DEADLINE = Symbol('deadline');

export async function runModelCatalogRefresh(
  deps: CatalogRefreshDeps,
  opts: CatalogRefreshOptions,
): Promise<CatalogRefreshResult> {
  const startedAt = deps.now();
  const outOfTime = (): boolean => deps.shouldStop() || deps.now() - startedAt >= opts.tickBudgetMs;

  // 1-2. Collect at most `budget` DUE rows, scanning round-robin from the persisted
  // cursor (the furthest row the previous tick started): rows after it first, then
  // wrapping to the start up to and including it. The scan stops as soon as the budget
  // is full or the tick runs out — enumeration is bounded like the work, never a
  // whole-table walk per tick.
  const budgetSize = Math.max(0, opts.budget);
  const cursor = await deps.readCursor().catch(() => null);
  const due: CatalogRefreshRow[] = [];
  let examined = 0;
  const scan = async (from: string | null, through: string | null): Promise<void> => {
    let afterId = from;
    for (;;) {
      if (due.length >= budgetSize || outOfTime()) return;
      const page = await deps.listPage(afterId, opts.pageSize);
      if (page.length === 0) return;
      const inRange = through === null ? page : page.filter((r) => r.id <= through);
      examined += inRange.length;
      const fresh = await deps
        .freshAmong(inRange.map((r) => r.id))
        .catch((): ReadonlySet<string> => new Set(inRange.map((r) => r.id)));
      for (const row of inRange) {
        if (fresh.has(row.id)) continue;
        due.push(row);
        if (due.length >= budgetSize) return;
      }
      if (inRange.length < page.length || page.length < opts.pageSize) return;
      afterId = page[page.length - 1]!.id;
    }
  };
  await scan(cursor, null);
  if (cursor !== null) await scan(null, cursor);

  let refreshed = 0;
  let failed = 0;
  let timeout = 0;
  const markFresh = (id: string, ttlMs: number): Promise<void> =>
    deps.markFresh(id, ttlMs).catch(() => undefined);
  const succeeded = async (id: string): Promise<void> => {
    await deps.clearFailures(id).catch(() => undefined);
    await markFresh(id, opts.freshTtlMs);
  };
  /** Retry spacing doubles with each consecutive failure, capped at the freshness
   * window; an unreadable counter counts as a first failure. */
  const backedOff = async (id: string): Promise<void> => {
    const n = await deps.recordFailure(id).catch(() => 1);
    const ttl = Math.min(opts.freshTtlMs, opts.retryTtlMs * 2 ** Math.max(0, Math.min(n, 16) - 1));
    await markFresh(id, ttl);
  };

  const refreshRow = async (row: CatalogRefreshRow): Promise<void> => {
    const deadline = new AbortController();
    const work = deps.refresh(userPrincipal(row.ownerUserId), row.id, deadline.signal);
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
        // Abort the listing: a row past its deadline must not write after the tick
        // has counted it failed, nor keep its lane's work running.
        deadline.abort();
        work.catch(() => undefined); // it settles on its own; never unhandled
        await backedOff(row.id);
        return;
      }
      if (r.ok) {
        refreshed += 1;
        await succeeded(row.id);
      } else {
        failed += 1;
        deps.warn('model catalog refresh: a provider listing failed');
        await backedOff(row.id);
      }
    } catch {
      failed += 1;
      deps.warn('model catalog refresh: a provider listing failed');
      await backedOff(row.id);
    } finally {
      clearTimeout(timer);
    }
  };

  // 3. Jittered `concurrency` lanes over the collected (already rotated) due rows.
  const budget = due;
  let next = 0;
  let started = 0;
  // The furthest budget index actually STARTED: lanes claim indices before their
  // jitter, so a lane that claims and then stops (tick budget / shutdown) leaves a
  // gap — the cursor must name a row that ran, never the Nth claimed one.
  let furthest = -1;
  const lane = async (): Promise<void> => {
    for (;;) {
      if (outOfTime()) return;
      const i = next++;
      if (i >= budget.length) return;
      await deps.sleep(Math.floor(deps.random() * opts.jitterMaxMs));
      if (outOfTime()) return;
      started += 1;
      furthest = Math.max(furthest, i);
      await refreshRow(budget[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => lane()));
  if (furthest >= 0) await deps.writeCursor(budget[furthest]!.id).catch(() => undefined);

  return {
    examined,
    due: due.length,
    refreshed,
    failed,
    timeout,
    carriedOver: due.length - started,
  };
}
