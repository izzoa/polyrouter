import { createSignal, For, Show } from 'solid-js';
import { useModalSurface } from '../a11y';
import { useApp } from '../state/context';

type Mode = 'off' | 'errors_only' | 'all';

const MODE_LABEL: Record<Mode, string> = {
  off: 'Off — metadata only',
  errors_only: 'Errors & escalations only',
  all: 'All requests',
};

const fmtWhen = (iso: string | null): string =>
  iso === null ? 'never' : new Date(iso).toLocaleString();

/** The Prompt & response bodies card (add-body-capture): the REAL capture
 * control on selfhosted — mode + retention + per-agent overrides + purge —
 * behind an explicit consent confirm; read-only metadata-only text elsewhere.
 * Badge truth = mode ≠ off (the master kill: overrides cannot capture while
 * off, so green never lies). */
export function BodyCaptureCard() {
  const app = useApp();
  const { state } = app;
  const bc = () => state.bc.status;
  const on = () => bc() !== null && bc()!.mode !== 'off';
  /** No status has arrived yet. Until one does, and after a first read that failed, the card
   * claims nothing either way: no "never persisted" sentence and no badge, because a green
   * Metadata-only over an unknown mode is the one lie the badge exists to rule out. */
  const loading = () => bc() === null && !state.bc.loaded;
  /** Pending mode awaiting the consent confirm (enable transitions only). */
  const [confirmMode, setConfirmMode] = createSignal<Mode | null>(null);
  const [disableChoice, setDisableChoice] = createSignal(false);

  const pickMode = (mode: Mode): void => {
    const cur = bc()?.mode ?? 'off';
    if (mode === cur) return;
    if (mode === 'off') {
      setDisableChoice(true); // keep-or-purge
    } else if (cur === 'off') {
      setConfirmMode(mode); // enabling needs the explicit consent
    } else {
      void app.setBodyCaptureMode(mode); // errors_only ⇄ all: already consented
    }
  };

  const retentionLabel = () => {
    const r = bc()?.retentionDays;
    return r === null ? 'forever (explicit)' : `${String(r ?? 30)} days`;
  };

  return (
    <div class="panel card" aria-busy={loading() ? true : undefined}>
      <div
        data-testid="capture-header"
        style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px"
      >
        <div>
          <div class="section-title" style="margin-bottom:4px">
            Prompt &amp; response bodies
          </div>
          <div class="t-caption" style="color:var(--text3)">
            <Show
              when={bc()}
              keyed
              fallback={
                // Loading: a neutral placeholder. Failed: the read's own error line, the same
                // inline failure text the controls below use (design.md D15).
                <Show
                  when={loading()}
                  fallback={<span style="color:var(--red-text)">{state.bc.error}</span>}
                >
                  <span class="ar-skel ar-skel-short" aria-hidden="true" />
                </Show>
              }
            >
              {(s) => (
                <Show
                  when={s.available}
                  fallback={
                    <>
                      polyrouter stores metadata only (tokens, cost, latency, routing decision) —
                      prompt and response bodies are never persisted on this instance.
                    </>
                  }
                >
                  Off by default. When enabled, captured bodies are stored encrypted, aside from the
                  request log, and purged after the retention window.
                </Show>
              )}
            </Show>
          </div>
        </div>
        <Show
          when={bc() !== null}
          fallback={
            <Show when={loading()}>
              <span class="ar-skel ar-skel-count" style="align-self:center" aria-hidden="true" />
            </Show>
          }
        >
          <span
            class="chip"
            style={{
              'white-space': 'nowrap',
              'align-self': 'center',
              color: on() ? 'var(--amber-text)' : 'var(--green-text)',
            }}
            title={on() ? 'Prompt/response bodies are being captured' : 'Bodies are never stored'}
          >
            {on() ? 'Bodies captured' : 'Metadata-only'}
          </span>
        </Show>
      </div>

      <Show when={bc()?.available && bc()} keyed>
        {(s) => (
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:12px">
            <div
              role="radiogroup"
              aria-label="Capture mode"
              style="display:flex;flex-wrap:wrap;gap:4px 20px"
            >
              <For each={['off', 'errors_only', 'all'] as Mode[]}>
                {(mode) => (
                  <label
                    class="t-body"
                    style="display:flex;align-items:center;gap:8px;min-height:24px;color:var(--text2);cursor:pointer"
                  >
                    <input
                      type="radio"
                      name="bc-mode"
                      checked={s.mode === mode}
                      disabled={state.bc.busy}
                      onChange={() => pickMode(mode)}
                    />
                    {MODE_LABEL[mode]}
                  </label>
                )}
              </For>
            </div>

            <div
              class="rs-grid-label t-dense"
              style="display:grid;gap:8px 16px;color:var(--text2);align-items:center"
            >
              <div style="color:var(--text3)">Retention</div>
              <div style="display:flex;align-items:center;gap:8px">
                <select
                  class="select rs-select-md"
                  aria-label="Retention"
                  value={s.retentionDays === null ? 'forever' : String(s.retentionDays)}
                  disabled={state.bc.busy}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    if (v === 'forever') {
                      if (
                        globalThis.confirm(
                          'Keep captured bodies FOREVER? Nothing is ever purged automatically. This is an explicit choice.',
                        )
                      ) {
                        void app.setBodyCaptureRetention(null);
                      } else {
                        e.currentTarget.value =
                          s.retentionDays === null ? 'forever' : String(s.retentionDays);
                      }
                    } else {
                      void app.setBodyCaptureRetention(Number(v));
                    }
                  }}
                >
                  <For each={[7, 30, 90, 365]}>
                    {(d) => <option value={String(d)}>{d} days</option>}
                  </For>
                  <option value="forever">keep forever…</option>
                </select>
                {/* "30 days" beside a select that already says "30 days" is noise; only the
                    explicit keep-forever state carries information (compact-settings-layout). */}
                <Show when={s.retentionDays === null}>
                  <span style="color:var(--text3)">{retentionLabel()}</span>
                </Show>
              </div>
              <div style="color:var(--text3)">Status</div>
              <div style="color:var(--text3)">
                last purge {fmtWhen(s.lastPurgeAt)}
                {s.lastPurgeCount > 0 ? ` (${String(s.lastPurgeCount)} rows)` : ''} ·{' '}
                {String(s.droppedCount)} dropped
              </div>
            </div>

            <div>
              <div class="upper-label" style="margin-bottom:8px">
                Agent overrides
              </div>
              <Show when={s.mode === 'off'}>
                <div class="t-caption" style="color:var(--text3);margin-bottom:8px">
                  Inert while capture is off — the mode above is the master switch.
                </div>
              </Show>
              <div class="rs-grid-fit" style="display:grid;gap:8px 16px">
                <For each={s.agents}>
                  {(a) => (
                    <div
                      class="t-dense"
                      data-testid="capture-override"
                      style="display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;color:var(--text2)"
                    >
                      <span
                        class="mono"
                        title={a.name}
                        style="font-size:0.75rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                      >
                        {a.name}
                      </span>
                      <select
                        class="select rs-select-sm"
                        style="flex:none"
                        aria-label={`Capture override for ${a.name}`}
                        value={a.override ?? 'inherit'}
                        disabled={state.bc.busy}
                        onChange={(e) => {
                          const v = e.currentTarget.value;
                          void app.setAgentBodyOverride(
                            a.id,
                            v === 'inherit' ? null : (v as 'always' | 'never'),
                          );
                        }}
                      >
                        <option value="inherit">inherit</option>
                        <option value="always">always</option>
                        <option value="never">never</option>
                      </select>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:8px">
              <button
                type="button"
                class="btn-ghost btn-ghost--amber"
                disabled={state.bc.busy}
                onClick={() => {
                  if (globalThis.confirm('Delete ALL stored request/response bodies now?')) {
                    void app.purgeBodies();
                  }
                }}
              >
                Purge all bodies
              </button>
              <Show when={state.bc.error} keyed>
                {(e) => (
                  <span class="t-caption" style="color:var(--red-text)">
                    {e}
                  </span>
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>

      {/* Consent confirm (enable transitions only) */}
      <Show when={confirmMode()} keyed>
        {(mode) => {
          // These two dialogs claimed `role="dialog" aria-modal="true"` while implementing
          // NONE of it — no focus trap, no Escape, no restore. A keyboard user could Tab
          // straight out into the page behind while `aria-modal` told assistive tech the
          // rest of the page was hidden. The contract forbidding that was a comment.
          // Attributes and registration in one call — the shape that makes claiming
          // `aria-modal` without a focus trap difficult to write rather than merely
          // detectable. Both of these dialogs shipped doing exactly that.
          const surface = useModalSurface(app, {
            when: () => true, // this branch only renders while the dialog is open
            label: 'Confirm body capture',
            onDismiss: () => setConfirmMode(null),
          });
          return (
            <div class="overlay" style={{ 'z-index': String(surface.z().backdrop) }}>
              <div
                class="panel card confirm-card"
                {...surface.props}
                style={{ 'z-index': String(surface.z().surface) }}
              >
                <div class="section-title" style="margin-bottom:8px">
                  Capture prompt &amp; response bodies?
                </div>
                <div class="t-dense" style="color:var(--text2);margin-bottom:12px">
                  Bodies may contain secrets, PII, and proprietary code. They are stored encrypted,
                  separate from the request log, and purged after{' '}
                  {bc()?.retentionDays === null
                    ? 'never (keep forever)'
                    : `${String(bc()?.retentionDays ?? 30)} days`}
                  . Every agent you connect is subject to this setting. Mode:{' '}
                  <strong>{MODE_LABEL[mode]}</strong>.
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                  <button type="button" class="btn-cancel" onClick={() => setConfirmMode(null)}>
                    Keep metadata-only
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    onClick={() => {
                      setConfirmMode(null);
                      void app.setBodyCaptureMode(mode);
                    }}
                  >
                    Capture bodies
                  </button>
                </div>
              </div>
            </div>
          );
        }}
      </Show>

      {/* Disable: keep-or-purge */}
      <Show when={disableChoice()}>
        {(() => {
          // Attributes and registration in one call — the shape that makes claiming
          // `aria-modal` without a focus trap difficult to write rather than merely
          // detectable. Both of these dialogs shipped doing exactly that.
          const surface = useModalSurface(app, {
            when: () => true, // this branch only renders while the dialog is open
            label: 'Disable body capture',
            onDismiss: () => setDisableChoice(false),
          });
          return (
            <div class="overlay" style={{ 'z-index': String(surface.z().backdrop) }}>
              <div
                class="panel card confirm-card"
                {...surface.props}
                style={{ 'z-index': String(surface.z().surface) }}
              >
                <div class="section-title" style="margin-bottom:8px">
                  Turn capture off
                </div>
                <div class="t-dense" style="color:var(--text2);margin-bottom:12px">
                  New requests stop being captured immediately. What should happen to the bodies
                  already stored?
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                  <button type="button" class="btn-cancel" onClick={() => setDisableChoice(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn-ghost"
                    onClick={() => {
                      setDisableChoice(false);
                      void app.setBodyCaptureMode('off');
                    }}
                  >
                    Keep until retention
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    onClick={() => {
                      setDisableChoice(false);
                      void (async () => {
                        await app.setBodyCaptureMode('off');
                        await app.purgeBodies();
                      })();
                    }}
                  >
                    Purge now
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </Show>
    </div>
  );
}
