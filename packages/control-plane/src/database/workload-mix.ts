/**
 * Pure merge of the two workload-mix aggregations (add-workload-telemetry D6):
 * the in-range classified PARENT rows (requests, unpriced parents, cash-like
 * micro-dollars) and the in-range ATTEMPT rows joined to their — possibly
 * out-of-range — classified parent (cash-like micros, non-null-cost and
 * null-cost counts). The union of classes is reported (a class reachable only
 * through attempts carries `requests: 0`); costability follows the archived
 * null-is-unpriced / zero-is-free rule — `spendUsd` is null ONLY when no
 * component has a non-null cost, so an all-free class reads 0; ordering is
 * deterministic (requests desc, then class slug asc); revisions are the
 * in-range PARENT population only, lexicographic. Exported for unit tests.
 */
import type { WorkloadMix, WorkloadMixClass } from '@polyrouter/shared/server';

export interface WorkloadParentAgg {
  cls: string | null;
  requests: number | string;
  unpriced: number | string;
  micros: number | string;
}

export interface WorkloadAttemptAgg {
  cls: string | null;
  micros: number | string;
  costed: number | string;
  unpriced: number | string;
}

export interface WorkloadRevisionAgg {
  revision: string | null;
  requests: number | string;
}

interface Acc {
  requests: number;
  unpricedRequests: number;
  unpricedAttempts: number;
  costedAttempts: number;
  parentMicros: number;
  attemptMicros: number;
}

const n = (v: number | string): number => Number(v);

export function buildWorkloadMix(
  parents: readonly WorkloadParentAgg[],
  attempts: readonly WorkloadAttemptAgg[],
  unclassified: number | string,
  since: string | null,
  revisions: readonly WorkloadRevisionAgg[],
): WorkloadMix {
  const byClass = new Map<string, Acc>();
  const acc = (cls: string): Acc => {
    let a = byClass.get(cls);
    if (a === undefined) {
      a = {
        requests: 0,
        unpricedRequests: 0,
        unpricedAttempts: 0,
        costedAttempts: 0,
        parentMicros: 0,
        attemptMicros: 0,
      };
      byClass.set(cls, a);
    }
    return a;
  };
  let evaluated = 0;
  for (const p of parents) {
    if (p.cls === null) continue;
    const a = acc(p.cls);
    a.requests += n(p.requests);
    a.unpricedRequests += n(p.unpriced);
    a.parentMicros += n(p.micros);
    evaluated += n(p.requests);
  }
  for (const r of attempts) {
    if (r.cls === null) continue;
    const a = acc(r.cls);
    a.attemptMicros += n(r.micros);
    a.costedAttempts += n(r.costed);
    a.unpricedAttempts += n(r.unpriced);
  }
  const classes: WorkloadMixClass[] = [...byClass.entries()]
    .map(([cls, a]) => {
      const costable = a.requests - a.unpricedRequests > 0 || a.costedAttempts > 0;
      return {
        class: cls,
        requests: a.requests,
        unpricedRequests: a.unpricedRequests,
        unpricedAttempts: a.unpricedAttempts,
        // Dollars once, at the edge — both ledgers already rounded per row.
        spendUsd: costable ? (a.parentMicros + a.attemptMicros) / 1_000_000 : null,
      };
    })
    .sort(
      (x, y) => y.requests - x.requests || (x.class < y.class ? -1 : x.class > y.class ? 1 : 0),
    );
  const revs = revisions
    .filter((r): r is { revision: string; requests: number | string } => r.revision !== null)
    .map((r) => ({ revision: r.revision, requests: n(r.requests) }))
    .sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0));
  return { evaluated, unclassified: n(unclassified), since, revisions: revs, classes };
}
