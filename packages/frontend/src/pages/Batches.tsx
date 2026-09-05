import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { Icon } from '../components/Icon';
import { useModalSurface } from '../a11y';
import type { BatchJobDto } from '../data/api';
import { BATCH_POLL_MS, fmtElapsed } from '../data/batchBand';
import { createPoller } from '../data/poller';
import { useApp } from '../state/context';

/** One list, consumed by the head and by every row's stacked presentation, so the
 * two cannot drift — the requests table's rule. */
const COLUMNS = [
  'Status',
  'Model',
  'Provider',
  'Tier',
  'Submitted',
  'Progress',
  'Wall time',
  'Cost',
  'Results until',
  '',
] as const;

function Cell(props: { label: string; children: unknown }) {
  return (
    <span class="rs-cell">
      <span class="rs-cell-label" aria-hidden="true">
        {props.label}
      </span>
      {props.children as never}
    </span>
  );
}

const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled']);

/** What a job's status reads as on this page. The band's vocabulary, plus the
 * terminal words it never has to say. */
function statusLabel(job: BatchJobDto): string {
  switch (job.status) {
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
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired';
    case 'cancelled':
      return 'Cancelled';
    default:
      return job.status;
  }
}

/** The dot's colour. Amber and red are the locked SEMANTIC status hues; the word
 * beside them carries the state, so the colour is never the sole carrier. */
function statusColor(job: BatchJobDto): string {
  if (job.status === 'failed' || job.status === 'expired') return 'var(--red)';
  if (job.status === 'cancelling' || job.status === 'cancelled') return 'var(--amber)';
  if (job.status === 'completed') return 'var(--green)';
  if (job.status === 'submission_unknown') return 'var(--faint)';
  return 'var(--accent)';
}

const pulses = (job: BatchJobDto): boolean =>
  job.status === 'in_progress' ||
  job.status === 'cancelling' ||
  job.status === 'submission_unknown';

const fmtMoney = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * The Batches page (add-batch-inference Phase D).
 *
 * Everything a batch makes the user wonder about is a column here, because every
 * one of them is a question the request table cannot answer: how far along is it,
 * how long has it actually been running, what has it cost so far — and, the one
 * that is genuinely polyrouter's to disclose, how long the PROVIDER will still
 * serve its results. polyrouter stores none of them, so the retention window is
 * the provider's, and a job whose provider states none says so rather than
 * inventing a date.
 */
export function Batches(props: { live: boolean }) {
  const app = useApp();
  const [rows, setRows] = createSignal<BatchJobDto[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [confirming, setConfirming] = createSignal<BatchJobDto | null>(null);

  const load = async (): Promise<void> => {
    try {
      const page = await app.listBatches({ limit: 50 });
      setRows(page.rows);
      setError(null);
    } catch {
      // A failed read is not evidence that the jobs are gone: the last known list
      // stays on screen and the banner says it may be stale.
      setError('Could not refresh batches — showing the last known list.');
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void load());
  createPoller({ fn: () => load(), intervalMs: () => BATCH_POLL_MS, enabled: () => props.live });

  const active = createMemo(() => rows().filter((r) => !TERMINAL.has(r.status)).length);

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div class="rs-wrap" style="display:flex;align-items:baseline;gap:10px">
        <div>
          <div class="section-title">Batches</div>
          {/* The one disclosure this page exists to make. */}
          <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);margin-top:3px">
            polyrouter stores no results — they stay with the provider until its retention window
            ends, and are streamed through on demand.
          </div>
        </div>
        <div style="margin-left:auto;font:400 11.5px 'Geist',sans-serif;color:var(--text3)">
          {rows().length} shown · {active()} running
        </div>
      </div>

      <Show when={error()}>
        {(msg) => (
          <div
            role="status"
            style="padding:9px 14px;border:1px solid var(--border);border-radius:10px;background:var(--panel);font:400 12px 'Geist',sans-serif;color:var(--text2)"
          >
            {msg()}
          </div>
        )}
      </Show>

      <div class="panel rs-table-panel rs-table-batches" style="overflow:hidden;border-radius:10px">
        <div class="table-head">
          <For each={COLUMNS}>{(c) => <div>{c}</div>}</For>
        </div>
        <Show
          when={rows().length > 0}
          fallback={
            <div style="padding:16px 18px;font:400 12px 'Geist',sans-serif;color:var(--text3)">
              {loading()
                ? 'Loading…'
                : 'No batches yet. Submit one to POST /v1/batches with the same agent key your requests use.'}
            </div>
          }
        >
          <For each={rows()}>{(job) => <Row job={job} onCancel={() => setConfirming(job)} />}</For>
        </Show>
      </div>

      <Show when={confirming()} keyed>
        {(job) => (
          <CancelDialog job={job} onClose={() => setConfirming(null)} onDone={() => void load()} />
        )}
      </Show>
    </div>
  );
}

