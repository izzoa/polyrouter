import type { AvailableBudgetProgress, BudgetProgressConfig } from '@polyrouter/shared';
import type { ApiClient, BudgetDto } from './api';

export interface BudgetProgressEntry {
  snapshot?: AvailableBudgetProgress;
  asOf?: string;
  receivedAt?: number;
  durationMs?: number;
  loading: boolean;
  error: string | null;
}

export function budgetFingerprint(b: BudgetProgressConfig): string {
  return JSON.stringify([
    b.id,
    b.name,
    b.scope,
    b.agentId,
    b.window,
    b.action,
    b.meteringBasis,
    b.amount,
    b.enabled,
    b.notifyChannelIds,
    b.createdAt,
  ]);
}

/** A conservative server-relative clock; a skewed browser wall clock is irrelevant. */
export function progressClock(entry: BudgetProgressEntry, now = performance.now()) {
  const ageMs = Math.max(0, now - (entry.receivedAt ?? now)) + (entry.durationMs ?? 0);
  return {
    ageMs,
    stale: ageMs > 45000 || entry.error !== null,
    expired:
      entry.snapshot !== undefined &&
      entry.asOf !== undefined &&
      Date.parse(entry.asOf) + ageMs >= Date.parse(entry.snapshot.period.end),
  };
}

/** One sequential chunk cycle per dashboard, with at most one forced replacement.
 * Identity/navigation/mutation cancellation invalidates continuations, not the
 * single-flight lock: a new owner must wait for the old request to finish. */
export function createBudgetProgressLoader(options: {
  client: ApiClient;
  budgets: () => BudgetDto[];
  entries: () => Record<string, BudgetProgressEntry>;
  set: (id: string, value: BudgetProgressEntry | undefined) => void;
  active: () => boolean;
  identity: () => number;
  reconcile: () => Promise<void>;
  onCycleStart?: () => void;
}) {
  let generation = 0;
  let running: Promise<void> | null = null;
  let queued = false;
  const cancel = (ids?: readonly string[]): void => {
    generation += 1;
    queued = false;
    for (const id of Object.keys(options.entries())) {
      const entry = options.entries()[id];
      options.set(
        id,
        ids?.includes(id) ? undefined : entry ? { ...entry, loading: false } : undefined,
      );
    }
  };
  const load = (force = false): Promise<void> => {
    if (!options.active()) return Promise.resolve();
    if (running) {
      if (force) queued = true;
      return running;
    }
    const work = async () => {
      let reconciled = false;
      do {
        queued = false;
        const gen = generation;
        const identity = options.identity();
        const current = () =>
          gen === generation && identity === options.identity() && options.active();
        const budgets = options.budgets().map((b) => ({ ...b }));
        if (budgets.length > 0) options.onCycleStart?.();
        let mismatch = false;
        for (let offset = 0; offset < budgets.length; offset += 20) {
          if (!current()) break;
          const chunk = budgets.slice(offset, offset + 20);
          for (const b of chunk) {
            const previous = options.entries()[b.id];
            // A retry is not a successful snapshot: retain the previous failure
            // marker alongside retained data until fresh data actually arrives.
            options.set(b.id, {
              ...previous,
              loading: true,
              error: previous?.snapshot ? previous.error : null,
            });
          }
          const started = performance.now();
          try {
            const response = await options.client.budgetProgress(chunk.map((b) => b.id));
            if (!current()) break;
            const receivedAt = performance.now();
            const results = new Map(response.results.map((r) => [r.id, r]));
            for (const b of chunk) {
              const displayed = options.budgets().find((item) => item.id === b.id);
              if (!displayed || budgetFingerprint(displayed) !== budgetFingerprint(b)) continue;
              const result = results.get(b.id);
              if (
                !result ||
                result.availability === 'not_found' ||
                budgetFingerprint(result.budget) !== budgetFingerprint(displayed)
              ) {
                options.set(b.id, {
                  loading: false,
                  error: 'Awaiting current budget configuration',
                });
                mismatch = true;
              } else {
                options.set(b.id, {
                  snapshot: result,
                  asOf: response.asOf,
                  receivedAt,
                  durationMs: receivedAt - started,
                  loading: false,
                  error: null,
                });
              }
            }
          } catch {
            if (!current()) break;
            for (const b of chunk)
              options.set(b.id, {
                ...options.entries()[b.id],
                loading: false,
                error: 'Budget progress is temporarily unavailable',
              });
          }
        }
        if (mismatch && !reconciled && current()) {
          reconciled = true;
          await options.reconcile();
          if (current()) queued = true;
        }
      } while (queued && options.active());
    };
    running = work().finally(() => {
      running = null;
    });
    return running;
  };
  return { load, cancel };
}
