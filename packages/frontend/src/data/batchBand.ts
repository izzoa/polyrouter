/**
 * The live-row band's BATCH partition (add-batch-inference D11, task 5.1).
 *
 * Deliberately its own fold, beside the in-flight one, because the two carry
 * different evidence and must never settle each other. `foldInflight` replaces
 * the whole live set from each snapshot, so a batch job riding it would be
 * "settled" by any in-flight poll that did not mention it — and an in-flight
 * entry would be settled by a batch read. Two partitions, two authoritative
 * reads, combined only at render.
 *
 * Rows are keyed `batch:<id>` so a job can never collide with a request id, on
 * any surface, whatever the two id spaces do.
 */
import type { BatchJobDto } from './api';

/** How long a terminal job is retained while its settled item rows are written
 * and become visible. Matches the in-flight bridge's grace: the same "the durable
 * record is on its way" situation, one level up. */
export const BATCH_GRACE_MS = 12_000;

/** The band's own cadence. A batch advances over minutes or hours, so polling it
 * as fast as an in-flight request would be noise; the nudge covers the moments
 * that matter (D18). */
export const BATCH_POLL_MS = 15_000;

export interface BatchBandState {
  /** Non-terminal jobs from the last AUTHORITATIVE read. */
  live: BatchJobDto[];
  /** Jobs observed terminal, retained while their item rows land. */
  settling: { row: BatchJobDto; at: number }[];
}

export const emptyBatchBand = (): BatchBandState => ({ live: [], settling: [] });

/** The render key for a job row — never a bare id (D11). */
export const batchRowKey = (id: string): string => `batch:${id}`;

/**
 * Fold an authoritative active-jobs read. PURE.
 *
 * `available: false` is a DEGRADED read (the request failed): the cached rows are
 * retained and nothing is settled, exactly as the in-flight fold treats a
 * degraded snapshot — an absent row is not evidence that a job ended.
 *
 * `handedOff` are job ids whose settled items are already visible, so a job that
 * has fully handed off is dropped rather than bridged.
 */
export function foldBatch(
  prev: BatchBandState,
  read: { rows: readonly BatchJobDto[]; available: boolean },
  handedOff: ReadonlySet<string>,
  now: number,
): { next: BatchBandState; settledIds: string[] } {
  if (!read.available) return { next: prune(prev, handedOff, now), settledIds: [] };
  const liveIds = new Set(read.rows.map((r) => r.id));
  const settling = [...prev.settling];
  const settledIds: string[] = [];
  for (const job of prev.live) {
    const gone = !liveIds.has(job.id);
    const already = handedOff.has(job.id) || settling.some((s) => s.row.id === job.id);
    if (!gone || already) continue;
    // The row we bridge is the LAST live view of the job; its counts are the most
    // recent the band saw. The authoritative record is the item rows now landing.
    settling.push({ row: job, at: now });
    settledIds.push(job.id);
  }
  // A terminal job present in the read (a listing that includes terminal rows)
  // bridges too — the band never renders a terminal job as live.
  const live: BatchJobDto[] = [];
  for (const r of read.rows) {
    if (!r.terminal) {
      live.push(r);
      continue;
    }
    if (handedOff.has(r.id) || settling.some((s) => s.row.id === r.id)) continue;
    settling.push({ row: r, at: now });
    settledIds.push(r.id);
  }
  return { next: prune({ live, settling }, handedOff, now), settledIds };
}

/** Drop bridged jobs whose items have arrived or whose grace has expired. A job
 * that ended with NO items (a cancelled-before-anything-ran, a lost submission)
 * is never covered by an item row, so the grace is what retires it. */
function prune(s: BatchBandState, handedOff: ReadonlySet<string>, now: number): BatchBandState {
  return {
    live: s.live,
    settling: s.settling.filter((x) => !handedOff.has(x.row.id) && now - x.at < BATCH_GRACE_MS),
  };
}

/** Recompute after an existence read proves a job's items are visible. PURE. */
export function reconcileBatch(s: BatchBandState, handedOff: ReadonlySet<string>): BatchBandState {
  return { live: s.live, settling: s.settling.filter((x) => !handedOff.has(x.row.id)) };
}

/** Which half of the fold a rendered job came from. A `settling` job has reached a
 * terminal status and its item rows are being written — saying "in progress" there
 * would assert an outcome already decided. */
export type BatchPhase = 'live' | 'settling';

export interface BatchDisplayRow extends BatchJobDto {
  readonly phase: BatchPhase;
  /** `batch:<id>` — the render key, never a bare id. */
  readonly key: string;
}

/** Jobs to render above the completed list: settling first, then live, newest
 * submitted first. PURE. */
export function batchDisplay(s: BatchBandState, handedOff: ReadonlySet<string>): BatchDisplayRow[] {
  const seen = new Set<string>();
  const out: BatchDisplayRow[] = [];
  const push = (row: BatchJobDto, phase: BatchPhase): void => {
    if (handedOff.has(row.id) || seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ ...row, phase, key: batchRowKey(row.id) });
  };
  for (const x of s.settling) push(x.row, 'settling');
  for (const r of s.live) push(r, 'live');
  return out.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
}

/** The label a job's status reads as in the band (D11a). `Reconciling` is the
 * `submission_unknown` state — polyrouter cannot yet confirm the provider took
 * the job — and `Finishing` is the settling bridge, shared with a request row so
 * the two never describe the same situation with different words. */
export function batchStatusLabel(row: BatchDisplayRow): string {
  if (row.phase === 'settling') return 'Finishing';
  switch (row.status) {
    case 'submitting':
    case 'validating':
      return 'Queued';
    case 'submission_unknown':
      return 'Reconciling';
    case 'in_progress':
      return 'In progress';
    case 'finalizing':
      return 'Finalizing';
    case 'cancelling':
      return 'Cancelling';
    default:
      return row.status;
  }
}

/** The `N of M` progress line, or null when there is nothing to count yet. Shown
 * on its OWN line beneath the status so it cannot widen the status column. */
export function batchProgressLabel(row: BatchDisplayRow): string | null {
  const done = row.counts.completed + row.counts.failed;
  if (row.phase === 'settling' || done === 0) return null;
  return `${String(done)} of ${String(row.counts.total)}`;
}

/** Elapsed wall time, formatted for a job rather than a request: seconds up to a
 * minute, then `m`, then `h m`. A batch runs for hours; `7412.3s` is not a reading. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  return `${String(h)}h ${String(m % 60)}m`;
}