function Row(props: { job: BatchJobDto; onCancel: () => void }) {
  const job = (): BatchJobDto => props.job;
  const terminal = (): boolean => TERMINAL.has(job().status);
  const done = (): number => job().counts.completed + job().counts.failed;
  const pct = (): number =>
    job().counts.total === 0 ? 0 : Math.min(100, Math.round((done() / job().counts.total) * 100));
  /** The wall time the CALLER experienced: to settlement if it ended, else to now. */
  const wall = (): number =>
    (job().terminalAt === null ? Date.now() : Date.parse(job().terminalAt!)) -
    Date.parse(job().submittedAt);

  return (
    <div class="rs-batch-row" data-batch-job={job().id}>
      <Cell label="Status">
        <span style="display:flex;align-items:center;gap:6px;min-width:0">
          <span
            aria-hidden="true"
            style={{
              width: '6px',
              height: '6px',
              'border-radius': '50%',
              flex: 'none',
              background: statusColor(job()),
              ...(pulses(job()) ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}),
            }}
          />
          <span style="color:var(--text)">{statusLabel(job())}</span>
        </span>
      </Cell>
      <Cell label="Model">
        <span class="mono" style="font-size:11.5px;color:var(--text)">
          {job().modelLabel ?? job().modelId}
        </span>
      </Cell>
      <Cell label="Provider">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          {job().providerLabel ?? job().providerId}
        </span>
      </Cell>
      <Cell label="Tier">
        <span>{job().tierAssigned ?? '—'}</span>
      </Cell>
      <Cell label="Submitted">
        <span class="mono" style="font-size:11px;color:var(--text3)">
          {fmtDateTime(job().submittedAt)}
        </span>
      </Cell>
      <Cell label="Progress">
        <span style="display:flex;flex-direction:column;gap:4px;min-width:0;width:100%">
          <span class="rs-batch-bar" aria-hidden="true">
            <span style={{ width: `${String(pct())}%` }} />
          </span>
          <span class="mono" style="font-size:10.5px;color:var(--text3)">
            {done()} / {job().counts.total}
          </span>
          {/* Two states where the raw count would mislead. A lost submission reads
              `0 / N` — and the thing the user needs to know is that it cost nothing. */}
          <Show when={job().errorKind === 'submit_lost' || job().errorKind === 'submit_unresolved'}>
            <span style="font-size:10.5px;color:var(--text3)">
              submission lost — nothing charged
            </span>
          </Show>
          <Show when={job().status === 'submission_unknown'}>
            <span style="font-size:10.5px;color:var(--text3)">reconciling with provider</span>
          </Show>
        </span>
      </Cell>
      <Cell label="Wall time">
        <span class="mono" style="font-size:11px">
          {fmtElapsed(wall())}
        </span>
      </Cell>
      <Cell label="Cost">
        <span style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <Show
            when={terminal()}
            fallback={
              <>
                {/* A ceiling, not a charge. The caption is not decoration: without it
                    the number reads as money already spent (D13). Written out rather
                    than as `≤` — the bundled fonts have no U+2264, so that glyph
                    would come from the viewer's operating system. */}
                <span class="mono" style="font-size:11px;color:var(--text2)">
                  {job().reservedCeilingMicros === null
                    ? 'unbounded'
                    : `up to ${fmtMoney(job().reservedCeilingMicros!)}`}
                </span>
                <span style="font-size:10.5px;color:var(--text3)">reserved, not spent</span>
              </>
            }
          >
            <span class="mono" style="font-size:11px;color:var(--text)">
              {(() => {
                const micros = job().settledCostMicros;
                return micros === null ? '—' : fmtMoney(micros);
              })()}
            </span>
          </Show>
        </span>
      </Cell>
      <Cell label="Results until">
        <Show
          when={job().resultsExpireAt}
          fallback={
            <span style="font-size:11px;color:var(--text3)">
              retention unknown — check provider
            </span>
          }
        >
          {(iso) => (
            <span class="mono" style="font-size:11px;color:var(--text2)">
              {fmtDate(iso())} · {job().providerLabel ?? job().providerId}
            </span>
          )}
        </Show>
      </Cell>
      <Cell label="">
        <Show when={!terminal()}>
          {/* Every active row's button reads "Cancel", so on its own the name tells a
              screen-reader user nothing about WHICH batch they are about to abandon.
              The visible word stays short; the accessible name carries the job. */}
          <button
            type="button"
            class="btn-ghost"
            style="font:500 11.5px 'Geist',sans-serif"
            aria-label={`Cancel batch on ${job().modelLabel ?? job().modelId}`}
            onClick={props.onCancel}
          >
            Cancel
          </button>
        </Show>
      </Cell>
    </div>
  );
}

/** Cancelling is destructive — the items still running are abandoned — so it goes
 * through the same modal-surface contract every other destructive action uses:
 * a real focus trap, Escape, focus restore and layer registration. */
function CancelDialog(props: { job: BatchJobDto; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const surface = useModalSurface(app, {
    when: () => true,
    label: 'Cancel batch',
    onDismiss: () => props.onClose(),
  });
  const remaining = (): number =>
    Math.max(0, props.job.counts.total - props.job.counts.completed - props.job.counts.failed);
  return (
    <div class="overlay" style={{ 'z-index': String(surface.z().backdrop) }}>
      <div
        class="panel card confirm-card"
        {...surface.props}
        style={{ 'z-index': String(surface.z().surface) }}
      >
        <div class="section-title" style="margin-bottom:8px">
          Cancel this batch?
        </div>
        <div style="font:400 12px 'Geist',sans-serif;color:var(--text2);line-height:1.55;margin-bottom:12px">
          {remaining()} of {props.job.counts.total} requests have not run yet. Cancelling asks the
          provider to stop; anything it already completed is still recorded and still charged. The
          reserved budget is released once that settles.
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" class="btn-cancel" onClick={() => props.onClose()}>
            Keep running
          </button>
          <button
            type="button"
            class="btn-primary"
            disabled={busy()}
            onClick={() => {
              setBusy(true);
              void app
                .cancelBatch(props.job.id)
                .then(() => {
                  props.onClose();
                  props.onDone();
                })
                .catch(() => setBusy(false));
            }}
          >
            <Icon name="close" size={12} /> Cancel batch
          </button>
        </div>
      </div>
    </div>
  );
}
