import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Chart } from '../components/Chart';
import { ModelPicker } from '../components/ModelPicker';
import { RangeSelector } from '../components/RangeSelector';
import { Toggle } from '../components/Toggle';
import type { AutoLayers, TierEntryDto } from '../data/api';
import { autoSeriesToChart, signalQualityGuidance, toAutoPerfVm } from '../data/autoPerf';
import { bandVms, type BandVm } from '../data/bandTargets';
import { toCalibrationVm, toHistoryRows } from '../data/calibration';
import { toLearningHistoryRows, toLearningVm } from '../data/semanticLearning';
import { fmtUsd } from '../data/format';
import { useApp } from '../state/context';
import type { Model, Range } from '../types';
import { Icon } from '../components/Icon';

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

interface LayerRow {
  id: 'structural' | 'cascade' | 'semantic';
  name: string;
  tag: string;
  desc: string;
  on: boolean;
  available: boolean;
  /** The amber line shown when `!available` — names the env that enables it. */
  unavailableHint: string;
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
): Array<{ label: string; models: Model[] }> {
  const byProvider = new Map<string, Model[]>();
  for (const m of models) {
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

/** The BAND TARGETS section (add-band-target-ui): auto_high/auto_low made
 * dashboard-configurable — the effective rule in the PROXY's order, atomic
 * retargeting, snapshot-scoped guarantees with post-mutation reconciles, and
 * every degraded state flagged instead of hidden. */
function BandTargets() {
  const app = useApp();
  const { state } = app;
  const vm = () =>
    bandVms({
      rules: state.rules,
      tiers: state.routingTiers,
      tierEntries: state.tierEntries,
      models: state.allModels,
      providers: state.providers,
      cascadeEffective: state.autoLayers?.cascade ?? false,
      autoPerf: { data: state.autoPerf.data, range: state.autoPerf.range },
    });
  const warnFont = "font:400 11px 'Geist',sans-serif;color:var(--amber)";
  const subFont = "font:400 11.5px 'Geist',sans-serif;color:var(--text3)";
  const busy = (band: 'auto_high' | 'auto_low') => state.bt.busy[band] || state.bt.unverified;

  const targetLine = (b: BandVm) => {
    const t = b.target;
    if (t.kind === 'tier') {
      return (
        <span style="font:500 12px 'Geist',sans-serif;color:var(--accent-deep)">
          tier: {t.key}
          <Show when={!t.empty}>
            <span style={subFont}>
              {' '}
              <Icon name="chevronRight" size={11} /> {t.primary}
              {t.fallbacks > 0
                ? ` +${String(t.fallbacks)} fallback${t.fallbacks === 1 ? '' : 's'}`
                : ''}
              {t.isDefault ? ' · uses the Layer-0 default chain' : ''}
            </span>
          </Show>
        </span>
      );
    }
    if (t.kind === 'model') {
      return (
        <span style="font:500 12px 'Geist',sans-serif;color:var(--accent-deep)">
          {t.label}
          <span style={subFont}>
            {' '}
            {t.provider ?? 'unknown provider'} · {modelPriceLabel(t.model)}
          </span>
        </span>
      );
    }
    if (t.kind === 'unresolved') {
      return (
        <span class="mono" style="font:400 11.5px 'Geist Mono',monospace;color:var(--text2)">
          {t.literal}
        </span>
      );
    }
    return (
      <span style={subFont}>
        Not set — confident {b.band === 'auto_high' ? 'high' : 'low'} verdicts fall through to
        default
      </span>
    );
  };

  const unroutableNote = (b: BandVm) => {
    const u = b.unroutable;
    if (u === null || u.count === 0 || b.usable) return null;
    return (
      <span style={subFont}>
        {' '}
        ({u.count} unroutable in the selected {u.range} range)
      </span>
    );
  };

  const bandRow = (b: BandVm, title: string) => (
    <div style="padding:8px 0;border-top:1px solid var(--border2)">
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
        <span style="font:600 10.5px 'Geist',sans-serif;letter-spacing:0.04em;color:var(--text2);min-width:52px">
          {title}
        </span>
        <span class="mono" style="font:400 10px 'Geist Mono',monospace;color:var(--text3)">
          {b.band}
        </span>
        {targetLine(b)}
        {unroutableNote(b)}
        <select
          aria-label={`${title} target`}
          disabled={busy(b.band)}
          style="font:400 11px 'Geist',sans-serif;color:var(--text2);background:var(--chip);border:1px solid var(--border);border-radius:5px;padding:2px 6px;max-width:180px"
          onChange={(e) => {
            const v = e.currentTarget.value;
            // Snap back to the placeholder — this is an ACTION picker, not a
            // value display (the row's target line shows the current state).
            e.currentTarget.selectedIndex = 0;
            if (v !== '') void app.setBandTarget(b.band, v);
          }}
        >
          {/* `selected` pins the placeholder at first render — without it the
              browser displays the first REAL option ("default") while nothing
              is actually chosen (the v0.5.0 display bug). */}
          <option value="" disabled selected>
            {b.target.kind === 'unset' ? 'Set target…' : 'Change…'}
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
        <Show when={b.effective !== null}>
          <button
            type="button"
            disabled={busy(b.band)}
            style="font:400 11px 'Geist',sans-serif;color:var(--text3);cursor:pointer;text-decoration:underline"
            onClick={() => void app.clearBand(b.band)}
          >
            Clear
          </button>
        </Show>
      </div>
      <Show when={state.bt.errors[b.band]}>
        <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">
          {state.bt.errors[b.band]}
        </div>
      </Show>
      <Show when={b.target.kind === 'tier' && b.target.empty}>
        <div style={warnFont}>
          This tier has no models — the band steers nothing: confident verdicts fall through to
          default and the cascade cannot plan.
        </div>
      </Show>
      <Show when={b.target.kind === 'unresolved'}>
        <div style={warnFont}>
          Target unresolved — requests fall through to default.{' '}
          {b.target.kind === 'unresolved' && b.target.parsed === 'tier'
            ? 'Recreating the tier key rebinds this rule.'
            : b.target.kind === 'unresolved' && b.target.parsed === 'model'
              ? 'The model no longer exists — pick a new target.'
              : 'The stored target is malformed — pick a new target.'}
        </div>
      </Show>
      <Show when={b.shadowed.length > 0}>
        <div style={warnFont}>
          {b.shadowed.length} shadowed duplicate rule{b.shadowed.length === 1 ? '' : 's'} —{' '}
          <button
            type="button"
            disabled={busy(b.band)}
            style="font:400 11px 'Geist',sans-serif;color:var(--text2);cursor:pointer;text-decoration:underline"
            onClick={() => void app.cleanShadowed(b.band)}
          >
            clean up
          </button>
        </div>
      </Show>
    </div>
  );

  return (
    <div class="panel card">
      <div class="section-title" style="margin-bottom:2px">
        Band targets
      </div>
      <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);margin-bottom:8px">
        Route confident verdicts directly; the cascade tries cheap first for the rest.
      </div>
      <Show when={state.bt.unverified}>
        <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">
          Routing may have changed — the refresh failed.{' '}
          <button
            type="button"
            style="font:400 11px 'Geist',sans-serif;color:var(--text2);cursor:pointer;text-decoration:underline"
            onClick={() => void app.retryRulesReconcile()}
          >
            Retry
          </button>
        </div>
      </Show>

      {bandRow(vm().high, 'STRONG')}
      {bandRow(vm().low, 'CHEAP')}
      <Show when={vm().cascadeNeedsBoth}>
        <div style={warnFont}>
          Cascade needs both bands usable — ambiguous requests stay on the default tier until then.
        </div>
      </Show>
      <Show when={vm().sameDestination}>
        <div style={warnFont}>
          Both bands resolve to the same destination — the cascade would retry the same chain.
        </div>
      </Show>
    </div>
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
    <Show when={vm()} keyed>
      {(v) => (
        <div class="panel card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="section-title">Self-calibration</div>
            <Toggle
              on={v.enabled}
              size="sm"
              label="Self-calibration"
              onToggle={() => void app.setCalibration(!v.enabled)}
            />
          </div>
          <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5;margin-bottom:8px">
            Conservatively narrows the ambiguous band from your own cascade outcomes — never a fix
            for confident-band mistakes. Every change is listed below and one click from undone.
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <span class="mono" style="font:500 12px 'Geist Mono',monospace;color:var(--text)">
              {v.thresholdsLine}
            </span>
            <span
              style={{
                font: "400 10.5px 'Geist',sans-serif",
                color: v.tag === 'calibrated' ? 'var(--accent-deep)' : 'var(--text3)',
                background: v.tag === 'calibrated' ? 'var(--accent-bg)' : 'var(--chip)',
                padding: '2px 7px',
                'border-radius': '5px',
              }}
            >
              {v.tag}
            </span>
            <Show when={v.showRevert}>
              <button
                type="button"
                class="btn-ghost"
                style="font:400 11px 'Geist',sans-serif;color:var(--text2);cursor:pointer;text-decoration:underline"
                onClick={() => void app.revertCalibration()}
              >
                Revert to defaults
              </button>
            </Show>
          </div>
          <Show when={state.calHistory.error}>
            <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">
              Couldn’t load calibration history — {state.calHistory.error}{' '}
              <button
                type="button"
                style="font:400 11px 'Geist',sans-serif;color:var(--text2);cursor:pointer;text-decoration:underline"
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
                <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);padding:2px 0">
                  {state.calHistory.loaded ? 'No calibration changes yet.' : 'Loading…'}
                </div>
              </Show>
            }
          >
            <For each={rows()}>
              {(r) => (
                <div style="display:flex;align-items:baseline;gap:10px;padding:4px 0;border-top:1px solid var(--border2)">
                  <span
                    class="mono"
                    style="font:400 10.5px 'Geist Mono',monospace;color:var(--text3);min-width:70px"
                  >
                    {r.date}
                  </span>
                  <span
                    style={{
                      font: "400 11.5px 'Geist',sans-serif",
                      color: r.kind === 'move' ? 'var(--text)' : 'var(--text2)',
                    }}
                  >
                    {r.movement}
                  </span>
                  <Show when={r.evidence !== ''}>
                    <span style="font:400 10.5px 'Geist',sans-serif;color:var(--text3)">
                      {r.evidence}
                    </span>
                  </Show>
                  <Show when={r.kind !== 'move'}>
                    <span style="font:400 10px 'Geist',sans-serif;color:var(--text3);background:var(--chip);padding:1px 6px;border-radius:4px">
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
      <div class="panel card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <div class="section-title">Semantic learning</div>
          <Toggle
            on={learningOn()}
            size="sm"
            label="Semantic learning"
            onToggle={() => void app.setSemanticLearning(!learningOn())}
          />
        </div>
        <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5;margin-bottom:8px">
          Learns only from your own cascade outcomes — nudges the ambiguous-slice centroids to orbit
          the bundled anchors, never beyond. Off by default and one click from reverted; it never
          measures whether learning helps, only what it has absorbed.
        </div>
        <Show when={state.semLearn.error}>
          <div style="font:400 11px 'Geist',sans-serif;color:var(--red);margin-bottom:8px">
            Couldn’t load learning status — {state.semLearn.error}{' '}
            <button
              type="button"
              style="font:400 11px 'Geist',sans-serif;color:var(--text2);cursor:pointer;text-decoration:underline"
              onClick={() => void app.loadSemanticLearning()}
            >
              Retry
            </button>
          </div>
        </Show>
        <Show when={vm()} keyed>
          {(v) => (
            <>
              <div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:8px">
                <span class="mono" style="font:500 12px 'Geist Mono',monospace;color:var(--text)">
                  {v.samplesLine}
                </span>
                <span
                  style={{
                    font: "400 10.5px 'Geist',sans-serif",
                    color: 'var(--text3)',
                    background: 'var(--chip)',
                    padding: '2px 7px',
                    'border-radius': '5px',
                  }}
                >
                  {v.sourceLine}
                </span>
                <span style="font:400 10.5px 'Geist',sans-serif;color:var(--text3)">
                  {v.lastAppliedLine}
                </span>
                <Show when={v.showRevert}>
                  <Show
                    when={confirming()}
                    fallback={
                      <button
                        type="button"
                        class="btn-ghost"
                        style="font:400 11px 'Geist',sans-serif;color:var(--text2);cursor:pointer;text-decoration:underline"
                        onClick={() => setConfirming(true)}
                      >
                        Revert to bundled
                      </button>
                    }
                  >
                    <span style="font:400 11px 'Geist',sans-serif;color:var(--text2)">
                      Revert all learned centroids?
                    </span>
                    <button
                      type="button"
                      class="btn-ghost btn-ghost--amber"
                      style="font:400 11px 'Geist',sans-serif;cursor:pointer"
                      onClick={() => {
                        setConfirming(false);
                        void app.revertSemanticLearning();
                      }}
                    >
                      Confirm revert
                    </button>
                    <button
                      type="button"
                      class="btn-cancel"
                      style="font:400 11px 'Geist',sans-serif;cursor:pointer"
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                  </Show>
                </Show>
              </div>
              <Show when={v.staleReason} keyed>
                {(reason) => (
                  <div
                    class="mono"
                    style="font:400 10.5px 'Geist Mono',monospace;color:var(--amber);margin-bottom:8px"
                  >
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
              <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);padding:2px 0">
                {state.semLearn.loaded ? 'No learning events yet.' : 'Loading…'}
              </div>
            }
          >
            <For each={rows()}>
              {(r) => (
                <div style="display:flex;align-items:baseline;gap:10px;padding:4px 0;border-top:1px solid var(--border2)">
                  <span
                    class="mono"
                    style="font:400 10.5px 'Geist Mono',monospace;color:var(--text3);min-width:70px"
                  >
                    {r.date}
                  </span>
                  <span style="font:400 10px 'Geist',sans-serif;color:var(--text3);background:var(--chip);padding:1px 6px;border-radius:4px">
                    {r.trigger}
                  </span>
                  <span class="mono" style="font:400 11px 'Geist Mono',monospace;color:var(--text2)">
                    {r.samples}
                  </span>
                  <Show when={r.evidence !== ''}>
                    <span
                      class="mono"
                      style="font:400 10.5px 'Geist Mono',monospace;color:var(--text3)"
                    >
                      {r.evidence}
                    </span>
                  </Show>
                  <Show when={r.reason !== ''}>
                    <span style="font:400 10.5px 'Geist',sans-serif;color:var(--text3)">
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

/** The AUTO PERFORMANCE section (add-auto-performance-view): evidence beside
 * the toggles. Locally-ranged (7d default); every figure comes verbatim from
 * the aggregation endpoint via the pure view-model. */
function AutoPerformance() {
  const app = useApp();
  const { state } = app;
  // Refresh on EVERY mount (the page convention — loadRouting does the same):
  // a `loaded`-gated effect froze the card at its first fetch across visits.
  // Already-loaded data stays visible while the refetch replaces it (the
  // loader's seq/gen/range guards make late responses harmless).
  onMount(() => void app.loadAutoPerf());
  const vm = () => toAutoPerfVm(state.autoPerf.data);
  const bucketSecs = () => (state.autoPerf.range === '24h' ? 3600 : 86_400);
  const chartData = () => autoSeriesToChart(state.autoPerf.data?.series ?? [], bucketSecs());
  const statFont = "font:400 11.5px 'Geist',sans-serif;color:var(--text3)";
  const valFont = "font:500 12px 'Geist',sans-serif;color:var(--text)";
  return (
    <div class="panel card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div class="section-title">Auto performance</div>
        <RangeSelector
          value={state.autoPerf.range}
          onChange={(r: Range) => app.setAutoPerfRange(r)}
        />
      </div>
      <Show when={state.autoPerf.error}>
        <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">
          Couldn’t load auto performance — {state.autoPerf.error}
        </div>
      </Show>
      <Show when={state.autoPerf.data === null && state.autoPerf.error === null}>
        <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);padding:6px 0">
          Loading…
        </div>
      </Show>
      <Show when={vm()} keyed>
        {(v) => (
          <Show
            when={v.zeroState === 'none'}
            fallback={
              <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);padding:6px 0">
                {v.zeroState === 'preCapture'
                  ? `No evaluated telemetry in this range — telemetry begins ${new Date(v.telemetrySince ?? 0).toLocaleDateString()}.`
                  : 'No auto telemetry yet — route a request with model "auto" to start measuring.'}
              </div>
            }
          >
            <div style="display:flex;flex-wrap:wrap;gap:16px;margin:6px 0 10px">
              <span style={statFont}>
                evaluated <span style={valFont}>{v.evaluated.toLocaleString()}</span>
              </span>
              <span style={statFont}>
                ambiguous <span style={valFont}>{v.ambiguousPct}</span>
              </span>
              <span style={statFont}>
                declared <span style={valFont}>{v.declaredPct}</span>
              </span>
              <Show when={v.cascadeRequests > 0}>
                <span style={statFont}>
                  <Show when={v.cascadeIsResidual}>
                    <span style="font:400 10px 'Geist',sans-serif;color:var(--amber)">
                      residual cascade ·{' '}
                    </span>
                  </Show>
                  quality-pass <span style={valFont}>{v.passedPct}</span>
                </span>
                <span style={statFont}>
                  escalated <span style={valFont}>{v.escalatedPct}</span>
                </span>
                <span style={statFont}>
                  unknown <span style={valFont}>{v.unknownPct}</span>
                </span>
                <span style={statFont}>
                  failed/cancelled before escalation <span style={valFont}>{v.failedPct}</span>
                </span>
              </Show>
            </div>
            <Show when={v.semantic} keyed>
              {(sm) => (
                <div style="display:flex;flex-wrap:wrap;gap:16px;margin:0 0 10px">
                  <span style={statFont}>
                    L2 evaluated <span style={valFont}>{sm.evaluated.toLocaleString()}</span>
                  </span>
                  <span style={statFont}>
                    L2 routed <span style={valFont}>{sm.routed.toLocaleString()}</span>{' '}
                    <span
                      class="mono"
                      style="font:400 10.5px 'Geist Mono',monospace;color:var(--text3)"
                    >
                      ({sm.routedHigh} high / {sm.routedLow} low)
                    </span>
                  </span>
                  <Show when={sm.routed > 0}>
                    <span style={statFont}>
                      success <span style={valFont}>{sm.successPct}</span>
                    </span>
                    <span style={statFont}>
                      fallback <span style={valFont}>{sm.fallbackPct}</span>
                    </span>
                    <span style={statFont}>
                      error <span style={valFont}>{sm.errorPct}</span>
                    </span>
                    <span style={statFont}>
                      cancelled <span style={valFont}>{sm.cancelledPct}</span>
                    </span>
                  </Show>
                  <span style={statFont}>
                    source <span style={valFont}>{sm.learned.toLocaleString()}</span> learned ·{' '}
                    <span style={valFont}>{sm.bundled.toLocaleString()}</span> bundled
                  </span>
                </div>
              )}
            </Show>
            <Show when={v.cascadeIsResidual}>
              <div style="font:400 10.5px 'Geist',sans-serif;color:var(--text3);margin:-4px 0 10px;line-height:1.5">
                Semantically-routed requests never enter the cascade — the residual-cascade rates and
                estimated savings above cover only the traffic L2 left behind, so pre-/post-enable
                comparisons aren’t like-for-like. No figure here measures whether learning improves
                routing.
              </div>
            </Show>
            <Show when={v.unroutable > 0}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--amber);margin-bottom:8px">
                {v.unroutable} confident request{v.unroutable === 1 ? '' : 's'} fell through to
                default — check the{' '}
                {[
                  ...((state.autoPerf.data?.bands.high.unroutable ?? 0) > 0
                    ? ['strong (auto_high)']
                    : []),
                  ...((state.autoPerf.data?.bands.low.unroutable ?? 0) > 0
                    ? ['cheap (auto_low)']
                    : []),
                ].join(' and ')}{' '}
                band
                {(state.autoPerf.data?.bands.high.unroutable ?? 0) > 0 &&
                (state.autoPerf.data?.bands.low.unroutable ?? 0) > 0
                  ? 's’'
                  : '’s'}{' '}
                missing-or-unusable target in Band targets above.
              </div>
            </Show>
            <Show when={v.signalQuality.show}>
              <div data-testid="signal-quality" style="margin-bottom:10px">
                <Show when={v.signalQuality.flagged.length > 0}>
                  <div style="font:500 11px 'Geist',sans-serif;color:var(--text2);margin-bottom:4px">
                    Signal quality
                  </div>
                  <For each={v.signalQuality.flagged}>
                    {(f) => (
                      <div style="font:400 11px 'Geist',sans-serif;color:var(--amber);line-height:1.5">
                        <span style="font-weight:500">{f.label}</span> — {f.detail}{' '}
                        <span class="mono" style="font:400 10.5px 'Geist Mono',monospace;color:var(--text3)">
                          ({f.distinctScores} distinct score{f.distinctScores === 1 ? '' : 's'})
                        </span>
                        <div style="color:var(--text3);font-size:10.5px">
                          {signalQualityGuidance(state.autoLayers)}
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={v.signalQuality.coverage}>
                  <div
                    data-testid="signal-quality-coverage"
                    style="font:400 10.5px 'Geist',sans-serif;color:var(--text3);line-height:1.5"
                  >
                    {v.signalQuality.coverage}
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={v.savings} keyed>
              {(sv) => (
                <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text2);margin-bottom:10px">
                  <Show
                    when={!sv.moneyless}
                    fallback={
                      <span style="color:var(--text3)">
                        savings unavailable — {sv.coverage} were costable
                      </span>
                    }
                  >
                    <Show
                      when={!sv.negative}
                      fallback={
                        <span style="color:var(--amber)">
                          cheap routing cost {sv.excess} MORE than {sv.basisLabel} would have —
                          review the auto_low tier · est.
                        </span>
                      }
                    >
                      est. net savings <span style={valFont}>{sv.net}</span> · at today’s{' '}
                      {sv.basisLabel} rate · est.
                    </Show>
                  </Show>{' '}
                  <span style="color:var(--text3);font-size:10.5px">
                    {sv.coverage}
                    {sv.incomplete ? ' (some rows uncostable)' : ''}
                  </span>
                </div>
              )}
            </Show>
            <Show when={chartData()[0].length > 0}>
              <Chart
                data={chartData()}
                height={110}
                series={[
                  { label: 'high' },
                  { label: 'low', dash: [6, 3] },
                  { label: 'ambiguous', dash: [2, 3] },
                ]}
              />
              <div style="display:flex;gap:12px;font:400 10.5px 'Geist',sans-serif;color:var(--text3);margin-top:4px">
                <span style="color:var(--accent-deep)">— high</span>
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
        )}
      </Show>
    </div>
  );
}

function structuralLayers(al: AutoLayers | null): LayerRow[] {
  return [
    {
      id: 'structural',
      name: 'L1 · Structural',
      tag: '<1ms, local',
      desc: 'Language-neutral features; system prompts fingerprinted & subtracted.',
      on: al?.structural ?? false,
      available: al?.structuralAvailable ?? false,
      unavailableHint: 'off instance-wide (ROUTING_AUTO_LAYERS)',
    },
    {
      id: 'semantic',
      name: 'L2 · Semantic',
      tag: 'local embed',
      desc: "Embedding classifier over the ambiguous slice — routes what structural can't read.",
      on: al?.semantic ?? false,
      available: al?.semanticAvailable ?? false,
      unavailableHint: 'off instance-wide — optional module; set SEMANTIC_MODEL_PATH to enable',
    },
    {
      id: 'cascade',
      name: 'L3 · Cascade',
      tag: 'cheap-first',
      desc: 'Ambiguous requests try the cheap model, escalate on a failed quality check.',
      on: al?.cascade ?? false,
      available: al?.cascadeAvailable ?? false,
      unavailableHint: 'off instance-wide (ROUTING_AUTO_LAYERS)',
    },
  ];
}

export function Routing() {
  const app = useApp();
  const { state } = app;
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

  onMount(() => void app.loadRouting());
  // A drag that never completes (page torn down mid-drag) must not leave the store
  // holding this tier's reconciliation for the rest of the session.
  onCleanup(() => {
    const d = drag();
    if (d !== null) app.endTierDrag(d.tierId, 'abandon');
  });

  const modelById = (id: string): Model | undefined => state.allModels.find((m) => m.id === id);
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
    return state.allModels.filter((m) => !used.has(m.id));
  };
  // Only `header` rules are user-editable here; `auto_high`/`auto_low` drive band
  // routing and are read-only (deleting them would silently break structural/cascade).
  const headerRules = () => state.rules.filter((r) => r.matchType === 'header');

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px">
        <div style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
          Tier chains route explicit and auto requests; position 0 is the primary, the rest are
          ordered fallbacks (max {String(5)}). Explicit model requests always win.
        </div>
        <div class="rs-wrap" style="display:flex;align-items:flex-end;gap:6px">
          <div style="flex:1 1 150px;min-width:0">
            <label class="field-label" for="f-tf-key" style="display:block">
              New tier key
            </label>
            <input
              class="input mono"
              id="f-tf-key"
              style="font:400 12px 'Geist Mono',monospace;max-width:150px;width:100%"
              placeholder="e.g. heavy"
              value={state.tf.key}
              onInput={(e) => app.setState('tf', 'key', e.currentTarget.value)}
            />
          </div>
          <button
            type="button"
            class="btn-primary"
            disabled={state.tf.busy}
            onClick={() => void app.createTier()}
          >
            {state.tf.busy ? 'Adding…' : 'Add tier'}
          </button>
        </div>
      </div>
      <Show when={state.tf.error}>
        <div style="font:400 11px 'Geist',sans-serif;color:var(--red)">{state.tf.error}</div>
      </Show>
      <Show when={state.routingError}>
        <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--red-bg);border:1px solid var(--red);border-radius:8px;font:500 12px 'Geist',sans-serif;color:var(--red)">
          <span style="flex:1">Couldn’t load routing — {state.routingError}</span>
          <button
            type="button"
            class="link-accent"
            style="font-weight:600"
            onClick={() => void app.loadRouting()}
          >
            Retry
          </button>
        </div>
      </Show>

      <div class="rs-grid-2-1" style="display:grid;gap:12px;align-items:start">
        <div style="display:flex;flex-direction:column;gap:12px">
          <Show
            when={state.routingTiers.length > 0}
            fallback={
              <div class="panel card" style="font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
                {state.routingLoading ? 'Loading tiers…' : 'No tiers yet.'}
              </div>
            }
          >
            <For each={state.routingTiers}>
              {(t) => (
                <div
                  class="panel"
                  style="overflow:hidden;border-radius:10px"
                  data-tier-id={t.id}
                  data-dragging={drag()?.tierId === t.id ? 'true' : undefined}
                >
                  <div class="chain-head">
                    <div style="display:flex;align-items:baseline;gap:10px;min-width:0">
                      <span
                        class="mono"
                        id={`tier-h-${t.id}`}
                        style="font:500 13.5px 'Geist Mono',monospace;color:var(--text)"
                      >
                        {t.key}
                      </span>
                      <Show when={t.displayName ?? t.description}>
                        <span style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
                          {t.displayName ?? t.description}
                        </span>
                      </Show>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px">
                      <span
                        class="chain-hint"
                        style="font:400 11px 'Geist',sans-serif;color:var(--text3)"
                      >
                        {/* The affordance named here has to be the one that exists. On a
                            touch device there is no drag — saying so would send the user
                            looking for a gesture the platform never fires. */}
                        <span class="chain-hint-drag">drag to reorder</span>
                        <span class="chain-hint-tap">use ↑ ↓ to reorder</span> · max{' '}
                        {String(5)}
                      </span>
                      <Show when={t.key !== 'default'}>
                        <button
                          type="button"
                          class="icon-x"
                          aria-label={`Delete tier ${t.key}`}
                          onClick={() => void app.deleteTier(t.id)}
                        >
                          Delete
                        </button>
                      </Show>
                    </div>
                  </div>
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
                          <span
                            class="mono chain-id"
                            style="font:500 12px 'Geist Mono',monospace;color:var(--text);min-width:0"
                          >
                            {entryLabel(entry)}
                          </span>
                          <span
                            class="mono chain-price"
                            style="margin-left:auto;font:400 11px 'Geist Mono',monospace;color:var(--text3)"
                          >
                            {modelPriceLabel(modelById(entry.modelId))}
                          </span>
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
                                class="link-accent"
                                style="font:400 11px 'Geist',sans-serif"
                                onClick={() => app.setPrimaryTierModel(t.id, entry.modelId)}
                              >
                                Make primary
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="icon-x"
                              style="font-size:14px;padding:0 2px"
                              aria-label={`Remove ${entryLabel(entry)} from tier ${t.key}`}
                              onClick={() => app.removeTierModel(t.id, entry.modelId)}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                  <Show when={entries(t.id).length === 0}>
                    <div style="padding:9px 18px;font:400 11.5px 'Geist',sans-serif;color:var(--text3)">
                      No models — add one below.
                    </div>
                  </Show>
                  {/* Keyboard-reorder announcements. Separate from the ModelPicker's own
                      sr-only result-count status node, which shares this card. */}
                  <div role="status" aria-atomic="true" class="sr-only" data-testid="reorder-status">
                    {announce()?.tierId === t.id ? announce()?.message : ''}
                  </div>
                  <div style="padding:8px 18px">
                    <ModelPicker
                      groups={groupModelsByProvider(addableModels(t.id), state.providers)}
                      labelledBy={`tier-h-${t.id}`}
                      priceLabel={(m) => modelPriceLabel(m)}
                      onCommit={(id) => app.addTierModel(t.id, id)}
                    />
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="panel card">
            <div class="section-title" style="margin-bottom:4px">
              Automatic routing
            </div>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);margin-bottom:12px;line-height:1.5">
              Applies only when an agent asks for model{' '}
              <span
                class="mono"
                style="font-size:11px;background:var(--chip);padding:1px 5px;border-radius:4px"
              >
                auto
              </span>
              . Explicit requests always win.
            </div>
            <div style="display:flex;flex-direction:column;gap:10px">
              <For each={structuralLayers(state.autoLayers)}>
                {(l) => (
                  <div style={{ display: 'flex', 'align-items': 'flex-start', gap: '10px' }}>
                    <div style="margin-top:1px">
                      <Toggle
                        on={l.on}
                        locked={!l.available}
                        label={`Toggle ${l.name}`}
                        onToggle={() => void app.toggleAutoLayer(l.id)}
                      />
                    </div>
                    <div style={{ opacity: l.available ? '1' : '0.55' }}>
                      <div style="font:500 12px 'Geist',sans-serif;color:var(--text)">
                        {l.name}{' '}
                        <span
                          class="mono"
                          style="font:400 10.5px 'Geist Mono',monospace;color:var(--text3)"
                        >
                          {l.tag}
                        </span>
                      </div>
                      <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.45">
                        {l.desc}
                      </div>
                      <Show when={!l.available}>
                        <div
                          class="mono"
                          style="font:400 10px 'Geist Mono',monospace;color:var(--amber);margin-top:2px"
                        >
                          {l.unavailableHint}
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <div style="margin-top:12px;padding:9px 11px;background:var(--accent-bg);border-radius:7px;font:400 11px 'Geist',sans-serif;color:var(--text2);line-height:1.5">
              If a smart layer is down,{' '}
              <span class="mono" style="font-size:10.5px">
                auto
              </span>{' '}
              degrades to the default tier. Requests never fail because routing got clever.
            </div>
          </div>

          <Show when={state.autoLayers?.structuralAvailable}>
            <BandTargets />
            <SelfCalibration />
            <SemanticLearning />
            <AutoPerformance />
          </Show>

          <div class="panel card">
            <div class="section-title" style="margin-bottom:4px">
              Header rules
            </div>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);margin-bottom:12px">
              Force a tier per request with{' '}
              <span class="mono" style="font-size:10.5px">
                x-polyrouter-tier
              </span>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <For each={headerRules()}>
                {(ru) => (
                  <div
                    class="mono"
                    style="display:flex;align-items:center;gap:8px;font:400 11.5px 'Geist Mono',monospace;color:var(--text2);padding:6px 9px;background:var(--bg);border:1px solid var(--border2);border-radius:6px"
                  >
                    <span style="color:var(--text3)">
                      {ru.headerName}: {ru.headerValue ?? ''}
                    </span>
                    <Icon name="arrowRight" size={12} style="color:var(--faint)" />
                    <span style="color:var(--text)">{ru.target}</span>
                    <button
                      type="button"
                      class="icon-x"
                      style="margin-left:auto"
                      aria-label={`Delete rule ${ru.headerValue ?? ''} → ${ru.target}`}
                      onClick={() => void app.deleteRule(ru.id)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
              <Show when={headerRules().length === 0}>
                <div style="font:400 11.5px 'Geist',sans-serif;color:var(--text3);padding:4px 0">
                  No header rules yet.
                </div>
              </Show>
            </div>
            <div style="display:flex;align-items:flex-end;gap:6px;margin-top:10px">
              <div style="flex:1">
                <label class="field-label" for="f-rf-value" style="display:block">
                  Header value
                </label>
                <input
                  class="input mono"
                  id="f-rf-value"
                  style="font:400 11.5px 'Geist Mono',monospace"
                  placeholder="e.g. heavy"
                  value={state.rf.value}
                  onInput={(e) => app.setState('rf', 'value', e.currentTarget.value)}
                />
              </div>
              <div style="flex:1">
                <label class="field-label" for="f-rf-target" style="display:block">
                  Target tier
                </label>
                <select
                  class="select"
                  id="f-rf-target"
                  value={state.rf.target}
                  onChange={(e) => app.setState('rf', 'target', e.currentTarget.value)}
                >
                  <option value="" disabled selected={state.rf.target === ''}>
                    Pick a tier…
                  </option>
                  <For each={state.routingTiers}>
                    {(t) => <option value={t.key}>{t.key}</option>}
                  </For>
                </select>
              </div>
              <button
                type="button"
                class="btn-ghost"
                disabled={state.rf.busy}
                onClick={() => void app.createRule()}
              >
                {state.rf.busy ? '…' : 'Add'}
              </button>
            </div>
            <Show when={state.rf.error}>
              <div style="font:400 11px 'Geist',sans-serif;color:var(--red);margin-top:6px">
                {state.rf.error}
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
