import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from 'solid-js';
import { Chart } from '../components/Chart';
import { ModelPicker } from '../components/ModelPicker';
import { createHeldFailure, Notice } from '../components/Notice';
import { RangeSelector } from '../components/RangeSelector';
import { Segmented } from '../components/Segmented';
import { Toggle } from '../components/Toggle';
import { BatchModeHelp } from '../components/BatchModeHelp';
import type { TierEntryDto } from '../data/api';
import {
  layerSwitchState,
  semanticWorkloadMissingHalf,
  structuralLayers,
  type LayerRow,
} from '../data/autoLayerHints';
import {
  autoSeriesToChart,
  signalQualityGuidance,
  undetectedClasses,
  type AutoPerfVm,
} from '../data/autoPerf';
import {
  edgeSummary,
  toCalibrationEvidenceVm,
  type CalibrationEvidenceVm,
} from '../data/calibrationEvidence';
import {
  toPipelineVm,
  type PipelineVm,
  type StageId,
  type StageRowVm,
  type StatusNowVm,
  type StatusTone,
} from '../data/pipeline';
import type { BandTargetState } from '../data/bandTargets';
import {
  toTargetsMatrixVm,
  type TargetCellVm,
  type TargetColumn,
  type TargetsMatrixVm,
  type TargetsRowVm,
} from '../data/targetsMatrix';
import { isNonRoutableVariant } from '@polyrouter/shared';
import { toCalibrationVm, toHistoryRows } from '../data/calibration';
import { toLearningHistoryRows, toLearningVm } from '../data/semanticLearning';
import { fmtUsd } from '../data/format';
import { useModalSurface } from '../a11y';
import { useApp } from '../state/context';
import type { Model, Range, RoutingSection } from '../types';
import { Icon } from '../components/Icon';
import { StackedLabel } from '../components/StackedLabel';
import { createBusy, createBusyMap } from '../components/busy';
import { FieldNote, useFields } from '../components/Field';

/** In-progress drag, keyed by MODEL IDENTITY rather than list index.
 *
 * An index here would have to be kept equal to the dragged row's current index by hand
 * at every mutation site — and Solid's `<For>` index accessor updates synchronously
 * inside the store mutation, so a re-read after the move returns the DROP TARGET's new
 * index, not the dragged row's. That desync is what made the chain oscillate. With model
 * identity there is no index to go stale: the source position is derived on demand.
 * `modelId` is unique within a tier (the API rejects duplicates with a 422). */
interface DragPos {
  tierId: string;
  modelId: string;
}

export function posStyle(i: number): [string, string, string] {
  return i === 0
    ? ['Primary', 'var(--accent-bg)', 'var(--accent-deep)']
    : [`Fallback ${String(i)}`, 'var(--chip)', 'var(--text3)'];
}

function modelPriceLabel(m: Model | undefined): string {
  const ep = m?.effectivePrice;
  if (!ep) return 'unpriced';
  const tag = ep.estimated ? ' · est.' : '';
  if (ep.isFree) return `free${tag}`;
  return `${fmtUsd(ep.inputPricePer1m)} / ${fmtUsd(ep.outputPricePer1m)} per 1M${tag}`;
}

/** The add-model dropdown's `<optgroup>` sections: one per provider (labelled by
 * provider name), models alphabetical within, groups alphabetical. Exported for
 * the unit test. */
