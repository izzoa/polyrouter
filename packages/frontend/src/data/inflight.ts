import type { InflightRow, InflightSnapshot } from './api';

/** How long a just-settled row is retained (bridging the ≤1s writer-flush gap)
 * while its durable row loads, before it is dropped (add-inflight-requests). */
export const INFLIGHT_GRACE_MS = 8_000;

/** Live-poll cadences (phase1-tune-dashboard-polling). */
export const INFLIGHT_FAST_MS = 2_500;
export const INFLIGHT_IDLE_MS = 5_000;

/**
 * The live poll's state-dependent cadence: a shallow relaxation while provably
 * empty, snapping back to fast the moment any row is observed. PURE, so the
 * predicate is unit-testable.
 *
 * `rowCount` is the reactive display count (`state.inflightRows.length`). That
 * satisfies the spec's "no live rows AND no cached live rows": the fold state is
 * closure-private and non-reactive, and the only cached rows `inflightDisplay`
 * hides are ids already present as durable rows — i.e. already settled. So no
 * reachable state with a still-running cached row reads as idle, and the
 * settle-observed handoff (which by definition has a cached row) always runs at
 * the fast cadence.
 */
export function inflightCadenceMs(rowCount: number): number {
  return rowCount === 0 ? INFLIGHT_IDLE_MS : INFLIGHT_FAST_MS;
}

export interface InflightState {
  /** Items from the last AUTHORITATIVE (`available`) poll — the current live set. */
  live: InflightRow[];
  /** Rows that dropped from an authoritative, NON-truncated poll and are awaiting
   * their durable row. They bridge the flush gap; pruned on durable arrival or grace. */
  settling: { row: InflightRow; at: number }[];
}

export const emptyInflight = (): InflightState => ({ live: [], settling: [] });

/** Fold a new snapshot into the state. PURE. Returns the next state and whether a
 * durable refresh should be triggered (a settle was observed). `recentIds` = the
 * durable row ids currently loaded (durable always wins → dedupe/drop).
 *
 * Continuity rule: settlement is inferred ONLY from an authoritative, non-truncated
 * snapshot. An `available:false` (degraded) or `truncated:true` poll is NOT evidence
 * that an absent row ended — the cached rows are retained. */
export function foldInflight(
  prev: InflightState,
  snap: InflightSnapshot,
  recentIds: ReadonlySet<string>,
  now: number,
): { next: InflightState; refresh: boolean } {
  if (!snap.available) {
    // Degraded poll: retain the live set + settling; never settle on this.
    return { next: prune(prev, recentIds, now), refresh: false };
  }
  const nextIds = new Set(snap.items.map((r) => r.id));
  const settling = [...prev.settling];
  let refresh = false;
  if (!snap.truncated) {
    for (const r of prev.live) {
      const gone = !nextIds.has(r.id);
      const already = recentIds.has(r.id) || settling.some((s) => s.row.id === r.id);
      if (gone && !already) {
        settling.push({ row: r, at: now }); // settle observed → bridge + refresh
        refresh = true;
      }
    }
  }
  return { next: prune({ live: snap.items, settling }, recentIds, now), refresh };
}

/** Drop settling rows whose durable row has arrived or whose grace has expired. */
function prune(s: InflightState, recentIds: ReadonlySet<string>, now: number): InflightState {
  return {
    live: s.live,
    settling: s.settling.filter((x) => !recentIds.has(x.row.id) && now - x.at < INFLIGHT_GRACE_MS),
  };
}

/** Recompute after the durable list refreshes: drop settling rows now covered by a
 * durable row (never double-shown). PURE. */
export function reconcile(s: InflightState, recentIds: ReadonlySet<string>): InflightState {
  return { live: s.live, settling: s.settling.filter((x) => !recentIds.has(x.row.id)) };
}

/** Rows to render ABOVE the completed list: settling (bridge) then live, minus any
 * id already present as a durable row (never double-shown), newest-first. PURE. */
export function inflightDisplay(s: InflightState, recentIds: ReadonlySet<string>): InflightRow[] {
  const seen = new Set<string>();
  const out: InflightRow[] = [];
  for (const x of s.settling) {
    if (recentIds.has(x.row.id) || seen.has(x.row.id)) continue;
    seen.add(x.row.id);
    out.push(x.row);
  }
  for (const r of s.live) {
    if (recentIds.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
