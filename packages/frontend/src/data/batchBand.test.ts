// add-batch-inference task 5.1: the batch partition is its own fold. These are the
// four properties the two-partition design exists to guarantee.
import { describe, expect, it } from 'vitest';
import type { BatchJobDto } from './api';
import {
  BATCH_GRACE_MS,
  batchDisplay,
  batchProgressLabel,
  batchRowKey,
  batchStatusLabel,
  emptyBatchBand,
  fmtElapsed,
  foldBatch,
  reconcileBatch,
} from './batchBand';
import { foldInflight, emptyInflight, inflightDisplay } from './inflight';
import type { InflightRow } from './api';

const job = (id: string, over: Partial<BatchJobDto> = {}): BatchJobDto => ({
  id,
  upstreamBatchId: `up-${id}`,
  status: 'in_progress',
  terminal: false,
  endpoint: '/v1/chat/completions',
  agentId: 'ag',
  providerId: 'p1',
  providerLabel: 'OpenRouter',
  modelId: 'm1',
  modelLabel: 'gpt-4o',
  tierAssigned: null,
  counts: { total: 10, completed: 3, failed: 0 },
  submittedAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:05:00.000Z',
  terminalAt: null,
  reservedCeilingMicros: 1_000,
  settledCostMicros: null,
  resultsExpireAt: null,
  errorKind: null,
  ...over,
});
const read = (rows: BatchJobDto[], available = true) => ({ rows, available });
const NONE: ReadonlySet<string> = new Set();

describe('the batch partition is separate from the in-flight one', () => {
  it('an in-flight snapshot cannot settle a job row', () => {
    const band = foldBatch(emptyBatchBand(), read([job('j1')]), NONE, 0).next;
    expect(batchDisplay(band, NONE)).toHaveLength(1);
    // An authoritative in-flight snapshot that mentions nothing at all…
    const inflight = foldInflight(
      emptyInflight(),
      { items: [], available: true, truncated: false },
      NONE,
      0,
    );
    expect(inflight.next.settling).toEqual([]);
    // …leaves the batch band exactly as it was: different state, different fold.
    expect(batchDisplay(band, NONE).map((r) => r.id)).toEqual(['j1']);
  });

  it('a batch read cannot settle a request row', () => {
    const running: InflightRow = {
      id: 'r1',
      startedAt: 1_000,
      decisionLayer: 'explicit',
      tierAssigned: null,
      modelId: 'm',
      modelLabel: 'gpt-4o',
      providerId: 'p',
      providerLabel: 'OpenRouter',
      status: 'running',
      protocol: 'openai',
    } as unknown as InflightRow;
    const live = foldInflight(
      emptyInflight(),
      { items: [running], available: true, truncated: false },
      NONE,
      0,
    ).next;
    // A batch read naming nothing does not touch the in-flight state.
    foldBatch(emptyBatchBand(), read([]), NONE, 0);
    expect(inflightDisplay(live, NONE).map((r) => r.id)).toEqual(['r1']);
  });

  it('a job row can never collide with a request row: its key is namespaced', () => {
    const band = foldBatch(emptyBatchBand(), read([job('shared-id')]), NONE, 0).next;
    const [row] = batchDisplay(band, NONE);
    expect(row!.key).toBe('batch:shared-id');
    expect(row!.key).not.toBe('shared-id');
    expect(batchRowKey('x')).toBe('batch:x');
  });
});

