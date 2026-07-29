/** Metering basis + counter-key semantics (split-subscription-spend).
 *
 * A budget meters money owed by default. Subscription traffic is prepaid at a flat rate,
 * so counting its API-rate cost would let a budget refuse requests over money the user
 * never spent — but notional value is also the product's only usage throttle, so the
 * choice is per budget and existing budgets keep their old behaviour.
 */
import { BudgetCache } from './budget-cache';
import type { BudgetRow, PersistencePort, Principal } from '@polyrouter/shared/server';

const PRINCIPAL: Principal = { kind: 'user', userId: 'u1' };

describe('BudgetCache — an in-flight load cannot resurrect pre-write state', () => {
  function cacheWith(rowsSeq: BudgetRow[][]): {
    cache: BudgetCache;
    release: (i: number) => void;
  } {
    const gates: (() => void)[] = [];
    let call = 0;
    const db = {
      budgets: {
        list: () => {
          const i = call++;
          return new Promise<BudgetRow[]>((resolve) => {
            gates[i] = () => resolve(rowsSeq[i] ?? []);
          });
        },
      },
    } as unknown as PersistencePort;
    const cache = new BudgetCache(db, { cacheTtlMs: 60_000, cacheMax: 10 } as never);
    return { cache, release: (i) => gates[i]?.() };
  }

  it('drops a store() from a load that a write superseded', async () => {
    const stale = [{ id: 'b1', meteringBasis: 'notional' } as unknown as BudgetRow];
    const fresh = [{ id: 'b1', meteringBasis: 'cash' } as unknown as BudgetRow];
    const { cache, release } = cacheWith([stale, fresh]);

    const inflight = cache.get(PRINCIPAL); // load #0 starts, reading pre-write rows
    cache.invalidate(PRINCIPAL); // a basis change lands
    release(0); // ...and only now does the old load resolve
    await inflight;

    const next = cache.get(PRINCIPAL); // must re-read, not serve the stale entry
    release(1);
    // Without generation stamping the superseded load repopulates the cache and the
    // budget keeps building its OLD basis key — and keeps blocking — for a full TTL.
    expect((await next)[0]?.meteringBasis).toBe('cash');
  });
});