export function groupModelsByProvider(
  models: readonly Model[],
  providers: readonly { id: string; name: string }[],
  /** Given a batch-priced twin, the id of the model it prices when that model may
   * be RESERVED for batch here — else null (add-batch-mode-routing task 5.3). The
   * twin then appears as a labeled shortcut instead of being hidden. */
  reserveTargetFor?: (twin: Model) => string | null,
): Array<{ label: string; models: Model[] }> {
  const byProvider = new Map<string, Model[]>();
  for (const m of models) {
    // A batch-priced variant can never serve a request, so it is not offerable as
    // a routing target (add-model-variant-detection). It is still visible on the
    // Providers page as the batch rate of the model it prices.
    if (isNonRoutableVariant(m.variant)) {
      const base = reserveTargetFor?.(m) ?? null;
      if (base === null) continue;
      const list = byProvider.get(m.providerId) ?? [];
      list.push({ ...m, reserveBaseId: base } as Model);
      byProvider.set(m.providerId, list);
      continue;
    }
    const list = byProvider.get(m.providerId) ?? [];
    list.push(m);
    byProvider.set(m.providerId, list);
  }
  return [...byProvider.entries()]
    .map(([providerId, group]) => ({
      label: providers.find((p) => p.id === providerId)?.name ?? 'Other',
      models: group.sort((a, b) => a.externalModelId.localeCompare(b.externalModelId)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The note shown on a stored chain member or rule target that can no longer serve
 * (add-model-variant-detection). Returns null for a routable model — a `Show` on it
 * renders nothing — and names the base model so the correction is obvious. */
export function nonRoutableNote(m: Model | null | undefined): string | null {
  if (!m || !isNonRoutableVariant(m.variant)) return null;
  const base = m.baseExternalModelId;
  return base === null
    ? 'batch-only — cannot serve; remove it'
    : `batch-only — cannot serve; use ${base}`;
}

/** The note shown wherever routing points at a model its provider no longer lists
 * (add-live-subscription-models). Null for an offered model. "May" — a listing can
 * omit a model that still works, and routing still dispatches it, so the dashboard
 * never claims a failure it has not seen. */
export function unlistedNote(
  m: Model | null | undefined,
  providerName: string | undefined,
): string | null {
  if (!m || m.unlistedSince === null) return null;
  const name = m.displayName ?? m.externalModelId;
  return `${name} is no longer listed by ${providerName ?? 'its provider'} — requests to it may fail`;
}

/** The secondary line of a rule-backed target: its chain, provider and price. */
const TARGET_SUB_FONT = "font:400 0.6875rem/1rem 'Geist',sans-serif;color:var(--text3)";
/** A target's warning: a degraded state, stated in text — never colour alone. */
const TARGET_WARN_FONT = "font:400 0.6875rem/1rem 'Geist',sans-serif;color:var(--amber-text)";
/** An inline text action (Clear, clean up, Retry): underlined, never a second hue. */
const TEXT_ACTION =
  "font:400 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2);cursor:pointer;text-decoration:underline";

/** ONE rendering of a rule-backed target (tier / model / unresolved / unset) for every
 * cell of the Targets matrix (add-workload-routing; redesign-auto-routing-pipeline) —
 * the same state reads the same in every column. */
function TargetSummary(props: { target: BandTargetState; unset: string }) {
  const t = () => props.target;
  return (
    <>
      <Show when={t().kind === 'tier' && t()} keyed>
        {(tt) =>
          tt.kind === 'tier' ? (
            <span class="t-label" style="color:var(--text)">
              tier:{tt.key}
              <Show when={!tt.empty}>
                <span style={TARGET_SUB_FONT}>
                  {' '}
                  <Icon name="chevronRight" size={11} /> {tt.primary}
                  {tt.fallbacks > 0
                    ? ` +${String(tt.fallbacks)} fallback${tt.fallbacks === 1 ? '' : 's'}`
                    : ''}
                  {tt.isDefault ? ' · uses the Layer-0 default chain' : ''}
                </span>
              </Show>
            </span>
          ) : null
        }
      </Show>
      <Show when={t().kind === 'model' && t()} keyed>
        {(tt) =>
          tt.kind === 'model' ? (
            <span class="t-label" style="color:var(--text)">
              {tt.label}
              <span style={TARGET_SUB_FONT}>
                {' '}
                {tt.provider ?? 'unknown provider'} · {modelPriceLabel(tt.model)}
              </span>
              <Show when={unlistedNote(tt.model, tt.provider ?? undefined)}>
                {(note) => (
                  <span
                    data-unlisted-target={tt.model.id}
                    class="t-caption"
                    style="display:block;color:var(--amber-text)"
                  >
                    {note()}
                  </span>
                )}
              </Show>
            </span>
          ) : null
        }
      </Show>
      <Show when={t().kind === 'unresolved' && t()} keyed>
        {(tt) =>
          tt.kind === 'unresolved' ? (
            <span class="mono t-dense" style="color:var(--text2)">
              {tt.literal}
            </span>
          ) : null
        }
      </Show>
      <Show when={t().kind === 'unset'}>
        <span style={TARGET_SUB_FONT}>{props.unset}</span>
      </Show>
    </>
  );
}

/** The ACTION picker for a rule-backed target: tiers, then models by provider. Snaps
 * back to its placeholder — the cell's summary shows the current state. Its width cap
 * lives on `.tm-picker`, not inline, so the matrix's stacked records can release it. It is
 * an entry field like any other (adopt-design-tokens-v2 task 8.1): the shared `select` rule
 * draws its fill, Control Edge, radius and states, at the 24px small size its cell's row of
 * ghost controls takes. */
function TargetPicker(props: {
  label: string;
  disabled: boolean;
  unset: boolean;
  onPick: (target: string) => void;
}) {
  const { state } = useApp();
  return (
    <select
      class="select select--sm tm-picker"
      aria-label={props.label}
      disabled={props.disabled}
      onChange={(e) => {
        const v = e.currentTarget.value;
        // Snap back to the placeholder — this is an ACTION picker, not a
        // value display (the cell's target line shows the current state).
        e.currentTarget.selectedIndex = 0;
        if (v !== '') props.onPick(v);
      }}
    >
      {/* `selected` pins the placeholder at first render — without it the
          browser displays the first REAL option ("default") while nothing
          is actually chosen (the v0.5.0 display bug). */}
      <option value="" disabled selected>
        {props.unset ? 'Set target…' : 'Change…'}
      </option>
      <optgroup label="Tiers">
        <For each={state.routingTiers}>
          {(t) => <option value={`tier:${t.key}`}>{t.key}</option>}
        </For>
      </optgroup>
      <For each={groupModelsByProvider(state.allModels, state.providers)}>
        {(g) => (
          <optgroup label={`Models — ${g.label}`}>
            <For each={g.models}>
              {(m) => (
                <option value={`model:${m.id}`}>
                  {m.displayName ?? m.externalModelId} · {modelPriceLabel(m)}
                </option>
              )}
            </For>
          </optgroup>
        )}
      </For>
    </select>
  );
}

/** The matrix's target columns: what the header row names, and what each cell's own
 * field label repeats so a stacked record (and a screen reader, at every width) never
 * loses it. */
const TARGET_COLUMNS: Record<TargetColumn, { label: string; rule: string; sub: string }> = {
  claim: { label: 'Claim', rule: 'auto_workload', sub: 'takes its class first' },
  strong: { label: 'Strong', rule: 'auto_high', sub: 'confident high' },
  cheap: { label: 'Cheap', rule: 'auto_low', sub: 'confident low' },
};

/** The two cells a Targets control lands on (D12): the Any request row's Strong and
 * Cheap cell WRAPPERS — never the picker, so a stray Arrow key on arrival cannot retarget
 * live routing; the picker is one Tab away. */
export const TARGET_ANCHORS = {
  strong: 'auto-targets-any-strong',
  cheap: 'auto-targets-any-cheap',
} as const;

/** The one note the reserved rows share while their source is not effective; every inert
 * Claim cell points at it. */
const RESERVED_NOTE_ID = 'tm-reserved-note';

/**
 * The TARGETS MATRIX (redesign-auto-routing-pipeline D9; split-auto-routing-readout-setup
 * D9): every claim and band target at once, inside the Setup panel. An "Any request" row
 * carries the GENERIC band rules, then one row per workload class; the columns are Claim
 * (`auto_workload`), Strong (`auto_high`) and Cheap (`auto_low`). Read left to right, a row
 * is the proxy's precedence: a usable, live claim first, else the class's own band target,
 * else the generic one. It shows no range-scoped figure — per-class counts are read in the
 * Workload claim detail, the unroutable counts in the Pipeline — so it never waits on the
 * aggregation.
 *
 * Every guarantee the band and workload cards made carries over, because each cell renders
 * the same pieces off the same store actions: effective-rule resolution, pessimistic,
 * snapshot-scoped writes reconciled after each, the unverified state, shadowed-duplicate
 * cleanup, and reserved-class gating. Busy and error keep the store's grain — per band
 * across every scope (`bt`), per class (`wt`).
 *
 * Rows render through `<Index>`: they never reorder, so a recompute (a reconcile, a
 * re-poll) updates each row in place, and a focused picker keeps its focus.
 */
function TargetsMatrix() {
  const app = useApp();
  const { state } = app;
  // The unverified notice stays up until a reconcile commits, so its Retry is busy (D14).
  const retrying = createBusy();
  const missingHalf = (): string => semanticWorkloadMissingHalf(state.autoLayers);
  const vm = createMemo(() =>
    toTargetsMatrixVm({
      catalog: {
        rules: state.rules,
        tiers: state.routingTiers,
        tierEntries: state.tierEntries,
        models: state.allModels,
        providers: state.providers,
      },
      semanticWorkload: state.autoLayers?.semanticWorkload ?? false,
      missingHalf: missingHalf(),
      cascadeEffective: state.autoLayers?.cascade ?? false,
    }),
  );
  const semanticLive = (): boolean => state.autoLayers?.semanticWorkload ?? false;
  /** Which columns an unverified write paused — the notice names them. */
  const pausedColumns = (): string =>
    [
      ...(state.wt.unverified ? ['Claim column'] : []),
      ...(state.bt.unverified ? ['Strong and Cheap columns'] : []),
    ].join(' and the ');

  return (
    // The Pipeline's Targets controls land on a cell inside; when the band columns are
    // unverified they land on the notice, or here. The scroll margin keeps the focus ring
    // clear of the pane's top edge.
    <section
      id={TARGETS_ID}
      tabindex="-1"
      data-testid="targets-matrix"
      aria-labelledby="ar-targets-title"
      style="scroll-margin-top:12px"
    >
      <div class="ar-sub-title" id="ar-targets-title">
        Targets
      </div>
      <div
        data-testid="targets-precedence"
        class="t-dense"
        style="padding:0 16px 12px;color:var(--text3);max-width:760px"
      >
        Where stages 2 and 3 send a request, read left to right: a usable Claim takes its class's{' '}
        <span class="mono" style="font-size:0.6875rem">
          auto
        </span>{' '}
        requests first — before band targets, Layer 2, and the cascade; otherwise a confident
        verdict goes to the row's Strong or Cheap target, and a class with none of its own in a
        column uses the Any request row's. Ambiguous requests go on to Layer 2 and the cascade. An
        explicit model or the tier header still wins over all of it.
      </div>
      {/* ONE notice for the whole matrix: a write landed (or may have) but the reconcile
          after it failed, so the matrix cannot claim the server's truth. The affected
          column's snapshot-dependent actions stay disabled until a reconcile commits. */}
      <Show when={state.bt.unverified || state.wt.unverified}>
        {/* Caution (D15): a condition that is still true, so it stays until a reconcile
            commits and offers no dismiss. A focus target, hence the id and tabindex. */}
        <Notice
          id={TARGETS_UNVERIFIED_ID}
          tabindex={-1}
          data-testid="targets-unverified"
          style="margin:0 16px 12px"
          tone="caution"
          title="Unverified"
          action={{
            label: 'Retry',
            busyLabel: 'Retrying…',
            busy: retrying.busy(),
            onClick: () => void retrying.run(() => app.retryRulesReconcile()),
          }}
        >
          Routing may have changed — the refresh failed, so the {pausedColumns()} wait until it
          succeeds.
        </Notice>
      </Show>
      <div class="rs-targets">
        {/* The header row names the columns for sighted readers only: every cell carries
            its own real field label, so assistive tech gets the name at every width and
            the stacked records need no second rendering. */}
        <div class="rs-grid-targets tm-head" aria-hidden="true">
          <div>Workload</div>
          <For each={['claim', 'strong', 'cheap'] as const}>
            {(col) => (
              <div>
                {TARGET_COLUMNS[col].label}
                <span class="tm-head-sub"> · {TARGET_COLUMNS[col].sub}</span>
              </div>
            )}
          </For>
        </div>
        <Index each={vm().rows}>
          {(row) => <TargetsRow row={row()} matrix={vm()} missingHalf={missingHalf()} />}
        </Index>
        <Show when={vm().reservedNote}>
          {(note) => (
            <div id={RESERVED_NOTE_ID} class="tm-reserved-note" data-testid="targets-reserved-note">
              {note()}
            </div>
          )}
        </Show>
      </div>
      <div class="ar-foot" data-testid="targets-footnote">
        Claim cells read and write{' '}
        <span class="mono" style="font-size:0.6875rem">
          auto_workload
        </span>{' '}
        rules; Strong,{' '}
        <span class="mono" style="font-size:0.6875rem">
          auto_high
        </span>
        ; Cheap,{' '}
        <span class="mono" style="font-size:0.6875rem">
          auto_low
        </span>
        . Detection is structural: fenced code above the configured code thresholds, an image in the
        request, a declared JSON output format. When several fire, one class wins: vision ›
        structured › code.{' '}
        <span data-testid="targets-reserved-footnote">
          {semanticLive()
            ? 'Research and writing are detected by the semantic workload source (one bounded embed per structural-none auto request, reused by Layer 2) — the semantic layer toggle governs both uses.'
            : `Research and writing are not detected here yet (${missingHalf()}) — their rows go live when the semantic workload source is effective.`}
        </span>{' '}
        A class row's Strong and Cheap cells route by difficulty within that class. Busy and error
        states are per band across every row, and per class for claims; the Cascade row's savings
        basis stays the Any request row's Strong target.
      </div>
    </section>
  );
}

/** One matrix row: the row's name with its detection signal, its three target cells, then
 * the notes that belong to the row rather than to one cell. */
function TargetsRow(props: { row: TargetsRowVm; matrix: TargetsMatrixVm; missingHalf: string }) {
  const r = () => props.row;
  // Fixed per row: the rows never reorder (`<Index>`), so neither does the id.
  const nameId = `tm-row-${props.row.id}`;
  const tag = (): string =>
    r().id === 'any' ? 'generic' : r().reserved ? 'semantic' : 'structural';
  const isAny = (): boolean => r().id === 'any';
  const unusableClaim = (): string | null => {
    const n = r().claimNote;
    return n?.kind === 'unusable' ? n.text : null;
  };
  const hasNotes = (): boolean =>
    unusableClaim() !== null ||
    (isAny() && (props.matrix.cascadeNote !== null || props.matrix.sameDestination));

  return (
    <div
      class="tm-row"
      role="group"
      aria-labelledby={nameId}
      data-testid="targets-row"
      data-row={r().id}
    >
      <div class="rs-grid-targets">
        <div class="tm-name">
          <span id={nameId} class="t-label" style="color:var(--text)">
            {r().label}
          </span>{' '}
          <span class="ar-tag">{tag()}</span>
          <Show when={r().signal}>
            {(signal) => (
              <div class="tm-signal" data-testid="targets-signal">
                {signal()}
              </div>
            )}
          </Show>
        </div>
        <TargetCell cell={r().claim} missingHalf={props.missingHalf} />
        <TargetCell cell={r().strong} missingHalf={props.missingHalf} />
        <TargetCell cell={r().cheap} missingHalf={props.missingHalf} />
      </div>
      <Show when={hasNotes()}>
        <div class="tm-notes">
          {/* The cascade checks read the GENERIC bands only, so they sit on this row — and
              the note is scoped per leg: a class's own target fills a missing band. */}
          <Show when={isAny() && props.matrix.cascadeNote}>
            {(note) => (
              <div style={TARGET_WARN_FONT} data-testid="targets-cascade-needs-both">
                {note()}
              </div>
            )}
          </Show>
          <Show when={isAny() && props.matrix.sameDestination}>
            <div style={TARGET_WARN_FONT} data-testid="targets-same-destination">
              Both bands resolve to the same destination — the cascade would retry the same chain.
            </div>
          </Show>
          <Show when={unusableClaim()}>
            {(text) => (
              <div style={TARGET_WARN_FONT} data-testid="targets-claim-note">
                {text()}
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** One target cell (D9), three rows on the row's subgrid so every picker in a row shares
 * one top line: the VALUE (the cell's own target, or its short value when it has none),
 * the picker and Clear, and the NOTES (the claimed annotation, the cell-scoped error, and
 * every disclosure — empty tier, unresolved, batch-only, shadowed duplicates). `claimed`
 * is an ADDED annotation beside the value, never instead of it, so a broken scoped rule
 * never hides under a claim and goes live, unwarned, the moment the claim is cleared. */
function TargetCell(props: { cell: TargetCellVm; missingHalf: string }) {
  const app = useApp();
  const { state } = app;
  // The band's own flag disables every cell of the band while one writes; the pressed
  // control also says what it is doing (D14), so its label comes from its own run.
  const clearing = createBusy();
  const cleaning = createBusy();
  const c = () => props.cell;
  const col = () => TARGET_COLUMNS[c().column];
  /** Whom the cell is for, as its controls' accessible names say it. */
  const forWhom = (): string => c().scope ?? 'any request';
  const name = (): string => `${col().label} target for ${forWhom()}`;
  /** The Any request Strong and Cheap cells are where the Pipeline's Targets controls land. */
  const anchor = (): string | undefined => {
    const cell = c();
    if (cell.scope !== null || cell.column === 'claim') return undefined;
    return TARGET_ANCHORS[cell.column];
  };
  const inert = (): boolean => c().kind === 'readonly';
  const busy = (): boolean => {
    const cell = c();
    if (cell.band !== 'auto_workload') return state.bt.busy[cell.band] || state.bt.unverified;
    return cell.scope !== null && (state.wt.busy[cell.scope] || state.wt.unverified);
  };
  /** A failed write shows under the cell it came from — a scoped band failure never
   * under the generic cell, nor the generic one under a class row. */
  const error = (): string | null => {
    const cell = c();
    if (cell.band !== 'auto_workload')
      return state.bt.errorScope[cell.band] === cell.scope ? state.bt.errors[cell.band] : null;
    return cell.scope === null ? null : state.wt.errors[cell.scope];
  };
  const pick = (target: string): void => {
    const cell = c();
    if (cell.band !== 'auto_workload') void app.setBandTarget(cell.band, target, cell.scope);
    else if (cell.scope !== null) void app.setWorkloadTarget(cell.scope, target);
  };
  const clear = (): Promise<void> => {
    const cell = c();
    if (cell.band !== 'auto_workload') return app.clearBand(cell.band, cell.scope);
    if (cell.scope !== null) return app.clearWorkload(cell.scope);
    return Promise.resolve();
  };
  const cleanUp = (): Promise<void> => {
    const cell = c();
    if (cell.band !== 'auto_workload') return app.cleanShadowed(cell.band, cell.scope);
    if (cell.scope !== null) return app.cleanWorkloadShadowed(cell.scope);
    return Promise.resolve();
  };
  /** What an empty tier does, in this cell's own terms. */
  const emptyText = (): string => {
    const cell = c();
    const band = col().label.toLowerCase();
    if (cell.band === 'auto_workload')
      return `This tier has no models — ${cell.scope ?? ''} requests are not claimed and follow the complexity path (band targets, then L2 and the cascade, then default).`;
    if (cell.scope === null)
      return 'This tier has no models — the band steers nothing: confident verdicts fall through to default and the cascade cannot plan.';
    return `This tier has no models — the ${cell.scope} ${band} band is unroutable for the class (no fall-back to the Any request target): its requests fall through to default.`;
  };
  const unresolvedText = (): string => {
    const cell = c();
    const band = col().label.toLowerCase();
    if (cell.band === 'auto_workload')
      return `Target unresolved — ${cell.scope ?? ''} requests follow the complexity path (band targets, then L2 and the cascade, then default).`;
    if (cell.scope === null) return 'Target unresolved — requests fall through to default.';
    return `Target unresolved — the ${cell.scope} ${band} band is unroutable for the class.`;
  };

  return (
    <div
      class={anchor() === undefined ? 'tm-cell' : 'tm-cell tm-anchor'}
      data-testid="targets-cell"
      data-column={c().column}
      data-kind={c().kind}
      data-claimed={c().claimed ? 'true' : undefined}
      id={anchor()}
      tabindex={anchor() === undefined ? undefined : -1}
      role={anchor() !== undefined || inert() ? 'group' : undefined}
      aria-label={
        anchor() !== undefined
          ? `${col().label} column, Any request row`
          : inert()
            ? name()
            : undefined
      }
      aria-describedby={inert() ? RESERVED_NOTE_ID : undefined}
    >
      <span class="tm-label">{col().label}</span>
      {/* `display: contents` at desktop, so the three rows below sit on the row's subgrid;
          a flex column in the stacked record. */}
      <div class="tm-body">
        <div class="tm-value">
          {/* A model target's unlisted note is TargetSummary's own (`data-unlisted-target`),
              so the cell does not print it twice. */}
          <TargetSummary target={c().target} unset={c().valueText} />
        </div>
        <Show when={c().editable}>
          <div class="tm-actions">
            <TargetPicker
              label={name()}
              disabled={busy()}
              unset={c().target.kind === 'unset'}
              onPick={pick}
            />
            <Show when={c().effective !== null}>
              <button
                type="button"
                disabled={busy() || clearing.busy()}
                aria-busy={clearing.busy() ? true : undefined}
                aria-label={clearing.busy() ? `Clearing ${name()}…` : `Clear ${name()}`}
                style={TEXT_ACTION}
                onClick={() => void clearing.run(() => clear())}
              >
                <StackedLabel alt={clearing.busy()} rest="Clear" altLabel="Clearing…" />
              </button>
            </Show>
          </div>
        </Show>
        <div class="tm-cell-notes">
          <Show when={c().claimedNote}>
            {(note) => (
              <div
                data-testid="cell-claimed"
                style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2)"
              >
                {note()}
              </div>
            )}
          </Show>
          {/* A reserved class's API-created rule: disclosed, never actionable from here. */}
          <Show when={c().kind === 'readonly' && c().effective !== null}>
            <div style={TARGET_SUB_FONT} data-testid="cell-reserved-note">
              Reserved class — this rule was created through the API and stays inert until the
              semantic workload source emits {c().scope ?? ''} ({props.missingHalf}).
            </div>
          </Show>
          <Show when={error()}>
            {(msg) => (
              <div data-testid="cell-error" class="t-caption" style="color:var(--red-text)">
                {msg()}
              </div>
            )}
          </Show>
          <Show when={c().notes.emptyTier}>
            <div style={TARGET_WARN_FONT}>{emptyText()}</div>
          </Show>
          <Show when={c().notes.unresolvedHint}>
            {(hint) => (
              <div style={TARGET_WARN_FONT}>
                {unresolvedText()} {hint()}
              </div>
            )}
          </Show>
          <Show when={nonRoutableNote(c().notes.nonRoutable)}>
            {(note) => (
              <div style={TARGET_WARN_FONT} data-testid="cell-nonroutable">
                {note()}
              </div>
            )}
          </Show>
          <Show when={c().shadowed.length > 0}>
            <div style={TARGET_WARN_FONT} data-testid="cell-shadowed">
              {c().shadowed.length} shadowed duplicate rule{c().shadowed.length === 1 ? '' : 's'}
              {/* Read-only cells stay read-only (clink r5 M3): the duplicate is disclosed,
                  never actionable from here — the API owns those rules. */}
              <Show
                when={c().editable}
                fallback={<span> (API-created — manage through the rules API)</span>}
              >
                {' '}
                —{' '}
                <button
                  type="button"
                  disabled={busy() || cleaning.busy()}
                  aria-busy={cleaning.busy() ? true : undefined}
                  aria-label={
                    cleaning.busy()
                      ? `Cleaning up shadowed ${col().label} rules for ${forWhom()}…`
                      : `Clean up shadowed ${col().label} rules for ${forWhom()}`
                  }
                  style={TEXT_ACTION}
                  onClick={() => void cleaning.run(() => cleanUp())}
                >
                  <StackedLabel alt={cleaning.busy()} rest="clean up" altLabel="cleaning up…" />
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** The two tuning drawers (split-auto-routing-readout-setup D8). */
export type TuningName = 'calibration' | 'learning';

/** After an in-drawer action whose control may have unmounted (Revert to defaults, an
 * agent's Revert, Confirm revert), put focus back inside the open tuning drawer — the
 * dashboard-core content-replaced rule. A no-op while focus is anywhere real. */
function keepFocusInDrawer(): void {
  queueMicrotask(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    document.querySelector<HTMLElement>('[data-testid="tuning-drawer"]')?.focus();
  });
}

/** A tuning drawer: the dashboard's existing drawer (the Inspector's `.drawer` through
 * `useModalSurface`) — a labelled dialog that traps focus, closes on Escape or its
 * backdrop, returns focus to its invoker, and is a bottom sheet at or below `narrow`.
 * Mounted only while open, and only by `AutoRouting`, beside the panels — never inside
 * a query container, which would become the fixed drawer's containing block. */
function TuningDrawer(props: {
  name: TuningName;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  const app = useApp();
  const { state } = app;
  const titleId = `tuning-title-${props.name}`;
  const surface = useModalSurface(app, {
    when: () => true, // mounted only while open
    labelledBy: titleId,
    onDismiss: props.onClose,
  });
  return (
    <>
      {/* eslint-disable-next-line a11y-guard/no-noninteractive-click -- pointer-only backdrop redundancy; Escape is the keyboard path */}
      <div
        class="overlay"
        style={{ 'z-index': String(surface.z().backdrop) }}
        onClick={props.onClose}
      />
      <div
        class="drawer"
        data-testid="tuning-drawer"
        data-tuning={props.name}
        style={{ 'z-index': String(surface.z().surface) }}
        inert={state.navExpanded ? true : undefined}
        {...surface.props}
        ref={surface.props['ref'] as (n: HTMLElement) => void}
      >
        <div class="drawer-head">
          <div id={titleId} class="t-title" style="color:var(--text)">
            {props.title}
          </div>
          <button
            type="button"
            class="drawer-close"
            aria-label={props.closeLabel}
            onClick={props.onClose}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
        <div class="drawer-body">{props.children}</div>
      </div>
    </>
  );
}

/** The SELF-CALIBRATION section (add-auto-threshold-calibration): the opt-in
 * toggle, the effective thresholds line (instance vs calibrated), one-click
 * revert, and the threshold-change history — every move with its evidence. */
function SelfCalibration() {
  const app = useApp();
  const { state } = app;
  createEffect(() => {
    if (!state.calHistory.loaded) void app.loadCalHistory();
  });
  const vm = () => toCalibrationVm(state.autoLayers);
  const rows = () => toHistoryRows(state.calHistory.rows);
  return (
    // NOT keyed: the view-model is rebuilt on every auto-layers change, and a keyed Show
    // would remount the whole card on each one — replacing the switch the user just
    // pressed and dropping focus to <body> (D8 "Stable cards").
    <Show when={vm()}>
      {(v) => (
        <div class="ar-card" data-testid="self-calibration">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="section-title">Self-calibration</div>
            <Toggle
              on={v().enabled}
              size="sm"
              label="Self-calibration"
              onToggle={() => void app.setCalibration(!v().enabled)}
            />
          </div>
          <div class="t-caption" style="color:var(--text3);margin-bottom:8px">
            Conservatively narrows the ambiguous band from your own cascade outcomes — never a fix
            for confident-band mistakes. Every change is listed below and one click from undone.
          </div>
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-bottom:8px">
            <span class="figure t-label" style="color:var(--text);white-space:nowrap">
              {v().thresholdsLine}
            </span>
            <span
              class="chip"
              style={{
                font: "400 0.6875rem/1rem 'Geist',sans-serif",
                // Neutral either way (D11): the tag's TEXT says which pair it is, and the
                // Pipeline's bars are the tab's one accent element.
                color: 'var(--text2)',
              }}
            >
              {v().tag}
            </span>
            <Show when={v().showRevert}>
              <button
                type="button"
                class="btn-ghost"
                onClick={() => void app.revertCalibration().finally(keepFocusInDrawer)}
              >
                Revert to defaults
              </button>
            </Show>
          </div>
          {/* The FROZEN tenant pair (add-per-agent-calibration). It still governs
              every inheriting agent while no longer being informed by the
              traffic it governs, so it is disclosed rather than presented as
              current. The revert beside it is the existing one. */}
          <Show when={v().tenantStarved}>
            <div
              data-testid="tenant-pair-starved"
              class="t-dense"
              style="color:var(--text2);background:var(--chip);border-radius:6px;padding:8px;margin-bottom:8px"
            >
              This pair is no longer being informed by the traffic it governs — both edges have sat
              below the acting floor for a full window. It still applies to every agent without its
              own pair.
            </div>
          </Show>

          {/* PER-AGENT scope. Listed even when nobody holds a pair, because
              "inheriting" is a state to name, not an absence to infer. */}
          <div data-testid="agent-calibration" style="margin-bottom:8px">
            <div style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2);margin-bottom:4px">
              Per-agent thresholds
            </div>
            <Show
              when={!v().noAgents}
              fallback={
                <div class="t-caption" style="color:var(--text3)">
                  No agents yet.
                </div>
              }
            >
              <div class="t-caption" style="color:var(--text3);margin-bottom:8px">
                An agent earns its own pair on the same evidence floor the tenant does.{' '}
                {v().inheritingCount > 0
                  ? `${String(v().inheritingCount)} inheriting this tenant's pair.`
                  : 'All agents carry their own.'}
              </div>
              <For each={v().agents}>
                {(a) => (
                  <div
                    data-testid="agent-calibration-row"
                    style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:4px 0;border-top:1px solid var(--border2)"
                  >
                    <span
                      class="t-dense"
                      style="color:var(--text);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                      title={a.name}
                    >
                      {a.name}
                    </span>
                    <Show
                      when={a.pairLine}
                      fallback={
                        <span class="t-caption" style="color:var(--text3)">
                          inheriting
                        </span>
                      }
                    >
                      <span class="figure t-label" style="color:var(--text)">
                        {a.pairLine}
                      </span>
                      <span class="t-caption" style="color:var(--text3)">
                        {a.anchorLine}
                      </span>
                      <Show when={a.evidenceLine}>
                        <span class="t-caption" style="color:var(--text3)">
                          {a.evidenceLine}
                        </span>
                      </Show>
                      <button
                        type="button"
                        class="btn-ghost"
                        data-testid="agent-revert"
                        aria-label={`Revert ${a.name} to inherited thresholds`}
                        style="margin-left:auto"
                        onClick={() =>
                          void app.revertAgentCalibration(a.id).finally(keepFocusInDrawer)
                        }
                      >
                        Revert
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <Show when={state.calHistory.error}>
            <div class="t-caption" style="color:var(--red-text)">
              Couldn’t load calibration history — {state.calHistory.error}{' '}
              <button
                type="button"
                class="t-caption"
                style="color:var(--text2);cursor:pointer;text-decoration:underline"
                onClick={() => void app.loadCalHistory()}
              >
                Retry
              </button>
            </div>
          </Show>
          <Show
            when={rows().length > 0}
            fallback={
              /* Loading, error, and truly-empty are mutually exclusive: an
                 errored load never masquerades as an empty history (r3-Low-6). */
              <Show when={state.calHistory.error === null}>
                <div class="t-caption" style="color:var(--text3);padding:4px 0">
                  {state.calHistory.loaded ? 'No calibration changes yet.' : 'Loading…'}
                </div>
              </Show>
            }
          >
            <For each={rows()}>
              {(r) => (
                <div style="display:flex;align-items:baseline;gap:8px;padding:4px 0;border-top:1px solid var(--border2)">
                  <span class="figure t-caption" style="color:var(--text3);min-width:70px">
                    {r.date}
                  </span>
                  <span
                    style={{
                      font: "400 0.75rem/1rem 'Geist',sans-serif",
                      color: r.kind === 'move' ? 'var(--text)' : 'var(--text2)',
                    }}
                  >
                    {r.movement}
                  </span>
                  <Show when={r.evidence !== ''}>
                    <span class="t-caption" style="color:var(--text3)">
                      {r.evidence}
                    </span>
                  </Show>
                  <Show when={r.kind !== 'move'}>
                    <span class="t-caption chip" style="color:var(--text3)">
                      {r.kind}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      )}
    </Show>
  );
}

/** The L2 SEMANTIC LEARNING card (add-semantic-dashboard D3) — the calibration
 * card's twin, shown only while the semantic layer is EFFECTIVE. Opt-in toggle,
 * scope-honest copy, the learned/bundled source + fresh-sample status, the
 * numeric audit history, and a confirmed one-click Revert to bundled. Honest
 * under degradation: a stale learned centroid shows `bundled` WITH its reason. */
function SemanticLearning() {
  const app = useApp();
  const { state } = app;
  const [confirming, setConfirming] = createSignal(false);
  // The confirmation swaps one button for three. Focus follows the swap both ways (D8):
  // opening it lands on Cancel, Cancel or Escape lands back on Revert to bundled — never
  // on <body>, which is where removing the focused button would leave it.
  let revertButton: HTMLButtonElement | undefined;
  let cancelButton: HTMLButtonElement | undefined;
  const openConfirm = (): void => {
    setConfirming(true);
    queueMicrotask(() => cancelButton?.focus());
  };
  const cancelConfirm = (): void => {
    setConfirming(false);
    queueMicrotask(() => revertButton?.focus());
  };
  /** The confirmation owns Escape: it cancels HERE and marks the event handled, so the
   * layer arbiter does not also dismiss the drawer — the picker's two-stage Escape. Focus
   * is always on one of the confirmation's buttons while it shows, so they carry it. A
   * second Escape (now on Revert to bundled) closes the drawer. */
  const confirmKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    cancelConfirm();
  };
  createEffect(() => {
    // Fetch once the card goes live (semantic effective); cheap + always honest.
    if (state.autoLayers?.semantic === true && !state.semLearn.loaded) {
      void app.loadSemanticLearning();
    }
  });
  const vm = () => toLearningVm(state.semLearn.status);
  const rows = () => toLearningHistoryRows(state.semLearn.status?.history ?? []);
  // The toggle's truth is the auto-layers response (always present when the card
  // shows), NOT the status GET — so a failed status load never blanks the control
  // or its Retry (clink change-4 Med-4). vm() gates only the status FIGURES.
  const learningOn = () => state.autoLayers?.semanticLearning ?? false;
  return (
    <Show when={state.autoLayers?.semantic === true}>
      <div class="ar-card" data-testid="semantic-learning">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <div class="section-title">Semantic learning</div>
          <Toggle
            on={learningOn()}
            size="sm"
            label="Semantic learning"
            onToggle={() => void app.setSemanticLearning(!learningOn())}
          />
        </div>
        <div class="t-caption" style="color:var(--text3);margin-bottom:8px">
          Learns only from your own cascade outcomes — nudges the ambiguous-slice centroids to orbit
          the bundled anchors, never beyond. Off by default and one click from reverted; it never
          measures whether learning helps, only what it has absorbed.
        </div>
        <Show when={state.semLearn.error}>
          <div class="t-caption" style="color:var(--red-text);margin-bottom:8px">
            Couldn’t load learning status — {state.semLearn.error}{' '}
            <button
              type="button"
              class="t-caption"
              style="color:var(--text2);cursor:pointer;text-decoration:underline"
              onClick={() => void app.loadSemanticLearning()}
            >
              Retry
            </button>
          </div>
        </Show>
        {/* NOT keyed — see SelfCalibration: a status refresh must update this in place. */}
        <Show when={vm()}>
          {(v) => (
            <>
              <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
                <span class="figure t-label" style="color:var(--text)">
                  {v().samplesLine}
                </span>
                <span
                  class="chip"
                  style={{
                    font: "400 0.6875rem/1rem 'Geist',sans-serif",
                    color: 'var(--text3)',
                  }}
                >
                  {v().sourceLine}
                </span>
                <span class="t-caption" style="color:var(--text3)">
                  {v().lastAppliedLine}
                </span>
                <Show when={v().showRevert}>
                  <Show
                    when={confirming()}
                    fallback={
                      <button
                        type="button"
                        class="btn-ghost"
                        ref={(el) => {
                          revertButton = el;
                        }}
                        onClick={openConfirm}
                      >
                        Revert to bundled
                      </button>
                    }
                  >
                    <span class="t-caption" style="color:var(--text2)">
                      Revert all learned centroids?
                    </span>
                    <button
                      type="button"
                      class="btn-ghost"
                      style="font:400 0.6875rem/1rem 'Geist',sans-serif;cursor:pointer"
                      onKeyDown={confirmKeyDown}
                      onClick={() => {
                        setConfirming(false);
                        // Confirm revert removes itself: keep focus inside the drawer.
                        keepFocusInDrawer();
                        void app.revertSemanticLearning().finally(keepFocusInDrawer);
                      }}
                    >
                      Confirm revert
                    </button>
                    <button
                      type="button"
                      class="btn-cancel"
                      style="font:400 0.6875rem/1rem 'Geist',sans-serif;cursor:pointer"
                      ref={(el) => {
                        cancelButton = el;
                      }}
                      onKeyDown={confirmKeyDown}
                      onClick={cancelConfirm}
                    >
                      Cancel
                    </button>
                  </Show>
                </Show>
              </div>
              <Show when={v().staleReason} keyed>
                {(reason) => (
                  <div class="mono t-caption" style="color:var(--amber-text);margin-bottom:8px">
                    {reason}
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show when={state.semLearn.error === null}>
          <Show
            when={rows().length > 0}
            fallback={
              <div class="t-caption" style="color:var(--text3);padding:4px 0">
                {state.semLearn.loaded ? 'No learning events yet.' : 'Loading…'}
              </div>
            }
          >
            <For each={rows()}>
              {(r) => (
                <div style="display:flex;align-items:baseline;gap:8px;padding:4px 0;border-top:1px solid var(--border2)">
                  <span class="figure t-caption" style="color:var(--text3);min-width:70px">
                    {r.date}
                  </span>
                  <span class="t-caption chip" style="color:var(--text3)">
                    {r.trigger}
                  </span>
                  <span class="figure t-caption" style="color:var(--text2)">
                    {r.samples}
                  </span>
                  <Show when={r.evidence !== ''}>
                    <span class="mono t-caption" style="color:var(--text3)">
                      {r.evidence}
                    </span>
                  </Show>
                  <Show when={r.reason !== ''}>
                    <span class="t-caption" style="color:var(--text3)">
                      {r.reason}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

/** The AUTO ROUTING tab (redesign-auto-routing-pipeline; split-auto-routing-readout-setup
 * D1): two panels — the PIPELINE, which reads out where automatic routing sent traffic
 * (every range-scoped figure), and SETUP, which holds every control (the layer switches,
 * the Targets matrix, and the two tuning drawers beside the panels). Every measured
 * figure comes through `toPipelineVm`, which gates them on the designed states —
 * so nothing renders as current while the aggregation is loading, after it failed
 * (the store keeps the last data on a failure), or with the capability absent.
 *
 * The fetch is NOT here. `Routing()` owns it, because it outlives the tab: one fetch
 * on the tab's first show per visit (D5). Per-visit rather than `loaded`-gated — a
 * store-level gate is what once froze these figures at their first fetch across
 * visits. A same-range refetch keeps the figures it replaces visible until it
 * commits (the loader's seq/gen/range guards make late responses harmless). */
function AutoRouting(props: { structural: boolean; onStranded: () => void }) {
  const app = useApp();
  const { state } = app;
  const vm = createMemo(() =>
    toPipelineVm({
      autoLayers: state.autoLayers,
      autoPerf: {
        data: state.autoPerf.data,
        error: state.autoPerf.error,
        range: state.autoPerf.range,
      },
      catalog: {
        rules: state.rules,
        tiers: state.routingTiers,
        tierEntries: state.tierEntries,
        models: state.allModels,
        providers: state.providers,
      },
      unverified: { bands: state.bt.unverified, claims: state.wt.unverified },
    }),
  );
  // Which tuning drawer is open — component-local, like the open stages. A drawer whose
  // card loses its precondition while open closes for good (it never reopens by itself
  // when the precondition returns).
  const [tuning, setTuning] = createSignal<TuningName | null>(null);
  const calibrationGate = (): boolean =>
    props.structural && toCalibrationVm(state.autoLayers) !== null;
  const learningGate = (): boolean => props.structural && state.autoLayers?.semantic === true;
  createEffect(() => {
    const t = tuning();
    if ((t === 'calibration' && !calibrationGate()) || (t === 'learning' && !learningGate())) {
      setTuning(null);
      // The drawer and its invoker can leave in the same update, and the drawer returns
      // focus to the invoker BEFORE the invoker's node is removed — so neither region's
      // guard sees focus leave. Once the DOM has settled, focus that fell to <body> goes
      // to the tab control (`onStranded` acts only then).
      queueMicrotask(props.onStranded);
    }
  });
  const closeTuning = (): void => {
    setTuning(null);
  };
  let pipelineSection: HTMLElement | undefined;
  const retry = (): void => {
    void app.retryAutoPerf();
    queueMicrotask(() => pipelineSection?.focus());
  };
  // Which stages are open. Component-local, so it resets whenever the tab changes
  // (the tab unmounts) — stages start collapsed, and opening one writes nothing.
  const [open, setOpen] = createSignal<ReadonlySet<StageId>>(new Set());
  const toggleStage = (id: StageId): void => {
    const next = new Set(open());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  return (
    <>
      <div class="t-body" style="color:var(--text3);max-width:720px">
        Runs only when an agent sends model{' '}
        <span
          class="mono"
          style="font-size:0.6875rem;background:var(--chip);padding:0 4px;border-radius:4px"
        >
          auto
        </span>
        . If a smart layer is down or a stage’s target is unusable, the request lands on the default
        tier — requests never fail because routing got clever.
      </div>

      {/* The Pipeline is the Retry's landing spot: Retry swaps the failure notice for the
          rows' placeholders, unmounting the button just pressed, and without a stable
          landing spot focus would fall to <body>. */}
      <section
        ref={(el) => {
          pipelineSection = el;
        }}
        tabindex={-1}
        class="panel"
        data-testid="auto-pipeline"
        aria-labelledby="ar-pipeline-title"
      >
        <div class="ar-head" style="padding:16px 16px 12px">
          <div>
            <div class="section-title" id="ar-pipeline-title" style="margin-bottom:4px">
              Pipeline
            </div>
            <div class="t-dense" style="color:var(--text3)">
              In the order the proxy runs them. A request leaves at the first stage that routes it.
            </div>
          </div>
          {/* The range frames every count on the rows; with the capability absent there is
              no figure to frame. */}
          <Show when={props.structural}>
            <FocusGuard onStranded={props.onStranded} style="display:contents">
              <div role="group" aria-label="Figures range" data-testid="auto-range">
                <RangeSelector
                  value={state.autoPerf.range}
                  onChange={(r: Range) => app.setAutoPerfRange(r)}
                />
              </div>
            </FocusGuard>
          </Show>
        </div>
        <div class="ar-note" data-testid="layer0-note">
          Before stage 1, an explicit model, an explicit tier, or an{' '}
          <span class="mono" style="font-size:0.6875rem">
            x-polyrouter-tier
          </span>{' '}
          header rule decides — auto runs only when none of them matches. Those live on{' '}
          <button
            type="button"
            class="ar-note-link"
            onClick={() => {
              app.setRoutingSection('tiers');
              // This button leaves with its tab: hand focus to the tab control.
              queueMicrotask(props.onStranded);
            }}
          >
            Tiers &amp; headers
          </button>
          .
        </div>
        {/* ONE slot above the column header for the figures' designed states that are
            about the whole range (D1): a failure, a zero range, or no stage breakdown. */}
        <Show when={props.structural}>
          <PipelineNotice vm={vm()} onRetry={retry} />
        </Show>
        {/* The rows' query container is THIS wrapper, never the grid it holds: a container
            query styles only descendants, so the grid's own tracks must sit one level down
            to be restated per mode (D2). */}
        <div class="ar-pipeline">
          {/* An explicit list role: WebKit drops list semantics from a marker-less list. */}
          <ol class="ar-stages" role="list">
            <li class="ar-colhead" aria-hidden="true">
              <span class="ar-ch-name">Stage</span>
              <span class="ar-ch-status">Status now</span>
              <Show when={props.structural}>
                <span class="ar-ch-fig">Requests · {vm().range}</span>
              </Show>
            </li>
            <Index each={vm().stages}>
              {(stage) => (
                <StageRow
                  stage={stage()}
                  vm={vm()}
                  structural={props.structural}
                  open={open().has(stage().id)}
                  onToggle={toggleStage}
                  onStranded={props.onStranded}
                />
              )}
            </Index>
          </ol>
        </div>
        <div class="ar-foot" data-testid="pipeline-unevaluated">
          {/* Only where counts and a range control are on screen. */}
          <Show when={props.structural}>
            Counts are evaluated auto requests in the selected {vm().range} range.{' '}
          </Show>
          <span class="mono" style="font-size:0.6875rem">
            auto
          </span>{' '}
          requests Layer 1 never evaluated — the layer off, or a classification fault — go to the
          default tier without being counted in any stage.
        </div>
      </section>

      <SetupPanel
        structural={props.structural}
        tuning={tuning()}
        onTuning={setTuning}
        onStranded={props.onStranded}
      />

      {/* The tuning drawers, beside the panels and outside every query container. A guard
          hands focus to the tab control when a lost precondition unmounts a drawer whose
          invoker went with it. */}
      <Show when={tuning() === 'calibration' && calibrationGate()}>
        <FocusGuard onStranded={props.onStranded} style="display:contents">
          <TuningDrawer
            name="calibration"
            title="Classify · self-calibration"
            closeLabel="Close self-calibration"
            onClose={closeTuning}
          >
            <SelfCalibration />
            <div data-testid="calibration-evidence-pointer" style={NOTE_FONT}>
              The evidence behind these thresholds is in the Classify stage’s details in the
              Pipeline.
            </div>
          </TuningDrawer>
        </FocusGuard>
      </Show>
      <Show when={tuning() === 'learning' && learningGate()}>
        <FocusGuard onStranded={props.onStranded} style="display:contents">
          <TuningDrawer
            name="learning"
            title="Semantic · learning"
            closeLabel="Close semantic learning"
            onClose={closeTuning}
          >
            <SemanticLearning />
          </TuningDrawer>
        </FocusGuard>
      </Show>
    </>
  );
}

/** Each layer's stage name in the Pipeline — what its Layers cell is titled. */
const LAYER_STAGE: Record<LayerRow['id'], string> = {
  structural: 'Classify',
  semantic: 'Semantic',
  cascade: 'Cascade',
};

/**
 * The SETUP panel (split-auto-routing-readout-setup D1, D7): every automatic-routing
 * control, rendered from routing state alone — it never waits on the aggregation and shows
 * no range-scoped figure. Its Layers cells hold the tab's only three switches; the Pipeline
 * reads out what they did.
 */
function SetupPanel(props: {
  structural: boolean;
  tuning: TuningName | null;
  onTuning: (name: TuningName) => void;
  onStranded: () => void;
}) {
  const { state } = useApp();
  const layers = (): LayerRow[] => structuralLayers(state.autoLayers);
  /** Each entry renders only under its card's own precondition (dashboard-config "a moved
   * card keeps its own gate"): self-calibration needs the structural capability and its
   * view-model; semantic learning needs the semantic layer EFFECTIVE. */
  const entry = (id: LayerRow['id']): LayerEntry | null => {
    const al = state.autoLayers;
    if (id === 'structural') {
      const cal = toCalibrationVm(al);
      return props.structural && cal !== null
        ? {
            name: 'calibration',
            label: `Self-calibration · ${cal.enabled ? 'on' : 'off'}`,
            open: props.tuning === 'calibration',
            onOpen: () => props.onTuning('calibration'),
          }
        : null;
    }
    if (id === 'semantic' && props.structural && al?.semantic === true)
      return {
        name: 'learning',
        label: `Semantic learning · ${al.semanticLearning ? 'on' : 'off'}`,
        open: props.tuning === 'learning',
        onOpen: () => props.onTuning('learning'),
      };
    return null;
  };
  return (
    <section class="panel" data-testid="auto-setup" aria-labelledby="ar-setup-title">
      <div style="padding:16px 16px 12px">
        <div class="section-title" id="ar-setup-title" style="margin-bottom:4px">
          Setup
        </div>
        <div class="t-dense" style="color:var(--text3)">
          Every automatic-routing control. Changes apply to new requests; the Pipeline reads out
          where traffic went.
        </div>
      </div>
      <div class="ar-sub-title" id="ar-layers-title">
        Layers
      </div>
      <div class="ar-layers-wrap">
        {/* Rows never reorder, so `<Index>` keeps each cell — and its focused switch — in
            place while the auto-layers view recomputes. */}
        <div
          class="ar-layers"
          role="group"
          aria-labelledby="ar-layers-title"
          data-testid="auto-layers"
        >
          <Index each={layers()}>
            {(row) => (
              <LayerCell row={row()} entry={entry(row().id)} onStranded={props.onStranded} />
            )}
          </Index>
        </div>
      </div>
      {/* The Targets matrix: where the Confident band row points. It renders from routing
          state alone, so it never waits on the aggregation — only on the capability. The
          guard returns focus to the tab control when the capability goes away under a user
          standing inside it. */}
      <Show when={props.structural}>
        <FocusGuard onStranded={props.onStranded}>
          <TargetsMatrix />
        </FocusGuard>
      </Show>
    </section>
  );
}

/** One Layers cell (D7): the layer's switch with its unchanged accessible name, its stage
 * name and layer label, its state in text, its description, and the missing-half hint
 * when the instance cannot enable it. An unavailable switch is drawn as unavailable —
 * distinct from off and from busy — AND says "Unavailable", so the drawing is never the
 * only signal. */
interface LayerEntry {
  name: TuningName;
  label: string;
  open: boolean;
  onOpen: () => void;
}

function LayerCell(props: { row: LayerRow; entry: LayerEntry | null; onStranded: () => void }) {
  const app = useApp();
  const r = () => props.row;
  const sw = () => layerSwitchState(r());
  const stateText = (): string | null => {
    const k = sw().kind;
    return k === 'loading' ? null : k === 'unavailable' ? 'Unavailable' : k === 'on' ? 'On' : 'Off';
  };
  const hint = (): string | null => {
    const v = sw();
    return v.kind === 'unavailable' ? v.hint : null;
  };
  return (
    <div class="ar-layer" data-testid="layer-cell" data-layer={r().id}>
      <div class="ar-layer-head">
        <div class="ar-layer-name">
          <div style="display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px">
            <span style="font:500 0.8125rem/1.25rem 'Geist',sans-serif;color:var(--text)">
              {LAYER_STAGE[r().id]}
            </span>{' '}
            <Show when={stateText()}>
              {(t) => (
                <span data-testid="layer-state" class="t-dense" style="color:var(--text2)">
                  {t()}
                </span>
              )}
            </Show>
          </div>
          <div class="mono t-caption" style="color:var(--text3)">
            {r().name} · {r().tag}
          </div>
        </div>
        <Show
          when={sw().kind !== 'loading'}
          fallback={
            <span data-testid="switch-loading">
              <span class="ar-skel ar-skel-switch" aria-hidden="true" />
              <span class="sr-only">{r().name} loading</span>
            </span>
          }
        >
          <Toggle
            on={r().on}
            unavailable={!r().available}
            label={`Toggle ${r().name}`}
            onToggle={() => void app.toggleAutoLayer(r().id)}
          />
        </Show>
      </div>
      <div class="t-caption" style="color:var(--text3)">
        {r().desc}
      </div>
      <Show when={hint()}>
        {(h) => (
          // A caution only where Layer 1 is the one missing (it pauses every dependant).
          // An opt-in L2/L3 the instance does not offer is a normal configuration.
          <div
            class="mono"
            data-testid="layer-hint"
            style={{
              font: "400 0.6875rem/1rem 'Geist Mono',monospace",
              color: r().id === 'structural' ? 'var(--amber-text)' : 'var(--text3)',
            }}
          >
            {h()}
          </div>
        )}
      </Show>
      {/* The tuning entry sits on the cell's bottom edge, so entries line up across cells.
          It leaves with its card's precondition, so a guard hands focus on if it held it. */}
      <Show when={props.entry}>
        {(e) => (
          <FocusGuard onStranded={props.onStranded} style="display:contents">
            <button
              type="button"
              class="btn-ghost ar-layer-entry"
              data-testid="tuning-entry"
              data-tuning={e().name}
              aria-haspopup="dialog"
              aria-expanded={e().open}
              onClick={() => e().onOpen()}
            >
              {e().label}
            </button>
          </FocusGuard>
        )}
      </Show>
    </div>
  );
}

/** The Targets matrix's id: where a Targets control lands when the band columns are
 * unverified and no notice is showing. */
const TARGETS_ID = 'auto-targets';
/** The matrix's unverified notice — where a Targets control lands while a band write is
 * unverified, so it never lands on a disabled picker. */
const TARGETS_UNVERIFIED_ID = 'auto-targets-unverified';

const STAT_FONT = "font:400 0.6875rem/1rem 'Geist',sans-serif;color:var(--text3)";
const VAL_FONT = "font:500 0.75rem/1rem 'Geist',sans-serif;color:var(--text)";
const NOTE_FONT = "font:400 0.6875rem/1rem 'Geist',sans-serif;color:var(--text3)";

/** The range's zero state, worded as the Auto-performance view always has: no
 * evaluated rows in a range with telemetry before it, or no auto telemetry at all. */
function zeroText(p: AutoPerfVm): string {
  return p.zeroState === 'preCapture'
    ? `No evaluated telemetry in this range — telemetry begins ${new Date(p.telemetrySince ?? 0).toLocaleDateString()}.`
    : 'No auto telemetry yet — route a request with model "auto" to start measuring.';
}

/** The Pipeline's notice slot, above the column header: the figures' range-wide designed
 * states. A failure offers the Retry and shows no figure from any earlier load (the
 * view-model withholds them); a zero range says which zero it is; an older server with no
 * stage breakdown says per-stage counts are unavailable. Loading needs no notice — every
 * row shows its own placeholder.
 *
 * The failure is a load failure on Routing, so it is the shared notice in the Info tone with
 * the `Couldn’t load` title and a ghost Retry (adopt-design-tokens-v2 D15, "Load failures take
 * Info", as `adopt-figure-states` expects to find it). Its sentence is kept as the body. A
 * background refetch keeps the store's error while it runs, so the notice is not re-inserted
 * (or re-announced) by a poll; the Retry clears it, so it leaves as its load starts. The zero
 * and unavailable states keep their own lines: their status-word titles are copy this change
 * does not add, and `adopt-figure-states` owns their wording (notes/flags.md F15). */
function PipelineNotice(props: { vm: PipelineVm; onRetry: () => void }) {
  const { state } = useApp();
  return (
    <Switch>
      <Match when={props.vm.measured === 'error'}>
        <Notice
          tone="info"
          title="Couldn’t load"
          data-testid="auto-load-error"
          style="margin:0 16px 12px"
          action={{ label: 'Retry', onClick: () => props.onRetry() }}
        >
          Couldn’t load the Pipeline’s figures — {state.autoPerf.error}. Routing is unaffected;
          requests keep flowing.
        </Notice>
      </Match>
      <Match when={props.vm.measured === 'zero' && props.vm.perf}>
        {(p) => (
          <div class="ar-notice" data-testid="auto-zero">
            <span>
              <span style="font-weight:600;color:var(--text)">0</span> auto requests evaluated in
              the selected {props.vm.range} range. {zeroText(p())}
            </span>
          </div>
        )}
      </Match>
      <Match when={props.vm.measured === 'unavailable'}>
        <div class="ar-notice" data-testid="auto-unavailable">
          Per-stage counts are unavailable — this server sends no stage breakdown. Classify’s counts
          and the stage details still read the range.
        </div>
      </Match>
    </Switch>
  );
}

/** The Cascade row's savings line (D6). Every honesty rule holds: signed (a negative net
 * is a caution naming the excess, never clamped away), `· est.`, today's-rate framing,
 * the visible coverage, no money when nothing was costable — and it says it covers only
 * the residual cascade's quality-passed requests. While the cascade is not running now,
 * it says its figure comes from cascades earlier in the range. A null aggregation never
 * reaches here (the row renders no savings content at all). */
function Savings(props: {
  sv: NonNullable<AutoPerfVm['savings']>;
  range: Range;
  history: boolean;
}) {
  const sv = () => props.sv;
  return (
    <div class="ar-savings" data-testid="auto-savings">
      <div class="t-caption" style="color:var(--text3)">
        Est. net savings · {props.range}{' '}
        <Show
          when={!sv().moneyless}
          fallback={
            <span style="color:var(--text2)">
              savings unavailable — {sv().coverage} were costable
            </span>
          }
        >
          <Show
            when={!sv().negative}
            fallback={
              <span style="color:var(--amber-text)">
                cheap routing cost {sv().excess} MORE than {sv().basisLabel} would have — review the
                auto_low tier · est.
              </span>
            }
          >
            <span class="ar-savings-amount">{sv().net}</span> · est. at today’s {sv().basisLabel}{' '}
            rate
            <Show when={sv().basisScoped}>
              <span data-testid="ap-basis-scoped">
                {' '}
                · basis = the generic strong target; class-scoped traffic is not separated
              </span>
            </Show>
          </Show>
        </Show>
      </div>
      <div style={NOTE_FONT}>
        Covers only the residual cascade’s quality-passed requests — never all auto traffic ·{' '}
        {sv().coverage}
        {sv().incomplete ? ' (some rows uncostable)' : ''}
        <Show when={props.history}>
          <span data-testid="savings-history"> · from cascades earlier in this range</span>
        </Show>
      </div>
    </div>
  );
}

/** One control per affected band (D5), Strong first, each moving focus to the top of
 * that band's column in the Targets matrix. Named for the COLUMN, never a target: the
 * unroutable count is not scope-aware, so it cannot know which row's target is at fault. */
function GoToColumns(props: { columns: readonly ('strong' | 'cheap')[] }) {
  const { state } = useApp();
  return (
    <For each={props.columns}>
      {(column) => (
        <>
          {' '}
          <button
            type="button"
            style={TEXT_ACTION}
            data-testid="go-to-column"
            data-column={column}
            onClick={() => goToTargets(state, column)}
          >
            Go to {column === 'strong' ? 'Strong' : 'Cheap'} column
          </button>
        </>
      )}
    </For>
  );
}

/**
 * Move focus to the Targets matrix for one band's column (D12). Lands on the column's Any
 * request cell WRAPPER, never its picker — the picker is the next Tab stop, so a stray
 * Arrow key on arrival cannot retarget live routing. While the band columns are
 * unverified or a band write is in flight the pickers are disabled, so it lands on the
 * matrix's unverified notice, or on the matrix itself. Focus never stays on the invoker.
 */
function goToTargets(
  state: { bt: { unverified: boolean; busy: Record<'auto_high' | 'auto_low', boolean> } },
  column: 'strong' | 'cheap',
): void {
  const paused = state.bt.unverified || state.bt.busy.auto_high || state.bt.busy.auto_low;
  const el =
    (paused ? null : document.getElementById(TARGET_ANCHORS[column])) ??
    document.getElementById(TARGETS_UNVERIFIED_ID) ??
    document.getElementById(TARGETS_ID);
  el?.scrollIntoView({ block: 'start' });
  el?.focus({ preventScroll: true });
}

/** A stage's status-now phrase: one line in words — with any "X to Y" pairs drawn with an
 * arrow icon, since no bundled font carries the arrow — then its later lines, each in its
 * own tone. A loading state before the auto-layers view arrives. */
function StatusNow(props: { status: StatusNowVm }) {
  const st = () => props.status;
  const tone = (t: StatusTone): string => (t === 'caution' ? 'var(--amber-text)' : 'var(--text2)');
  return (
    <Show
      when={!st().loading}
      fallback={
        <span data-testid="status-loading">
          <span class="ar-skel ar-skel-short" aria-hidden="true" />
          <span class="sr-only">Loading</span>
        </span>
      }
    >
      <div class="ar-status-line" style={{ color: tone(st().tone) }}>
        <Show when={st().routes} fallback={st().text}>
          {(routes) => (
            <For each={routes()}>
              {(r, i) => (
                <>
                  {i() > 0 ? ' · ' : ''}
                  {r.from} <Icon name="arrowRight" size={11} />
                  <span class="sr-only"> to</span>{' '}
                  {/* Neutral, not accent: the bars are the tab's one accent figure. */}
                  <span class="mono t-label">{r.to}</span>
                </>
              )}
            </For>
          )}
        </Show>
      </div>
      <For each={st().lines}>
        {(line) => (
          <>
            {' '}
            <div
              class="ar-status-sub"
              style={{ color: line.tone === 'caution' ? 'var(--amber-text)' : 'var(--text3)' }}
            >
              {line.text}
            </div>
          </>
        )}
      </For>
    </Show>
  );
}

/**
 * One stage row (split-auto-routing-readout-setup D2). Its cells sit on the Pipeline
 * list's shared column tracks (the `li` and the row are subgrids of the `ol`), so every
 * row's number, name, status, count, share, bar and action box line up by construction
 * rather than by fitting. DOM order — number, name, action, status, figure — is the
 * phone layout's visual order, so no `order` rewrites it; at wider modes the action is
 * PLACED in the last track.
 *
 * Rendered through `<Index>`: the stages never reorder, so the row keeps its identity —
 * and a focused Details button keeps focus — while the view-model recomputes.
 */
function StageRow(props: {
  stage: StageRowVm;
  vm: PipelineVm;
  structural: boolean;
  open: boolean;
  onToggle: (id: StageId) => void;
  onStranded: () => void;
}) {
  const { state } = useApp();
  // Fixed per row: the stages never reorder.
  const id = props.stage.id;
  const detailId = `ar-detail-${id}`;
  const s = () => props.stage;
  const paused = (): string | null => {
    const st = s().status;
    return st?.kind === 'paused' ? st.label : null;
  };
  const count = () => {
    const f = s().figure;
    return f.kind === 'count' ? f : null;
  };
  const verdicts = () => {
    const v = s().verdicts;
    return v?.kind === 'value' ? v : null;
  };
  const track = () => {
    const b = s().bar;
    return b?.kind === 'track' ? b : null;
  };

  return (
    <li class="ar-stage" data-testid="pipeline-stage" data-stage={id}>
      <div class="ar-row">
        <span class="ar-num">{s().number}</span>
        <div class="ar-name">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <span style="font:500 0.8125rem/1.25rem 'Geist',sans-serif;color:var(--text)">
              {s().name}
            </span>
            {/* Paused is stated in text at full contrast — never as dimming. */}
            <Show when={paused()}>
              {(label) => (
                <span class="ar-tag" data-testid="stage-status">
                  {label()}
                </span>
              )}
            </Show>
          </div>
          <div class="mono t-caption" style="color:var(--text3)">
            {s().layer === null ? s().tag : `${s().layer ?? ''} · ${s().tag}`}
          </div>
        </div>
        {/* The action: one box in one track whatever its label (D2). On a capable
            instance, Details on five stages and Targets on Confident band; without the
            structural capability, none — the track stays empty. */}
        <div class="ar-action">
          <Show when={props.structural && s().expandable}>
            <button
              type="button"
              class="btn-ghost ar-act ar-expander"
              aria-expanded={props.open}
              aria-controls={props.open ? detailId : undefined}
              aria-label={`${s().name} details`}
              onClick={() => props.onToggle(id)}
            >
              <span class="ar-act-label">Details</span>
              <Icon name="chevronDown" size={12} />
            </button>
          </Show>
          <Show when={props.structural && s().targetsLink}>
            <FocusGuard onStranded={props.onStranded} style="display:contents">
              <button
                type="button"
                class="btn-ghost ar-act"
                aria-label="Go to Targets, Strong column"
                onClick={() => goToTargets(state, 'strong')}
              >
                <span class="ar-act-label">Targets</span>
                <Icon name="jump" size={12} />
              </button>
            </FocusGuard>
          </Show>
        </div>
        <div class="ar-status" data-testid="stage-status-now">
          <span class="ar-fieldlabel">Status now</span>
          <StatusNow status={s().statusNow} />
        </div>
        <Show when={s().figure.kind !== 'none'}>
          <div class="ar-fig" data-testid="stage-figure" data-kind={s().figure.kind}>
            <span class="ar-fieldlabel">Requests, {props.vm.range}</span>
            <Switch>
              <Match when={count()}>
                {(c) => (
                  <>
                    <span class="ar-figcount">{c().count.toLocaleString()}</span>{' '}
                    <span class="ar-figshare">{c().share ?? ''}</span>{' '}
                  </>
                )}
              </Match>
              <Match when={s().figure.kind === 'placeholder'}>
                <span class="ar-figcount">
                  <span class="ar-skel ar-skel-count" aria-hidden="true" />
                  <span class="sr-only">Loading</span>
                </span>
              </Match>
              <Match when={s().figure.kind === 'unavailable'}>
                <span class="ar-figcount" style="color:var(--text3)">
                  <span aria-hidden="true">—</span>
                  <span class="sr-only">unavailable</span>
                </span>
              </Match>
            </Switch>
            {/* The bar: decorative — the count and share beside it carry the figure in
                text, so no stage is told apart by a bar alone. A zero exit keeps an empty
                track; the zero range, a failure and a missing breakdown draw none. */}
            <span class="ar-figbar" aria-hidden="true">
              <Switch>
                <Match when={track()}>
                  {(t) => (
                    <span
                      class="ar-bar-track"
                      data-testid="stage-bar"
                      data-series="focal"
                      data-measure="pipeline"
                    >
                      <span
                        class="ar-bar-fill"
                        style={{ width: `${String(Math.round(t().ratio * 1000) / 10)}%` }}
                      />
                    </span>
                  )}
                </Match>
                <Match when={s().bar?.kind === 'placeholder'}>
                  <span class="ar-skel ar-skel-line" />
                </Match>
              </Switch>
            </span>
            <Show when={count() !== null && s().caption}>
              {(caption) => (
                <>
                  {' '}
                  <span class="ar-figline" data-testid="stage-caption">
                    {caption()}
                  </span>
                </>
              )}
            </Show>
            {/* Classify only: the verdict counts, worded as verdicts so they cannot be
                read as thresholds, and how many a Workload claim served instead. */}
            <Show when={s().verdicts?.kind === 'placeholder'}>
              <span class="ar-figline">
                <span class="ar-skel ar-skel-note" aria-hidden="true" />
                <span class="sr-only">Loading its verdict counts</span>
              </span>
            </Show>
            <Show when={verdicts()}>
              {(v) => (
                <>
                  {' '}
                  <span class="ar-figline" data-testid="stage-verdicts">
                    {v().text}
                  </span>
                  <Show when={v().claimed}>
                    {(claimed) => (
                      <>
                        {' '}
                        <span class="ar-figline" data-testid="stage-verdicts-claimed">
                          {claimed()}
                        </span>
                      </>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Show>
        {/* The Confident band alert (D5): confident verdicts that went to Default for want of
            a usable target, separate from the status line. Absent while loading, after a
            failure and at zero — never a placeholder. */}
        <Show when={id === 'band' && props.structural && props.vm.bandAlert}>
          {(alert) => (
            <FocusGuard onStranded={props.onStranded} style="display:contents">
              <div class="ar-later ar-alert" data-testid="band-alert" role="note">
                {alert().text}
                <GoToColumns columns={alert().columns} />
              </div>
            </FocusGuard>
          )}
        </Show>
        {/* The Cascade row's savings line: a figure under the figures' designed states — a
            placeholder while loading, nothing after a failure or with no savings data. */}
        <Show when={id === 'cascade' && props.structural}>
          <Switch>
            <Match when={props.vm.measured === 'loading'}>
              <div class="ar-later" data-testid="savings-loading">
                <span class="ar-skel ar-skel-short" aria-hidden="true" />
                <span class="sr-only">Loading its savings</span>
              </div>
            </Match>
            <Match when={props.vm.perf?.savings}>
              {(sv) => (
                <div class="ar-later">
                  <Savings sv={sv()} range={props.vm.range} history={props.vm.cascadeHistory} />
                </div>
              )}
            </Match>
          </Switch>
        </Show>
      </div>
      <Show when={props.open && props.structural}>
        <div
          class="ar-detail"
          id={detailId}
          role="region"
          aria-label={`${s().name} details`}
          data-testid="stage-detail"
        >
          <StageDetail
            id={id}
            stage={s()}
            vm={props.vm}
            structural={props.structural}
            onStranded={props.onStranded}
          />
        </div>
      </Show>
    </li>
  );
}

/** The measured part of a stage detail under the tab's designed states: one neutral
 * placeholder while loading, one plain statement after a failure, and the figures
 * otherwise. `quiet` blocks render nothing in those two states, so a detail with two
 * measured blocks says "loading" once. */
function Measured(props: {
  vm: PipelineVm;
  quiet?: boolean;
  children: (p: () => AutoPerfVm) => JSX.Element;
}) {
  return (
    <Switch>
      <Match when={props.vm.measured === 'loading' && props.quiet !== true}>
        <div class="ar-card" data-testid="detail-loading">
          <span class="ar-skel ar-skel-line" aria-hidden="true" />
          <span class="sr-only">Loading</span>
        </div>
      </Match>
      <Match when={props.vm.measured === 'error' && props.quiet !== true}>
        <div class="ar-card" data-testid="detail-failed" style={STAT_FONT}>
          These figures couldn’t be loaded. Routing is unaffected.
        </div>
      </Match>
      <Match when={props.vm.perf}>{(p) => props.children(p)}</Match>
    </Switch>
  );
}

/** What a stage's detail holds (split-auto-routing-readout-setup D4): MEASURED figures
 * only, framed to the range. Configuration lives in the Setup panel — the layer
 * descriptions in its Layers cells, self-calibration and semantic learning in its
 * drawers — and the routed-here totals and the unevaluated disclosure are the rows' and
 * the Pipeline foot's, so no detail repeats them. Everything here needs the structural
 * capability, with focus handed to the tab control if it goes away under a user inside. */
function StageDetail(props: {
  id: StageId;
  stage: StageRowVm;
  vm: PipelineVm;
  structural: boolean;
  onStranded: () => void;
}) {
  return (
    <>
      <Show when={props.structural}>
        <FocusGuard onStranded={props.onStranded} style="display:contents">
          <Switch>
            <Match when={props.id === 'classify'}>
              <ClassifyDetail vm={props.vm} />
            </Match>
            <Match when={props.id === 'workload'}>
              <Measured vm={props.vm}>{(p) => <WorkloadMix p={p()} />}</Measured>
            </Match>
            <Match when={props.id === 'semantic'}>
              <Measured vm={props.vm}>
                {(p) => <SemanticSlice p={p()} range={props.vm.range} />}
              </Measured>
            </Match>
            <Match when={props.id === 'cascade'}>
              <Measured vm={props.vm}>
                {(p) => <CascadeSplit p={p()} range={props.vm.range} />}
              </Measured>
            </Match>
            <Match when={props.id === 'default'}>
              <Measured vm={props.vm}>{() => <DefaultFigures vm={props.vm} />}</Measured>
            </Match>
          </Switch>
        </FocusGuard>
      </Show>
    </>
  );
}

/** Classify: the band verdicts with the declared share and the band-mix chart (and the
 * workload-routed disclosure beside them), self-calibration, calibration evidence in
 * its own labelled window, and signal quality. */
function ClassifyDetail(props: { vm: PipelineVm }) {
  const { state } = useApp();
  const bucketSecs = () => (state.autoPerf.range === '24h' ? 3600 : 86_400);
  /** Calibration evidence (add-per-agent-calibration-evidence) is CALIBRATION-window
   * scoped and does not follow the tab's range, so it is derived apart from the
   * range's figures — keeping the two from reading as one measurement. Read only
   * while the figures are current: `perf` is null after a failure. */
  const calVm = () => {
    const d = props.vm.perf === null ? undefined : state.autoPerf.data?.calibrationEvidence;
    return d === undefined ? null : toCalibrationEvidenceVm(d);
  };
  const chartData = () =>
    autoSeriesToChart(
      props.vm.perf === null ? [] : (state.autoPerf.data?.series ?? []),
      bucketSecs(),
    );
  return (
    <>
      <Measured vm={props.vm}>
        {(p) => (
          <div class="ar-card" data-testid="ap-band-verdicts">
            <div class="ar-card-title">Band verdicts · {props.vm.range}</div>
            <Show
              when={p().zeroState === 'none'}
              fallback={<div style={STAT_FONT}>{zeroText(p())}</div>}
            >
              <div style="display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 8px">
                <span style={STAT_FONT}>
                  evaluated <span style={VAL_FONT}>{p().evaluated.toLocaleString()}</span>
                </span>
                <span style={STAT_FONT}>
                  ambiguous <span style={VAL_FONT}>{p().ambiguousPct}</span>
                </span>
                <span style={STAT_FONT}>
                  declared <span style={VAL_FONT}>{p().declaredPct}</span>
                </span>
              </div>
              <Show when={p().workloadRouted > 0}>
                <div data-testid="ap-workload-disclosure" style={`${NOTE_FONT};margin:-4px 0 8px`}>
                  The band figures include {p().workloadRouted.toLocaleString()} workload-routed
                  request
                  {p().workloadRouted === 1 ? '' : 's'} — classified like any other, then claimed by
                  a Workload target before any band target was consulted.
                </div>
              </Show>
              <Show when={chartData()[0].length > 0}>
                {/* Neutral (D11): series 0 is a solid --text line with no fill, so the chart
                    never competes with the Pipeline's bars for the tab's one accent. */}
                <Chart
                  data={chartData()}
                  height={110}
                  accentFirst={false}
                  series={[
                    { label: 'high' },
                    { label: 'low', dash: [6, 3] },
                    { label: 'ambiguous', dash: [2, 3] },
                  ]}
                />
                <div
                  class="t-caption"
                  style="display:flex;gap:12px;color:var(--text3);margin-top:4px"
                >
                  <span style="color:var(--text)">— high</span>
                  <span>
                    <span
                      aria-hidden="true"
                      style="display:inline-block;width:14px;height:0;vertical-align:0.22em;border-top:1.5px dashed currentColor"
                    />{' '}
                    low
                  </span>
                  <span>· · ambiguous</span>
                </div>
              </Show>
            </Show>
          </div>
        )}
      </Measured>
      <Measured vm={props.vm} quiet>
        {(p) => (
          <>
            <Show when={calVm()}>{(cal) => <CalibrationEvidence cal={cal()} />}</Show>
            <Show when={p().signalQuality.show}>
              <div class="ar-card" data-testid="signal-quality">
                <Show when={p().signalQuality.flagged.length > 0}>
                  <div style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2);margin-bottom:4px">
                    Signal quality
                  </div>
                  <For each={p().signalQuality.flagged}>
                    {(f) => (
                      <div class="t-caption" style="color:var(--amber-text)">
                        <span style="font-weight:500">{f.label}</span> — {f.detail}{' '}
                        <span class="figure t-caption" style="color:var(--text3)">
                          ({f.distinctScores} distinct score{f.distinctScores === 1 ? '' : 's'})
                        </span>
                        <div style="color:var(--text3);font-size:0.6875rem">
                          {signalQualityGuidance(state.autoLayers)}
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={p().signalQuality.coverage}>
                  <div data-testid="signal-quality-coverage" style={NOTE_FONT}>
                    {p().signalQuality.coverage}
                  </div>
                </Show>
              </div>
            </Show>
          </>
        )}
      </Measured>
    </>
  );
}

/** Calibration evidence, in its own labelled window (it does not follow the tab's
 * range). */
function CalibrationEvidence(props: { cal: CalibrationEvidenceVm }) {
  const cal = () => props.cal;
  return (
    <div class="ar-card" data-testid="calibration-evidence">
      {/* Headed with its OWN window (read from the response, never a literal): the
          calibrator's window, not the Pipeline's range — so the two never read as one
          measurement. `actingFloor` is runtime-configurable for the same reason. */}
      <div
        data-testid="calibration-window"
        style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2);margin-bottom:4px"
      >
        Calibration evidence · last {cal().windowDays} days — its own window, not the Pipeline range
      </div>
      <div data-testid="calibration-geometry" style={NOTE_FONT}>
        Edges are {cal().edgeWidth} wide either side of <span class="figure">{cal().low}</span> /{' '}
        <span class="figure">{cal().high}</span>; {cal().actingFloor} samples needed before an edge
        can move.
      </div>
      {/* THE DECIDING FIGURE. The calibrator acts on the tenant total —
          `calibrationStats` has no agent dimension — so a view showing only per-agent
          rows lets three agents at "30 of 50 needed" read as "no move possible" while
          the tenant sits at 90 and moves (fix-calibration-evidence-honesty). */}
      <div data-testid="cal-total" class="t-caption" style="color:var(--text2);margin-top:4px">
        <span style="font-weight:500">All agents</span>{' '}
        <span style="color:var(--text3);font-size:0.6875rem">— what the calibrator evaluates</span>
        <div style="color:var(--text3);font-size:0.6875rem">
          high — {edgeSummary(cal().total.high, cal().actingFloor)}
        </div>
        <div style="color:var(--text3);font-size:0.6875rem">
          low — {edgeSummary(cal().total.low, cal().actingFloor)}
        </div>
      </div>
      {/* A mechanism that is not running must not be implied by counts shown against a
          floor. */}
      <Show when={!cal().enabled}>
        <div data-testid="cal-disabled" style={NOTE_FONT}>
          Automatic calibration is off for this tenant — these figures are what it would read, not
          work it is doing.
        </div>
      </Show>
      <Show when={cal().contracted}>
        <div data-testid="cal-contracted" class="t-caption" style="color:var(--amber-text)">
          Calibration is halted for this tenant: the edge zones touch, so the calibrator skips it
          whatever evidence accrues.
        </div>
      </Show>
      <Show when={cal().truncated}>
        <div data-testid="cal-truncated" style={NOTE_FONT}>
          Showing the top {cal().agents.length} agents by evidence; the All agents total covers
          every agent.
        </div>
      </Show>
      <For each={cal().agents}>
        {(a) => (
          <div class="t-caption" style="color:var(--text2);margin-top:4px">
            <span style="font-weight:500">{a.label}</span>
            <div
              data-testid={`cal-edge-high-${a.high.state}`}
              style="color:var(--text3);font-size:0.6875rem"
            >
              high — {edgeSummary(a.high, cal().actingFloor)}
            </div>
            <div
              data-testid={`cal-edge-low-${a.low.state}`}
              style="color:var(--text3);font-size:0.6875rem"
            >
              low — {edgeSummary(a.low, cal().actingFloor)}
            </div>
            {/* The reader's next question after a collapse flag. Left to inference it
                produces the WRONG conclusion — "the calibrator is broken" from a correct
                system state. */}
            <Show when={a.deadMiddle}>
              <div data-testid="cal-dead-middle" style="color:var(--text3);font-size:0.6875rem">
                {a.middleWindowRows} decided rows, all between the edge zones — nothing for the
                calibrator to read.
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

/** Workload claim: the workload mix (add-workload-telemetry D7). Attempt-only classes
 * still render when no parent was classified in range; EMPTY only when there are no
 * classified parents AND no classes — keyed on the WORKLOAD since, never the
 * structural telemetrySince. Routed counts ride each row (add-workload-routing). */
function WorkloadMix(props: { p: AutoPerfVm }) {
  const { state } = useApp();
  return (
    <Show
      when={props.p.workload}
      fallback={
        <div class="ar-card" style={STAT_FONT}>
          <Show when={props.p.zeroState === 'none'} fallback={zeroText(props.p)}>
            <div data-testid="workload-mix-empty" class="t-caption">
              {props.p.workloadZero === 'preCapture'
                ? `No workload telemetry in this range — workload capture begins ${new Date(props.p.workloadSince ?? 0).toLocaleDateString()}.`
                : 'No workload telemetry yet — auto requests record a workload class (code / vision / structured / none) once Layer 1 evaluates them.'}
            </div>
          </Show>
        </div>
      }
    >
      {(w) => (
        <div class="ar-card ar-wl" data-testid="workload-mix" style="flex-basis:100%">
          <div style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2);margin-bottom:4px">
            Workload mix{' '}
            <span class="t-caption" style="color:var(--text3)">
              · of workload-classified auto requests
            </span>
          </div>
          <Show when={w().attemptOnly}>
            <div
              data-testid="workload-mix-attempt-only"
              class="t-caption"
              style="color:var(--text3);margin-bottom:4px"
            >
              This range holds attempt spend but no classified parent requests.
            </div>
          </Show>
          <For each={w().rows}>
            {(r) => (
              <div
                class="rs-wrap"
                data-testid="workload-row"
                style="display:flex;align-items:center;gap:8px;font:400 0.6875rem/1rem 'Geist',sans-serif;color:var(--text2)"
              >
                <span style="min-width:96px">{r.label}</span>
                <span class="figure t-caption" style="color:var(--text3);min-width:72px">
                  {r.sharePct} · {r.requests}
                  <Show when={r.class !== 'none'}>
                    <span data-testid="workload-row-routed"> · {r.routed} routed</span>
                  </Show>
                </span>
                <span
                  aria-hidden="true"
                  style={`display:inline-block;height:6px;border-radius:4px;background:var(--text3);max-width:160px;width:${
                    r.sharePct === '0%' ? '2px' : `${r.sharePct.replace('%', '')}%`
                  }`}
                />
                <span class="figure t-caption" style="color:var(--text)">
                  {r.spend === null ? '—' : r.spend}
                  <Show when={r.spend === null}>
                    <span style="color:var(--text3)"> unpriced</span>
                  </Show>
                  <Show when={r.spend !== null && r.unpricedNote !== null}>
                    <span style="color:var(--text3)"> · {r.unpricedNote}</span>
                  </Show>
                </span>
              </div>
            )}
          </For>
          {/* An absent class reads as "no detections", never as missing (D10). */}
          <Show
            when={undetectedClasses(w().rows, state.autoLayers?.semanticWorkload === true).join(
              ', ',
            )}
          >
            {(names) => (
              <div
                data-testid="workload-mix-undetected"
                class="t-caption"
                style="color:var(--text3);margin-top:4px"
              >
                No detections in this range: {names()}
              </div>
            )}
          </Show>
          <Show when={w().coverage}>
            <div
              data-testid="workload-mix-coverage"
              class="t-caption"
              style="color:var(--text3);margin-top:4px"
            >
              {w().coverage}
            </div>
          </Show>
          <Show when={w().revisionNote}>
            <div
              data-testid="workload-mix-revisions"
              class="t-caption"
              style="color:var(--amber-text);margin-top:4px"
            >
              {w().revisionNote}
            </div>
          </Show>
          <div data-testid="workload-mix-footnote" style={`${NOTE_FONT};margin-top:4px`}>
            Structural detection covers code, vision, and structured output;{' '}
            {state.autoLayers?.semanticWorkload === true
              ? 'research and writing are detected by the semantic workload source.'
              : 'research and writing arrive with the semantic workload source.'}{' '}
            Classification itself never routes — a class steers only through its Claim in the
            Targets matrix, and “routed” counts the requests that Claim took.
          </div>
        </div>
      )}
    </Show>
  );
}

/** Semantic: the L2 slice — evaluated and routed per band, the four-way outcome
 * split, and the bundled/learned source split (provenance, never effectiveness). */
function SemanticSlice(props: { p: AutoPerfVm; range: Range }) {
  return (
    <div class="ar-card" data-testid="ap-semantic-slice">
      <div class="ar-card-title">L2 slice · {props.range}</div>
      <Show
        when={props.p.semantic}
        fallback={<div style={STAT_FONT}>Nothing reached Layer 2 in this range.</div>}
      >
        {(sm) => (
          <div style="display:flex;flex-wrap:wrap;gap:4px 16px">
            <span style={STAT_FONT}>
              L2 evaluated <span style={VAL_FONT}>{sm().evaluated.toLocaleString()}</span>
            </span>
            <span style={STAT_FONT}>
              L2 routed <span style={VAL_FONT}>{sm().routed.toLocaleString()}</span>{' '}
              <span class="figure t-caption" style="color:var(--text3)">
                ({sm().routedHigh} high / {sm().routedLow} low)
              </span>
            </span>
            <Show when={sm().routed > 0}>
              <span style={STAT_FONT}>
                success <span style={VAL_FONT}>{sm().successPct}</span>
              </span>
              <span style={STAT_FONT}>
                fallback <span style={VAL_FONT}>{sm().fallbackPct}</span>
              </span>
              <span style={STAT_FONT}>
                error <span style={VAL_FONT}>{sm().errorPct}</span>
              </span>
              <span style={STAT_FONT}>
                cancelled <span style={VAL_FONT}>{sm().cancelledPct}</span>
              </span>
            </Show>
            <span style={STAT_FONT}>
              source <span style={VAL_FONT}>{sm().learned.toLocaleString()}</span> learned ·{' '}
              <span style={VAL_FONT}>{sm().bundled.toLocaleString()}</span> bundled
            </span>
          </div>
        )}
      </Show>
    </div>
  );
}

/** Cascade: the DISJOINT four-way outcome split — never `escalated=false` alone as a
 * pass — and the residual-cascade note whenever earlier layers routed traffic. */
function CascadeSplit(props: { p: AutoPerfVm; range: Range }) {
  return (
    <div class="ar-card" data-testid="ap-cascade">
      <div class="ar-card-title">Cascade outcomes · {props.range}</div>
      <Show
        when={props.p.cascadeRequests > 0}
        fallback={<div style={STAT_FONT}>No cascade attempts in this range.</div>}
      >
        <div style="display:flex;flex-wrap:wrap;gap:4px 16px;margin-bottom:8px">
          <span style={STAT_FONT}>
            <Show when={props.p.cascadeIsResidual}>
              <span class="t-caption" style="color:var(--amber-text)">
                residual cascade ·{' '}
              </span>
            </Show>
            quality-pass <span style={VAL_FONT}>{props.p.passedPct}</span>
          </span>
          <span style={STAT_FONT}>
            escalated <span style={VAL_FONT}>{props.p.escalatedPct}</span>
          </span>
          <span style={STAT_FONT}>
            unknown <span style={VAL_FONT}>{props.p.unknownPct}</span>
          </span>
          <span style={STAT_FONT}>
            failed/cancelled before escalation <span style={VAL_FONT}>{props.p.failedPct}</span>
          </span>
        </div>
      </Show>
      <Show when={props.p.cascadeIsResidual}>
        <div data-testid="ap-residual-note" style={NOTE_FONT}>
          {props.p.residualCauses.semantic && props.p.residualCauses.workload
            ? 'Semantically- and workload-routed requests'
            : props.p.residualCauses.workload
              ? 'Workload-routed requests'
              : 'Semantically-routed requests'}{' '}
          never enter the cascade — the residual-cascade rates and the Cascade row’s savings line
          cover only the traffic those layers left behind, so pre-/post-enable comparisons aren’t
          like-for-like. No figure here measures whether learning improves routing.
        </div>
      </Show>
    </div>
  );
}

/** Default: what fell through and why — the confident bands retained on default for
 * want of a usable target (with the unroutable guidance, naming the Targets matrix
 * rather than a position) and the ambiguous requests no later stage took. */
function DefaultFigures(props: { vm: PipelineVm }) {
  /** A zero range is STATED, as on the other details — never three bare zeros. */
  const zero = (): string | null => {
    const p = props.vm.perf;
    return p !== null && p.zeroState !== 'none' ? zeroText(p) : null;
  };
  return (
    <Show when={props.vm.defaultDetail}>
      {(d) => {
        const unroutable = () => d().unroutable.high + d().unroutable.low;
        const both = () => d().unroutable.high > 0 && d().unroutable.low > 0;
        return (
          <div class="ar-card" data-testid="ap-default">
            <div class="ar-card-title">What fell through · {props.vm.range}</div>
            <Show when={zero()}>{(z) => <div style={STAT_FONT}>{z()}</div>}</Show>
            <Show when={zero() === null}>
              <div style="display:flex;flex-direction:column;gap:4px">
                <span style={STAT_FONT}>
                  confident high, no usable Strong target{' '}
                  <span style={VAL_FONT}>{d().unroutable.high.toLocaleString()}</span>
                </span>
                <span style={STAT_FONT}>
                  confident low, no usable Cheap target{' '}
                  <span style={VAL_FONT}>{d().unroutable.low.toLocaleString()}</span>
                </span>
                <span style={STAT_FONT} data-testid="default-fallthrough">
                  ambiguous, no later stage took it{' '}
                  <span style={VAL_FONT}>{d().fallthrough.toLocaleString()}</span>
                </span>
                <Show when={(d().other ?? 0) > 0}>
                  <span style={STAT_FONT}>
                    other banded requests{' '}
                    <span style={VAL_FONT}>{(d().other ?? 0).toLocaleString()}</span>
                  </span>
                </Show>
              </div>
              <Show when={unroutable() > 0}>
                <div
                  data-testid="default-unroutable"
                  class="t-caption"
                  style="color:var(--amber-text);margin-top:8px"
                >
                  {unroutable()} confident request{unroutable() === 1 ? '' : 's'} fell through to
                  default — check the{' '}
                  {[
                    ...(d().unroutable.high > 0 ? ['strong (auto_high)'] : []),
                    ...(d().unroutable.low > 0 ? ['cheap (auto_low)'] : []),
                  ].join(' and ')}{' '}
                  band{both() ? 's’' : '’s'} missing-or-unusable target in the Targets matrix’s{' '}
                  {both()
                    ? 'Strong and Cheap columns'
                    : d().unroutable.high > 0
                      ? 'Strong column'
                      : 'Cheap column'}
                  .
                  <GoToColumns
                    columns={[
                      ...(d().unroutable.high > 0 ? (['strong'] as const) : []),
                      ...(d().unroutable.low > 0 ? (['cheap'] as const) : []),
                    ]}
                  />
                </div>
              </Show>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

/** The Routing page's two tabs, in display order (redesign-auto-routing-pipeline).
 * Tiers & headers is everything Layer 0 decides before auto runs, and is where a
 * visit lands; Auto routing is everything automatic routing does. */
const ROUTING_TABS: readonly { id: RoutingSection; label: string }[] = [
  { id: 'tiers', label: 'Tiers & headers' },
  { id: 'auto', label: 'Auto routing' },
];

/**
 * A region an availability flip can unmount while the user is inside it — no
 * stranded focus (redesign-auto-routing-pipeline). Removing a focused node resets
 * focus to <body>, and a keyboard user's next Tab restarts from the top of the
 * document. Cleanup runs while the region's DOM is still attached, so this can
 * tell whether focus was inside it; only then, once the removal has flushed, does
 * it hand focus to `onStranded`. A region torn down while focus is elsewhere (the
 * tab control that switched it away, a nav item) does nothing.
 */
function FocusGuard(props: { onStranded: () => void; style?: string; children: JSX.Element }) {
  let region: HTMLDivElement | undefined;
  onCleanup(() => {
    if (region?.contains(document.activeElement) !== true) return;
    queueMicrotask(() => {
      props.onStranded();
    });
  });
  return (
    <div
      ref={(el) => {
        region = el;
      }}
      style={props.style ?? 'display:flex;flex-direction:column;gap:12px'}
    >
      {props.children}
    </div>
  );
}

/**
 * The tier chains (redesign-auto-routing-pipeline D4): every chain card with its
 * drag, keyboard and tap reorder, batch reservation and add-model picker.
 *
 * A component of its own so it owns the drag's teardown. It unmounts when the page
 * does AND when the Tiers & headers tab is left, and a drag must end the same way in
 * both. Keyboard and tap bursts need nothing here: they are coalesced in the store
 * (`commitTierOrder`), so their final order persists after the chains are gone.
 */
function TierChains() {
  const app = useApp();
  const { state } = app;
  // Delete tier starts a request and stays on screen until it commits (D14), per tier.
  const deletingTier = createBusyMap();
  const [drag, setDrag] = createSignal<DragPos | null>(null);
  // The order captured at drag start — `changed` is decided against this, not against
  // whatever a suppressed server response happened to carry.
  let dragStartOrder: string[] = [];
  /**
   * Set while a press is live on a move control, and consumed by the row's `dragstart`.
   *
   * The row is `draggable`, and drag-and-drop selects the nearest draggable ANCESTOR of
   * wherever the gesture began — so pressing a nested button starts the row's drag, and
   * neither `draggable={false}` on the button nor a listener attached to it can stop that
   * (the row, not the button, is the drag source). Cancelling the row's own `dragstart` is
   * the only thing that does. The drag handle deliberately never sets this, which is what
   * keeps it able to start a drag.
   */
  let suppressDrag = false;
  // Scoped to the tier it happened in: every tier renders its own live region, so a
  // page-global message would announce the same move once per tier.
  const [announce, setAnnounce] = createSignal<{ tierId: string; message: string } | null>(null);

  // A drag that never completes (chains torn down mid-drag) must not leave the store
  // holding this tier's reconciliation for the rest of the session. `revert`, not a bare
  // abandon: when only the tab changed, no reload follows to correct the half-dragged
  // order, so the store repaints the chain from server truth as it lets go.
  onCleanup(() => {
    const d = drag();
    if (d !== null) app.endTierDrag(d.tierId, 'revert');
  });

  const modelById = (id: string): Model | undefined => state.allModels.find((m) => m.id === id);
  const providerNameFor = (m: Model | undefined): string | undefined =>
    m === undefined ? undefined : state.providers.find((p) => p.id === m.providerId)?.name;
  const entryLabel = (e: TierEntryDto): string =>
    e.model?.externalModelId ?? modelById(e.modelId)?.externalModelId ?? e.modelId;
  const entries = (tierId: string): TierEntryDto[] => state.tierEntries[tierId] ?? [];
  const indexOfModel = (tierId: string, modelId: string): number =>
    entries(tierId).findIndex((e) => e.modelId === modelId);
  const orderOf = (tierId: string): string[] => entries(tierId).map((e) => e.modelId);

  /** Single completion path for drop AND dragend — idempotent via the drag signal. */
  const finishDrag = (): void => {
    const d = drag();
    if (d === null) return;
    setDrag(null);
    const now = orderOf(d.tierId);
    const changed =
      now.length !== dragStartOrder.length || now.some((id, i) => id !== dragStartOrder[i]);
    app.endTierDrag(d.tierId, changed ? 'changed' : 'unchanged');
  };

  /**
   * Move an entry one position and persist it. Transport-agnostic: the caller supplies
   * what to focus afterwards, because that is the only part that differs between a
   * keypress (focus follows the handle the user was on) and a tap (focus stays on the
   * button the user pressed). Everything above it — resolve, move, commit, announce,
   * refuse at the boundaries — is shared, so the two paths cannot drift.
   */
  const moveEntry = (
    tierId: string,
    modelId: string,
    delta: -1 | 1,
    refocus: (tierId: string, modelId: string, movedTo: number) => void,
  ): boolean => {
    const from = indexOfModel(tierId, modelId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= entries(tierId).length) return false;
    app.moveTierEntry(tierId, from, to);
    void app.commitTierOrder(tierId);
    setAnnounce({
      tierId,
      message: `${entryLabel(entries(tierId)[to]!)} moved to ${posStyle(to)[0]}`,
    });
    // `moveTierEntry` splices in place so `<For>` MOVES the node rather than recreating
    // it — but the node moves, so re-assert focus after the render has flushed.
    queueMicrotask(() => {
      refocus(tierId, modelId, to);
    });
    return true;
  };

  const rowControl = (tierId: string, modelId: string, sel: string): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(
      `[data-tier-id="${tierId}"] [data-model-id="${modelId}"] ${sel}`,
    );

  /** Move an entry one position and keep keyboard focus on the entry that moved. */
  const keyboardMove = (tierId: string, modelId: string, delta: -1 | 1): boolean =>
    moveEntry(tierId, modelId, delta, (tid, mid) => {
      rowControl(tid, mid, '.drag-handle')?.focus();
    });

  /**
   * Move by tapping. Focus stays on the button pressed — yanking it to the drag handle,
   * which is what the keyboard path wants, would move focus off the control the user just
   * touched. When the move lands on a boundary the pressed button becomes disabled, so
   * focus goes to the opposite direction instead; that button is always enabled there,
   * because a successful move implies the chain has at least two entries.
   */
  const buttonMove = (tierId: string, modelId: string, delta: -1 | 1): boolean =>
    moveEntry(tierId, modelId, delta, (tid, mid) => {
      const dir = delta === -1 ? 'up' : 'down';
      const pressed = rowControl(tid, mid, `.chain-move[data-dir="${dir}"]`);
      if (pressed && !pressed.disabled) {
        pressed.focus();
        return;
      }
      rowControl(tid, mid, `.chain-move[data-dir="${dir === 'up' ? 'down' : 'up'}"]`)?.focus();
    });
  const addableModels = (tierId: string): Model[] => {
    const used = new Set(entries(tierId).map((e) => e.modelId));
    // A twin whose BASE is in the chain is still offerable — as a shortcut that
    // reserves that base — so it must not be filtered out by "already used".
    return state.allModels.filter((m) => !used.has(m.id) || isNonRoutableVariant(m.variant));
  };

  /**
   * The model a batch-priced twin lets the tenant reserve here, or null.
   *
   * Offered only when a ROUTABLE sibling base exists on the SAME provider (an
   * orphan twin has no id to store), that provider is batch-capable (a reservation
   * it cannot honour could only produce a rejected save), and that entry is not
   * already reserved (committing would be a no-op). Task 5.3 / dashboard-config.
   */
  const reserveTargetFor = (tierId: string, twin: Model): string | null => {
    const base = twin.baseExternalModelId;
    if (base === null) return null;
    const sibling = state.allModels.find(
      (m) =>
        m.providerId === twin.providerId &&
        m.externalModelId === base &&
        !isNonRoutableVariant(m.variant),
    );
    if (sibling === undefined || !sibling.batchCapable) return null;
    const stored = entries(tierId).find((e) => e.modelId === sibling.id);
    return stored?.mode === 'batch' ? null : sibling.id;
  };

  return (
    <Show
      when={state.routingTiers.length > 0}
      fallback={
        <div class="panel card t-body" style="color:var(--text3)">
          {state.routingLoading ? 'Loading tiers…' : 'No tiers yet.'}
        </div>
      }
    >
      {/* The tier cards are one section of the page: panels 16px apart, while the page
          root sets its sections 24px apart (adopt-design-tokens-v2 task 3.2). */}
      <div style="display:flex;flex-direction:column;gap:16px">
        <For each={state.routingTiers}>
          {(t) => (
            <div
              class="panel"
              style="overflow:hidden;border-radius:10px"
              data-tier-id={t.id}
              data-dragging={drag()?.tierId === t.id ? 'true' : undefined}
            >
              <div class="chain-head">
                <div style="display:flex;align-items:baseline;gap:8px;min-width:0">
                  <span
                    class="mono"
                    id={`tier-h-${t.id}`}
                    style="font:500 0.8125rem/1.25rem 'Geist Mono',monospace;color:var(--text)"
                  >
                    {t.key}
                  </span>
                  <Show when={t.displayName ?? t.description}>
                    <span class="t-dense" style="color:var(--text3)">
                      {t.displayName ?? t.description}
                    </span>
                  </Show>
                </div>
                <div style="display:flex;align-items:center;gap:8px">
                  <span class="chain-hint t-caption" style="color:var(--text3)">
                    {/* The affordance named here has to be the one that exists. On a
                        touch device there is no drag — saying so would send the user
                        looking for a gesture the platform never fires. */}
                    <span class="chain-hint-drag">drag to reorder</span>
                    <span class="chain-hint-tap">use ↑ ↓ to reorder</span> · max {String(5)}
                  </span>
                  <Show when={t.key !== 'default'}>
                    <button
                      type="button"
                      class="icon-x"
                      disabled={deletingTier.busy(t.id)}
                      aria-busy={deletingTier.busy(t.id) ? true : undefined}
                      aria-label={
                        deletingTier.busy(t.id) ? `Deleting tier ${t.key}…` : `Delete tier ${t.key}`
                      }
                      onClick={() => void deletingTier.run(t.id, () => app.deleteTier(t.id))}
                    >
                      <StackedLabel
                        alt={deletingTier.busy(t.id)}
                        rest="Delete"
                        altLabel="Deleting…"
                      />
                    </button>
                  </Show>
                </div>
              </div>
              {/* THE GRID (fix-batch-capability-and-chain-alignment). The tracks
                  belong to the chain, not to the row: a grid declared per row sizes its
                  tracks from that row's own content, which is the ragged layout this
                  replaces. Each row adopts these columns with `subgrid`, so the column
                  edges are shared by definition and sized from the whole chain. */}
              <div class="chain-list">
                <For each={entries(t.id)}>
                  {(entry, mi) => {
                    const dragging = (): boolean => {
                      const d = drag();
                      return d !== null && d.tierId === t.id && d.modelId === entry.modelId;
                    };
                    return (
                      <div
                        class="chain-row"
                        draggable={true}
                        data-model-id={entry.modelId}
                        data-dragging={dragging() ? 'true' : undefined}
                        style={{ opacity: dragging() ? '0.4' : '1' }}
                        onDragStart={(e) => {
                          // A press that began on a move control must not drag the row.
                          // Checked FIRST, before any drag state is entered.
                          if (suppressDrag) {
                            suppressDrag = false;
                            e.preventDefault();
                            return;
                          }
                          dragStartOrder = orderOf(t.id);
                          setAnnounce(null); // a pointer drag retires the last keyboard move
                          setDrag({ tierId: t.id, modelId: entry.modelId });
                          app.beginTierDrag(t.id);
                          if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = 'move';
                            // Firefox refuses to START a drag unless drag data is set.
                            // The displayed model id is not credential material.
                            e.dataTransfer.setData('text/plain', entryLabel(entry));
                          }
                        }}
                        onDragOver={(e) => {
                          // Unconditional — the row stays a valid drop target even when
                          // the midpoint threshold is not met.
                          e.preventDefault();
                          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                          const d = drag();
                          if (d === null || d.tierId !== t.id) return;
                          const from = indexOfModel(t.id, d.modelId);
                          const to = mi();
                          if (from < 0 || from === to) return;
                          // Hysteresis: commit to the hovered row only once the pointer
                          // has crossed ITS midpoint in the direction of travel. Without
                          // this, jitter on a row boundary re-triggers every dragover.
                          const r = e.currentTarget.getBoundingClientRect();
                          const mid = r.top + r.height / 2;
                          if (from < to ? e.clientY <= mid : e.clientY >= mid) return;
                          app.moveTierEntry(t.id, from, to);
                        }}
                        onDrop={(e) => {
                          // Without this the drop resolves as CANCELLED and the browser
                          // plays its snap-back animation — reading as "it didn't take".
                          e.preventDefault();
                          finishDrag();
                        }}
                        onDragEnd={finishDrag}
                      >
                        <button
                          type="button"
                          class="drag-handle"
                          aria-label={`Reorder ${entryLabel(entry)}, position ${String(mi() + 1)} of ${String(entries(t.id).length)}. Press Alt with Arrow Up or Arrow Down to move.`}
                          onKeyDown={(e) => {
                            // Alt is required: swallowing a bare arrow from a focused
                            // control would eat the user's page scroll.
                            if (!e.altKey) return;
                            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                            e.preventDefault();
                            keyboardMove(t.id, entry.modelId, e.key === 'ArrowUp' ? -1 : 1);
                          }}
                        >
                          <Icon name="grip" size={14} />
                        </button>
                        <span
                          class="pos-badge"
                          style={{ background: posStyle(mi())[1], color: posStyle(mi())[2] }}
                        >
                          {posStyle(mi())[0]}
                        </span>
                        <span class="mono chain-id t-label" style="color:var(--text)">
                          {entryLabel(entry)}
                        </span>
                        <span class="figure chain-price t-caption" style="color:var(--text3)">
                          {modelPriceLabel(modelById(entry.modelId))}
                        </span>
                        {/* The batch reservation (add-batch-mode-routing). Shown where
                          the provider can run a batch — and ALWAYS where the entry is
                          already reserved, however the provider looks now, because a
                          PUT resubmits every entry: suppressing it on capability
                          alone would leave a tenant whose provider lost its seam
                          unable to edit the tier at all (D12). */}
                        <Show
                          when={
                            entry.mode === 'batch' ||
                            (modelById(entry.modelId)?.batchCapable ?? false)
                          }
                          /* The empty cell is RENDERED, not omitted: grid auto-placement
                           fills tracks in order, so a missing cell would pull the row's
                           actions one track left and take this row out of line with its
                           neighbours. Announced to nobody. */
                          fallback={<span class="chain-mode chain-mode-blank" aria-hidden="true" />}
                        >
                          <span class="chain-mode">
                            {(() => {
                              const [helpId, setHelpId] = createSignal<string>();
                              return (
                                <>
                                  <Toggle
                                    on={entry.mode === 'batch'}
                                    label={`Reserve ${entryLabel(entry)} for batch only`}
                                    describedBy={helpId()}
                                    onToggle={() =>
                                      app.setTierEntryMode(
                                        t.id,
                                        entry.modelId,
                                        entry.mode === 'batch' ? 'any' : 'batch',
                                      )
                                    }
                                  />
                                  <span
                                    data-mode-label={entry.modelId}
                                    class="t-caption"
                                    style="color:var(--text3)"
                                  >
                                    batch only
                                  </span>
                                  <BatchModeHelp
                                    entryLabel={entryLabel(entry)}
                                    model={modelById(entry.modelId)}
                                    onId={setHelpId}
                                    onPress={() => {
                                      suppressDrag = true;
                                    }}
                                  />
                                </>
                              );
                            })()}
                          </span>
                        </Show>
                        {/* Action region. `display: contents` above the threshold, so at
                          desktop these contribute no box and the row renders exactly as
                          it always has; below it, its own wrapping line. */}
                        <div class="chain-actions">
                          {/* Explicit move controls. Present only where a drag is
                            unavailable — HTML drag-and-drop never fires for touch, so
                            without these a chain cannot be reordered on a phone at all. */}
                          <For each={[-1, 1] as const}>
                            {(delta) => (
                              <button
                                type="button"
                                class="chain-move"
                                data-dir={delta === -1 ? 'up' : 'down'}
                                disabled={
                                  drag() !== null ||
                                  mi() + delta < 0 ||
                                  mi() + delta >= entries(t.id).length
                                }
                                aria-label={`Move ${entryLabel(entry)} ${delta === -1 ? 'up' : 'down'}`}
                                // Suppresses the ROW's drag, which would otherwise start
                                // from a press here: drag-and-drop selects the nearest
                                // draggable ancestor, so neither `draggable={false}` nor a
                                // listener on this button can prevent it — only cancelling
                                // the row's own dragstart can. The handle never sets this,
                                // which is what keeps its drag path working.
                                onPointerDown={() => {
                                  suppressDrag = true;
                                }}
                                onPointerUp={() => {
                                  suppressDrag = false;
                                }}
                                onPointerCancel={() => {
                                  suppressDrag = false;
                                }}
                                onClick={() => {
                                  buttonMove(t.id, entry.modelId, delta);
                                }}
                              >
                                <span aria-hidden="true">{delta === -1 ? '↑' : '↓'}</span>
                              </button>
                            )}
                          </For>
                          <Show when={mi() > 0}>
                            <button
                              type="button"
                              class="link-accent t-caption"

                              onClick={() => app.setPrimaryTierModel(t.id, entry.modelId)}
                            >
                              Make primary
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="icon-x"
                            style="font-size:0.8125rem;padding:0 4px"
                            aria-label={`Remove ${entryLabel(entry)} from tier ${t.key}`}
                            onClick={() => app.removeTierModel(t.id, entry.modelId)}
                          >
                            ×
                          </button>
                        </div>
                        {/* The row's annotations: ONE cell spanning every track, on its own
                          line under the row's content. As siblings of the cells these
                          claimed the actions' column and pushed it out of the row — and
                          a spanning cell placed BEFORE another still auto-places onto the
                          next line, so this has to be the last child. */}
                        <Show
                          when={
                            (entry.mode === 'batch' &&
                              !(modelById(entry.modelId)?.batchCapable ?? false)) ||
                            nonRoutableNote(modelById(entry.modelId)) !== null ||
                            unlistedNote(modelById(entry.modelId), undefined) !== null
                          }
                        >
                          <div class="chain-notes">
                            {/* A reservation the provider can no longer honour. Same
                              treatment as a stored non-routable member, and for the same
                              reason: the tenant's signal must not be a rejected save. */}
                            <Show
                              when={
                                entry.mode === 'batch' &&
                                !(modelById(entry.modelId)?.batchCapable ?? false)
                              }
                            >
                              <span data-mode-orphaned={entry.modelId}>
                                reserved for batch, but this provider has no batch API
                              </span>
                            </Show>
                            {/* A member stored before classification can be batch-only
                              (add-model-variant-detection). Excluding it from the picker
                              is not enough: without this, the tenant's only signal is a
                              rejected save or a request that quietly routes elsewhere. */}
                            <Show when={nonRoutableNote(modelById(entry.modelId))}>
                              {(note) => <span data-nonroutable={entry.modelId}>{note()}</span>}
                            </Show>
                            {/* add-live-subscription-models: the provider's listing no
                              longer offers this member. Routing still sends to it and a
                              rejection walks the chain — this says why it may. */}
                            <Show
                              when={unlistedNote(
                                modelById(entry.modelId),
                                providerNameFor(modelById(entry.modelId)),
                              )}
                            >
                              {(note) => <span data-unlisted-entry={entry.modelId}>{note()}</span>}
                            </Show>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
              <Show when={entries(t.id).length === 0}>
                <div class="t-caption" style="padding:8px 16px;color:var(--text3)">
                  No models — add one below.
                </div>
              </Show>
              {/* Keyboard-reorder announcements. Separate from the ModelPicker's own
                  sr-only result-count status node, which shares this card. */}
              <div role="status" aria-atomic="true" class="sr-only" data-testid="reorder-status">
                {announce()?.tierId === t.id ? announce()?.message : ''}
              </div>
              <div style="padding:8px 16px">
                <ModelPicker
                  groups={groupModelsByProvider(addableModels(t.id), state.providers, (twin) =>
                    reserveTargetFor(t.id, twin),
                  )}
                  labelledBy={`tier-h-${t.id}`}
                  priceLabel={(m) => modelPriceLabel(m)}
                  onCommit={(id, mode) => app.addTierModel(t.id, id, mode)}
                />
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

/** The header-rules card: Layer-0 rules that force a tier per request with the
 * tier header. Only `header` rules are user-editable here; `auto_high`/`auto_low`
 * drive band routing and are configured on the Auto routing tab (deleting them
 * here would silently break structural/cascade). */
function HeaderRules() {
  const app = useApp();
  const { state } = app;
  const f = useFields();
  const modelById = (id: string): Model | undefined => state.allModels.find((m) => m.id === id);
  const providerNameFor = (m: Model | undefined): string | undefined =>
    m === undefined ? undefined : state.providers.find((p) => p.id === m.providerId)?.name;
  const headerRules = () => state.rules.filter((r) => r.matchType === 'header');
  // The rule's × stays on screen until the delete commits (D14). It is a glyph, so its
  // progressive label is its accessible name; the glyph itself does not change, nor its width.
  const deletingRule = createBusyMap();

  return (
    <div class="panel card">
      <div class="section-title" style="margin-bottom:4px">
        Header rules
      </div>
      <div class="t-caption" style="color:var(--text3);margin-bottom:12px">
        Force a tier per request with{' '}
        <span class="mono" style="font-size:0.6875rem">
          x-polyrouter-tier
        </span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <For each={headerRules()}>
          {(ru) => (
            <div
              class="mono t-dense"
              style="display:flex;align-items:center;gap:8px;color:var(--text2);padding:8px;background:var(--bg);border:1px solid var(--border2);border-radius:6px"
            >
              <span style="color:var(--text3)">
                {ru.headerName}: {ru.headerValue ?? ''}
              </span>
              <Icon name="arrowRight" size={12} style="color:var(--faint)" />
              <span style="color:var(--text)">{ru.target}</span>
              <Show
                when={
                  ru.target.startsWith('model:') &&
                  unlistedNote(
                    modelById(ru.target.slice('model:'.length)),
                    providerNameFor(modelById(ru.target.slice('model:'.length))),
                  )
                }
              >
                {(note) => (
                  <span
                    data-unlisted-rule={ru.id}
                    class="t-caption"
                    style="color:var(--amber-text)"
                  >
                    {note()}
                  </span>
                )}
              </Show>
              <button
                type="button"
                class="icon-x"
                style="margin-left:auto"
                disabled={deletingRule.busy(ru.id)}
                aria-busy={deletingRule.busy(ru.id) ? true : undefined}
                aria-label={
                  deletingRule.busy(ru.id)
                    ? `Deleting rule ${ru.headerValue ?? ''} → ${ru.target}…`
                    : `Delete rule ${ru.headerValue ?? ''} → ${ru.target}`
                }
                onClick={() => void deletingRule.run(ru.id, () => app.deleteRule(ru.id))}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <Show when={headerRules().length === 0}>
          <div class="t-caption" style="color:var(--text3);padding:4px 0">
            No header rules yet.
          </div>
        </Show>
      </div>
      <div
        data-testid="header-rule-form"
        style="display:flex;align-items:flex-start;gap:8px;margin-top:8px"
      >
        <div style="flex:1">
          <label class="field-label" for="f-rf-value" style="display:block">
            Header value
          </label>
          <input
            class="input input--mono"
            id="f-rf-value"
            placeholder="e.g. heavy"
            value={state.rf.value}
            aria-invalid={f.invalid('f-rf-value')}
            aria-describedby={f.describedBy('f-rf-value')}
            onBlur={() => f.check('f-rf-value')}
            onInput={(e) => {
              app.setState('rf', 'value', e.currentTarget.value);
              f.edit('f-rf-value');
            }}
          />
          <FieldNote for="f-rf-value" error={f.error('f-rf-value')} />
        </div>
        <div style="flex:1">
          <label class="field-label" for="f-rf-target" style="display:block">
            Target tier
          </label>
          <select
            class="select"
            id="f-rf-target"
            value={state.rf.target}
            aria-invalid={f.invalid('f-rf-target')}
            aria-describedby={f.describedBy('f-rf-target')}
            onBlur={() => f.check('f-rf-target')}
            onChange={(e) => {
              app.setState('rf', 'target', e.currentTarget.value);
              f.edit('f-rf-target');
            }}
          >
            <option value="" disabled selected={state.rf.target === ''}>
              Pick a tier…
            </option>
            <For each={state.routingTiers}>{(t) => <option value={t.key}>{t.key}</option>}</For>
          </select>
          <FieldNote for="f-rf-target" error={f.error('f-rf-target')} />
        </div>
        {/* A 32px secondary, not a 24px ghost: it shares its row with a 32px input and
            select, and one row takes one height (adopt-design-tokens-v2 D4). Its wrapper
            holds a label-height line, so it stays on the fields' line when a field's
            message grows under it (task 8.2). */}
        <div class="field-action">
          <button
            type="button"
            class="btn-cancel"
            disabled={state.rf.busy}
            aria-busy={state.rf.busy ? true : undefined}
            onClick={() => void app.createRule()}
          >
            <StackedLabel alt={state.rf.busy} rest="Add" altLabel="Adding…" />
          </button>
        </div>
      </div>
      <Show when={state.rf.error}>
        <div class="t-caption" style="color:var(--red-text);margin-top:8px">
          {state.rf.error}
        </div>
      </Show>
    </div>
  );
}

export function Routing() {
  const app = useApp();
  const { state } = app;
  const f = useFields();

  onMount(() => void app.loadRouting());
  // The load-failure notice is held while a reload is in flight (D15), so a reload that
  // fails again updates it in place rather than inserting, and announcing, a new one.
  const failure = createHeldFailure(
    () => state.routingError,
    () => state.routingLoading,
  );

  const structural = (): boolean => state.autoLayers?.structuralAvailable === true;
  // Both tabs are always offered (the Auto routing tab shows its layers' unavailable
  // hints when the capability is missing), so the stored choice is exactly what renders.
  const active = (): RoutingSection => state.routingSection;

  const focusActiveSegment = (): void => {
    // Only when focus really was lost: anything that took it on purpose meanwhile keeps it.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="routing-sections"] .rs-seg[aria-pressed="true"]',
      )
      ?.focus();
  };

  // The auto-performance aggregation feeds the Auto routing tab's measured figures —
  // and only them — so it loads on the tab's FIRST SHOW per visit: a visit that never
  // opens the tab never runs the query, a tab round-trip does not refetch, and leaving
  // the page and coming back does (redesign-auto-routing-pipeline D5). The flag is
  // component-local to `Routing()`, which outlives both tabs — not a store flag: a
  // store-level `loaded` gate is exactly what once froze the figures at their first
  // fetch across visits. An effect rather than `onMount` because `autoLayers` arrives
  // async, so at mount we do not yet know whether the capability is there.
  let autoPerfRequested = false;
  createEffect(() => {
    if (active() === 'auto' && structural() && !autoPerfRequested) {
      autoPerfRequested = true;
      void app.loadAutoPerf();
    }
  });

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      {/* The group wrapper, not a new `Segmented` prop: the shared control has three
          other call sites and no reason to change, and the `data-testid` gives tests a
          selector that cannot also match RangeSelector's segments on the Auto routing
          tab. Deliberately NOT a tablist — a half-built one (no `aria-controls`, no
          roving tabindex) announces a contract to assistive tech that this widget does
          not honor. Each segment exposes its selected state as `aria-pressed`. */}
      <div
        role="group"
        aria-label="Routing sections"
        data-testid="routing-sections"
        style="align-self:flex-start"
      >
        <Segmented options={ROUTING_TABS} value={active()} onChange={app.setRoutingSection} />
      </div>

      {/* Info, not Failure (D15): adopt-figure-states requires a failed load to show a neutral
          notice, and rewrites only its body. Its Retry is the notice's ghost action, never an
          accent link — the accent is the Pipeline's bars. */}
      <Show when={failure.message()}>
        {(msg) => (
          <Notice
            tone="info"
            title="Couldn’t load"
            action={{
              label: 'Retry',
              onClick: () => {
                failure.release();
                void app.loadRouting();
              },
            }}
          >
            Couldn’t load routing — {msg()}
          </Notice>
        )}
      </Show>

      <Show when={active() === 'tiers'}>
        {/* Wraps on a phone: at full width the add-tier form sits beside the
            description; squeezed beside it at 390px, the key input shrank to a sliver. */}
        <div
          class="rs-wrap"
          style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px"
        >
          <div class="t-body" style="color:var(--text3)">
            Tier chains route explicit and auto requests; position 0 is the primary, the rest are
            ordered fallbacks (max {String(5)}). Explicit model requests always win.
          </div>
          <div
            class="rs-wrap"
            data-testid="add-tier-row"
            style="display:flex;align-items:flex-start;gap:8px"
          >
            <div style="flex:1 1 150px;min-width:0">
              <label class="field-label" for="f-tf-key" style="display:block">
                New tier key
              </label>
              <input
                class="input input--mono"
                id="f-tf-key"
                style="max-width:150px;width:100%"
                placeholder="e.g. heavy"
                value={state.tf.key}
                aria-invalid={f.invalid('f-tf-key')}
                aria-describedby={f.describedBy('f-tf-key')}
                onBlur={() => f.check('f-tf-key')}
                onInput={(e) => {
                  app.setState('tf', 'key', e.currentTarget.value);
                  f.edit('f-tf-key');
                }}
              />
              <FieldNote for="f-tf-key" error={f.error('f-tf-key')} />
            </div>
            <div class="field-action">
              <button
                type="button"
                class="btn-primary"
                disabled={state.tf.busy}
                aria-busy={state.tf.busy ? true : undefined}
                onClick={() => void app.createTier()}
              >
                <StackedLabel alt={state.tf.busy} rest="Add tier" altLabel="Adding…" />
              </button>
            </div>
          </div>
        </div>
        <Show when={state.tf.error}>
          <div class="t-caption" style="color:var(--red-text)">
            {state.tf.error}
          </div>
        </Show>
        <TierChains />
        <HeaderRules />
      </Show>

      <Show when={active() === 'auto'}>
        <AutoRouting structural={structural()} onStranded={focusActiveSegment} />
      </Show>
    </div>
  );
}