describe('foldBatch', () => {
  it('bridges a job that leaves the active read, and reports it for the existence check', () => {
    const first = foldBatch(emptyBatchBand(), read([job('j1'), job('j2')]), NONE, 0);
    expect(first.settledIds).toEqual([]);
    const second = foldBatch(first.next, read([job('j2')]), NONE, 1_000);
    expect(second.settledIds).toEqual(['j1']);
    const rows = batchDisplay(second.next, NONE);
    expect(rows.map((r) => [r.id, r.phase])).toEqual([
      ['j1', 'settling'],
      ['j2', 'live'],
    ]);
  });

  it('bridges a terminal job present in the read, and never renders it as live', () => {
    const { next, settledIds } = foldBatch(
      emptyBatchBand(),
      read([job('t1', { terminal: true, status: 'completed' })]),
      NONE,
      0,
    );
    expect(settledIds).toEqual(['t1']);
    expect(batchDisplay(next, NONE)[0]!.phase).toBe('settling');
  });

  it('a degraded read retains the cached rows and settles nothing', () => {
    const first = foldBatch(emptyBatchBand(), read([job('j1')]), NONE, 0).next;
    const degraded = foldBatch(first, read([], false), NONE, 1_000);
    expect(degraded.settledIds).toEqual([]);
    expect(batchDisplay(degraded.next, NONE).map((r) => [r.id, r.phase])).toEqual([['j1', 'live']]);
  });

  it('drops a bridged job when its items arrive, or when the grace expires', () => {
    const first = foldBatch(emptyBatchBand(), read([job('j1')]), NONE, 0).next;
    const bridged = foldBatch(first, read([]), NONE, 1_000).next;
    expect(batchDisplay(bridged, NONE)).toHaveLength(1);
    // The existence read found its items.
    expect(batchDisplay(reconcileBatch(bridged, new Set(['j1'])), new Set(['j1']))).toEqual([]);
    // Or nothing ever arrives (a job that ran no items) — the grace retires it.
    const expired = foldBatch(bridged, read([]), NONE, 1_000 + BATCH_GRACE_MS + 1);
    expect(batchDisplay(expired.next, NONE)).toEqual([]);
  });

  it('never bridges the same job twice, however many reads pass', () => {
    let s = foldBatch(emptyBatchBand(), read([job('j1')]), NONE, 0).next;
    s = foldBatch(s, read([]), NONE, 1_000).next;
    for (const t of [2_000, 3_000, 4_000]) {
      const r = foldBatch(s, read([]), NONE, t);
      expect(r.settledIds).toEqual([]);
      s = r.next;
    }
    expect(s.settling).toHaveLength(1);
  });

  it('sorts newest-submitted first across both halves', () => {
    const older = job('old', { submittedAt: '2026-09-05T09:00:00.000Z' });
    const newer = job('new', { submittedAt: '2026-09-05T11:00:00.000Z' });
    const s = foldBatch(emptyBatchBand(), read([older, newer]), NONE, 0).next;
    expect(batchDisplay(s, NONE).map((r) => r.id)).toEqual(['new', 'old']);
  });
});

describe('the job row’s reading', () => {
  it.each([
    ['submitting', 'Queued'],
    ['validating', 'Queued'],
    ['submission_unknown', 'Reconciling'],
    ['in_progress', 'In progress'],
    ['finalizing', 'Finalizing'],
    ['cancelling', 'Cancelling'],
  ])('reads %s as %s', (status, label) => {
    const s = foldBatch(emptyBatchBand(), read([job('j', { status })]), NONE, 0).next;
    expect(batchStatusLabel(batchDisplay(s, NONE)[0]!)).toBe(label);
  });

  it('reads a bridged job as Finishing, the same word a settling request uses', () => {
    let s = foldBatch(emptyBatchBand(), read([job('j')]), NONE, 0).next;
    s = foldBatch(s, read([]), NONE, 1).next;
    const row = batchDisplay(s, NONE)[0]!;
    expect(batchStatusLabel(row)).toBe('Finishing');
    expect(batchProgressLabel(row)).toBeNull(); // no count once it is finishing
  });

  it('counts progress only once something has finished', () => {
    const none = foldBatch(
      emptyBatchBand(),
      read([job('a', { counts: { total: 5, completed: 0, failed: 0 } })]),
      NONE,
      0,
    ).next;
    expect(batchProgressLabel(batchDisplay(none, NONE)[0]!)).toBeNull();
    const some = foldBatch(
      emptyBatchBand(),
      read([job('b', { counts: { total: 50, completed: 11, failed: 1 } })]),
      NONE,
      0,
    ).next;
    expect(batchProgressLabel(batchDisplay(some, NONE)[0]!)).toBe('12 of 50');
  });

  it('formats elapsed time as a job, not as a request', () => {
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(45_000)).toBe('45s');
    expect(fmtElapsed(60_000)).toBe('1m');
    expect(fmtElapsed(59 * 60_000)).toBe('59m');
    expect(fmtElapsed(60 * 60_000)).toBe('1h 0m');
    expect(fmtElapsed(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
    expect(fmtElapsed(-1)).toBe('0s');
  });
});
