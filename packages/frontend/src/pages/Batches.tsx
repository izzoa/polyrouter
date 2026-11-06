import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import type { BatchJobDto } from '../data/api';
import { BATCH_POLL_MS, fmtElapsed } from '../data/batchBand';
import { ceilingMoney, costParts, money, RESERVED_LABEL } from '../data/figures';
import { createPoller } from '../data/poller';
import { FigureText } from '../components/FigureText';
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

/** The figure columns: right-aligned in the head as in every row (task 9.2). */
const FIGURE_COLUMNS: ReadonlySet<string> = new Set(['Wall time', 'Cost']);

type Column = (typeof COLUMNS)[number];

/** Each column's class (add-docked-inspector design D11), on the head cell and on every row's
 * cell, so the priority forms place cells and hide moved head labels by column. */
const COLUMN_CLASS: Record<Column, string> = {
  Status: 'rs-col-status',
  Model: 'rs-col-model',
  Provider: 'rs-col-provider',
  Tier: 'rs-col-tier',
  Submitted: 'rs-col-submitted',
  Progress: 'rs-col-progress',
  'Wall time': 'rs-col-wall',
  Cost: 'rs-col-cost',
  'Results until': 'rs-col-until',
  '': 'rs-col-action',
};

function Cell(props: { label: Column; children: unknown }) {
  return (
    <span class={`rs-cell ${COLUMN_CLASS[props.label]}`}>
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
 * beside them carries the state, so the colour is never the sole carrier. A running or
 * queued job is neutral (`--text3`), never indigo: the page's one indigo series is its
 * progress fill (the Indigo Budget, adopt-design-tokens-v2 D11). */
function statusColor(job: BatchJobDto): string {
  if (job.status === 'failed' || job.status === 'expired') return 'var(--red)';
  if (job.status === 'cancelling' || job.status === 'cancelled') return 'var(--amber)';
  if (job.status === 'completed') return 'var(--green)';
  if (job.status === 'submission_unknown') return 'var(--faint)';
  return 'var(--text3)';
}

const pulses = (job: BatchJobDto): boolean =>
  job.status === 'in_progress' ||
  job.status === 'cancelling' ||
  job.status === 'submission_unknown';

/** A terminal job's null settled cost: the bare word `unpriced` in Ink 3, never a dash. */
const UNPRICED_PARTS = costParts({ kind: 'unpriced' });
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
  /** The table: where focus lands when a cancel's reload took the row whose Cancel opened
   * the confirmation (D8). */
  let table: HTMLDivElement | undefined;

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

  /** Cancelling is destructive — the items still running are abandoned — so it asks first,
   * in the shared destructive confirmation (adopt-red-destructive-actions D6), which holds
   * its focus trap, Escape, busy and failure. It keeps its own name, `Cancel batch`, which
   * selectors and pins key on, and its title, body and dismiss label are unchanged. The
   * commit stays busy through the reload, so the list it closes onto already shows the job
   * cancelling. The reload is a read, not part of what the dialog asked: once the cancel is
   * accepted, the dialog closes even if the reload fails, because an alert saying the cancel
   * failed would be untrue. That failure is the page's, reported as every failed refresh is,
   * by the banner saying the list may be stale. */
  const cancel = (job: BatchJobDto): void => {
    const remaining = Math.max(0, job.counts.total - job.counts.completed - job.counts.failed);
    app.confirmDestructive({
      title: 'Cancel this batch?',
      body:
        `${String(remaining)} of ${String(job.counts.total)} requests have not run yet. ` +
        'Cancelling asks the provider to stop; anything it already completed is still recorded ' +
        'and still charged. The reserved budget is released once that settles.',
      label: 'Cancel batch',
      dismissLabel: 'Keep running',
      commitLabel: 'Cancel batch',
      busyLabel: 'Cancelling…',
      run: async () => {
        await app.cancelBatch(job.id);
        await load();
      },
      fallbackFocus: () => table ?? null,
    });
  };

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      <div class="rs-wrap" style="display:flex;align-items:baseline;gap:8px">
        <div>
          <div class="section-title">Batches</div>
          {/* The one disclosure this page exists to make. */}
          <div class="t-caption" style="color:var(--text3);margin-top:4px">
            polyrouter stores no results — they stay with the provider until its retention window
            ends, and are streamed through on demand.
          </div>
        </div>
        <div class="t-caption" style="margin-left:auto;color:var(--text3)">
          {rows().length} shown · {active()} running
        </div>
      </div>

      <Show when={error()}>
        {(msg) => (
          <div
            role="status"
            class="t-dense"
            style="padding:8px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel);color:var(--text2)"
          >
            {msg()}
          </div>
        )}
      </Show>

      {/* A named group, focusable from script only: a cancelled row's landing spot (D8). */}
      <div
        ref={(el) => {
          table = el;
        }}
        class="panel rs-table-panel rs-table-batches"
        role="group"
        aria-label="Batches"
        tabindex="-1"
        style="overflow:hidden;border-radius:10px"
      >
        {/* Flat, one element per column in `COLUMNS` order: a narrowed form hides the head
            labels of the columns it moves to line two (design D11). */}
        <div class="table-head">
          <For each={COLUMNS}>
            {(c) => (
              <div
                class={FIGURE_COLUMNS.has(c) ? `${COLUMN_CLASS[c]} cell-figure` : COLUMN_CLASS[c]}
                title={c === '' ? undefined : c}
              >
                {c}
              </div>
            )}
          </For>
        </div>
        <Show
          when={rows().length > 0}
          fallback={
            <div class="t-dense" style="padding:16px;color:var(--text3)">
              {loading()
                ? 'Loading…'
                : 'No batches yet. Submit one to POST /v1/batches with the same agent key your requests use.'}
            </div>
          }
        >
          <For each={rows()}>{(job) => <Row job={job} onCancel={() => cancel(job)} />}</For>
        </Show>
      </div>
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
      {/* Priority one first — status, model, submitted, cost — then the second line's wrapper,
          then the row action, which stays on line one in every form. Explicit placement keeps
          today's column order on line one (design D11). */}
      <Cell label="Status">
        <span style="display:flex;align-items:center;gap:8px;min-width:0">
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
      {/* Identifiers: cut with an end ellipsis on one line, keeping the full text as
          content and as the title (task 9.2). */}
      <Cell label="Model">
        <span
          class="mono cell-id"
          style="font-size:0.75rem;color:var(--text)"
          title={job().modelLabel ?? job().modelId}
        >
          {job().modelLabel ?? job().modelId}
        </span>
      </Cell>
      <Cell label="Submitted">
        <span class="figure" style="font-size:0.6875rem;color:var(--text3)">
          {fmtDateTime(job().submittedAt)}
        </span>
      </Cell>
      <Cell label="Cost">
        <span
          class="cell-figure"
          style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:0"
        >
          <Show
            when={terminal()}
            fallback={
              <>
                {/* A ceiling, not a charge. The caption is not decoration: without it
                    the number reads as money already spent (D13). A bound, so it reads
                    `≤ $x` at cents rounded UP, never down (adopt-figure-states D2), in
                    Ink 2; the bundled fonts carry U+2264 (D7). */}
                <span class="figure" style="font-size:0.6875rem;color:var(--text2)">
                  {job().reservedCeilingMicros === null
                    ? 'unbounded'
                    : `≤ ${ceilingMoney(job().reservedCeilingMicros!)}`}
                </span>
                <span style="font-size:0.6875rem;color:var(--text3)">{RESERVED_LABEL}</span>
              </>
            }
          >
            {/* The settled cost at four decimals, so it reconciles with its items in the
                Requests table (adopt-figure-states D2); a null one is `unpriced`. */}
            <span class="figure" style="font-size:0.6875rem;color:var(--text)">
              {(() => {
                // A measured zero settles as `$0.0000`; only null is unpriced.
                const micros = job().settledCostMicros;
                return micros === null ? (
                  <FigureText parts={UNPRICED_PARTS} />
                ) : (
                  money(micros, 'four')
                );
              })()}
            </span>
          </Show>
        </span>
      </Cell>
      <span class="rs-subline">
        <span class="rs-sub-p3">
          <Cell label="Provider">
            <span class="cell-id" title={job().providerLabel ?? job().providerId}>
              {job().providerLabel ?? job().providerId}
            </span>
          </Cell>
          <Cell label="Tier">
            <span class="cell-id" title={job().tierAssigned ?? undefined}>
              {job().tierAssigned ?? '—'}
            </span>
          </Cell>
          <Cell label="Results until">
            <Show
              when={job().resultsExpireAt}
              fallback={
                <span style="font-size:0.6875rem;color:var(--text3)">
                  retention unknown — check provider
                </span>
              }
            >
              {(iso) => (
                <span class="figure" style="font-size:0.6875rem;color:var(--text2)">
                  {fmtDate(iso())} · {job().providerLabel ?? job().providerId}
                </span>
              )}
            </Show>
          </Cell>
        </span>
        <span class="rs-sub-p2">
          <Cell label="Progress">
            <span style="display:flex;flex-direction:column;gap:4px;min-width:0;width:100%">
              <span
                class="rs-batch-bar"
                aria-hidden="true"
                data-series="focal"
                data-measure="batch-progress"
              >
                <span style={{ width: `${String(pct())}%` }} />
              </span>
              <span class="figure" style="font-size:0.6875rem;color:var(--text3)">
                {done()} / {job().counts.total}
              </span>
              {/* Two states where the raw count would mislead. A lost submission reads
                  `0 / N` — and the thing the user needs to know is that it cost nothing. */}
              <Show
                when={job().errorKind === 'submit_lost' || job().errorKind === 'submit_unresolved'}
              >
                <span style="font-size:0.6875rem;color:var(--text3)">
                  submission lost — nothing charged
                </span>
              </Show>
              <Show when={job().status === 'submission_unknown'}>
                <span style="font-size:0.6875rem;color:var(--text3)">
                  reconciling with provider
                </span>
              </Show>
            </span>
          </Cell>
          <Cell label="Wall time">
            <span class="figure cell-figure" style="font-size:0.6875rem">
              {fmtElapsed(wall())}
            </span>
          </Cell>
        </span>
      </span>
      <Cell label="">
        <Show when={!terminal()}>
          {/* Every active row's button reads "Cancel", so on its own the name tells a
              screen-reader user nothing about WHICH batch they are about to abandon.
              The visible word stays short; the accessible name carries the job. */}
          <button
            type="button"
            class="btn-ghost btn-ghost--destructive"
            style="font:500 0.75rem/1rem 'Geist',sans-serif"
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
