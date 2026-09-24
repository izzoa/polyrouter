/**
 * One occurrence of the OAuth proactive-refresh sweep (add-provider-health-signals).
 * A plain function over injected capabilities so its scheduling policy — every row
 * examined, known near-expiry first, liveness budgeted — is unit-testable without
 * BullMQ, Redis, or Postgres.
 *
 * Policy (design D6):
 *  1. page EVERY OAuth-connected row by id (no fixed window can starve a row);
 *  2. a row whose KNOWN expiry is within the horizon is near-expiry — refreshed first,
 *     soonest-expiring first, `concurrency` at a time, each bounded by a deadline;
 *  3. a row with an unknown expiry, or whose grant is not verified within the
 *     liveness window, is liveness-class — at most `livenessBudget` per tick, each
 *     after a small random delay (a first deploy or a lost verification cache is
 *     spread over ticks, never a stampede); a transient failure is retried only
 *     after the shorter retry window, so failing rows cannot hog the budget;
 *  4. work stops at the tick budget or on shutdown; the rest carries to the next
 *     tick (and a token that lapses meanwhile is still renewed lazily on use).
 * Each row is refreshed under ITS OWN owner (derived from the row), re-read through
 * the owner-scoped port for the credential the refresh is keyed on. The sweep calls
 * only the presets' token endpoints — never a model API.
 */
import {
  userPrincipal,
  type OauthSweepRow,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import type { ForceRefreshOutcome } from './subscription-oauth.service';

export interface SweepDeps {
  listPage(afterId: string | null, limit: number): Promise<readonly OauthSweepRow[]>;
  findById(principal: Principal, id: string): Promise<ProviderRow | null>;
  forceRefresh(principal: Principal, id: string, envelope: string): Promise<ForceRefreshOutcome>;
  /** The ids (of those given) whose grant is currently marked verified. */
  verifiedAmong(ids: readonly string[]): Promise<ReadonlySet<string>>;
  /** Mark a grant as recently checked for `ttlMs` (the transient retry spacing). */
  markChecked(id: string, ttlMs: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  random(): number;
  shouldStop(): boolean;
  warn(message: string): void;
}

export interface SweepOptions {
  readonly nearExpiryMs: number;
  readonly livenessBudget: number;
  readonly concurrency: number;
  readonly perRowDeadlineMs: number;
  readonly tickBudgetMs: number;
  readonly pageSize: number;
  readonly jitterMaxMs: number;
  readonly retryTtlMs: number;
}

export interface SweepResult {
  readonly examined: number;
  readonly nearExpiry: number;
  readonly liveness: number;
  readonly outcomes: Readonly<
    Record<ForceRefreshOutcome | 'skipped' | 'failed' | 'timeout', number>
  >;
  readonly carriedOver: number;
}

const DEADLINE = Symbol('deadline');

export async function runOauthRefreshSweep(
  deps: SweepDeps,
  opts: SweepOptions,
): Promise<SweepResult> {
  const startedAt = deps.now();
  const outcomes: Record<ForceRefreshOutcome | 'skipped' | 'failed' | 'timeout', number> = {
    refreshed: 0,
    adopted: 0,
    transient: 0,
    reauthorize_required: 0,
    aborted: 0,
    skipped: 0,
    failed: 0,
    timeout: 0,
  };
  const outOfTime = (): boolean => deps.shouldStop() || deps.now() - startedAt >= opts.tickBudgetMs;

  // 1. Page every row; classify.
  const near: OauthSweepRow[] = [];
  const liveness: OauthSweepRow[] = [];
  let examined = 0;
  let afterId: string | null = null;
  for (;;) {
    if (deps.shouldStop()) break;
    const page = await deps.listPage(afterId, opts.pageSize);
    if (page.length === 0) break;
    examined += page.length;
    const verified = await deps.verifiedAmong(page.map((r) => r.id));
    const now = deps.now();
    for (const row of page) {
      const exp = row.credentialExpiresAt?.getTime() ?? null;
      if (exp !== null && exp - now <= opts.nearExpiryMs) near.push(row);
      else if (exp === null || !verified.has(row.id)) liveness.push(row);
    }
    afterId = page[page.length - 1]!.id;
    if (page.length < opts.pageSize) break;
  }

  // One row: re-read under its OWN owner, refresh keyed on the stored credential.
  const refreshRow = async (row: OauthSweepRow, isLiveness: boolean): Promise<void> => {
    const principal = userPrincipal(row.ownerUserId);
    const work = (async (): Promise<ForceRefreshOutcome | 'skipped'> => {
      const fresh = await deps.findById(principal, row.id);
      if (fresh === null || fresh.encryptedCredentials === null) return 'skipped';
      return deps.forceRefresh(principal, row.id, fresh.encryptedCredentials);
    })();
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
        outcomes.timeout += 1;
        work.catch(() => undefined); // it settles on its own; never unhandled
        if (isLiveness) await deps.markChecked(row.id, opts.retryTtlMs);
        return;
      }
      outcomes[r] += 1;
      // A transient liveness failure is retried only after the retry window.
      if (r === 'transient' && isLiveness) await deps.markChecked(row.id, opts.retryTtlMs);
    } catch {
      outcomes.failed += 1;
      deps.warn('oauth refresh sweep: a provider refresh failed');
      if (isLiveness) await deps.markChecked(row.id, opts.retryTtlMs).catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  };

  // 2. Known near-expiry first, soonest first, `concurrency` at a time.
  near.sort((a, b) => a.credentialExpiresAt!.getTime() - b.credentialExpiresAt!.getTime());
  let next = 0;
  let carriedOver = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      if (outOfTime()) return;
      const i = next++;
      if (i >= near.length) return;
      await refreshRow(near[i]!, false);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => lane()));
  carriedOver += Math.max(0, near.length - Math.min(next, near.length));

  // 3. Budgeted, jittered liveness checks.
  const budget = liveness.slice(0, Math.max(0, opts.livenessBudget));
  let done = 0;
  for (const row of budget) {
    if (outOfTime()) break;
    await deps.sleep(Math.floor(deps.random() * opts.jitterMaxMs));
    if (outOfTime()) break;
    await refreshRow(row, true);
    done += 1;
  }
  carriedOver += liveness.length - done;

  return { examined, nearExpiry: near.length, liveness: liveness.length, outcomes, carriedOver };
}
