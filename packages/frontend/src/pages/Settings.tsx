import { For, onMount, Show } from 'solid-js';
import { Toggle } from '../components/Toggle';
import type { ChannelDto } from '../data/api';
import { BASE_URL } from '../data/catalog';
import { useApp } from '../state/context';
import { BodyCaptureCard } from '../components/BodyCaptureCard';
import { StackedLabel } from '../components/StackedLabel';
import { createBusy } from '../components/busy';

interface TestLine {
  text: string;
  ok: boolean | null;
}

export function Settings() {
  const app = useApp();
  const { state } = app;
  const session = () => state.session;
  // The pricing status Retry stays on screen while it re-reads (the error is replaced only
  // when the read settles), so it is busy in its own right (D14).
  const pricingRetry = createBusy();

  onMount(() => {
    void app.loadChannels();
    void app.loadBodyCapture();
    if (session()?.role === 'admin') void app.loadPricingStatus();
  });

  const fmtDate = (iso: string): string => new Date(iso).toLocaleDateString();

  const removeChannel = (c: ChannelDto): void => {
    if (
      globalThis.confirm(
        `Delete channel "${c.name}"? Future alerts will no longer be delivered to it.`,
      )
    ) {
      void app.deleteChannel(c.id);
    }
  };

  // Inline test-send result takes precedence; otherwise fall back to the stored
  // `lastTestStatus` (`success` | `failed:<code>`). Only `{ ok, error? }` is known.
  const testLine = (c: ChannelDto): TestLine => {
    const inline = state.channelTests[c.id];
    if (inline !== undefined) {
      return inline.ok
        ? { text: 'test ok', ok: true }
        : { text: `test failed — ${inline.error ?? 'error'}`, ok: false };
    }
    if (c.lastTestStatus === null) return { text: 'never tested', ok: null };
    if (c.lastTestStatus === 'success') return { text: 'test ok', ok: true };
    return { text: c.lastTestStatus.replace(/^failed:/, 'test failed — '), ok: false };
  };

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      <div class="panel card">
        <div class="section-title" style="margin-bottom:8px">
          Instance
        </div>
        {/* A wrapping strip of label-over-value items (compact-settings-layout): it spans
            the page instead of stacking four rows in the narrow left edge. */}
        <div
          data-testid="instance-strip"
          class="t-dense"
          style="display:flex;flex-wrap:wrap;gap:12px 32px;align-items:flex-start;color:var(--text2)"
        >
          <div>
            <div class="t-caption" style="color:var(--text3);margin-bottom:4px">
              Account
            </div>
            <div>
              {session()?.email ?? '—'}
              <Show when={session()?.role}>
                {(role) => (
                  <span class="chip" style="font-size:0.6875rem;color:var(--text3);margin-left:8px">
                    {role()}
                  </span>
                )}
              </Show>
            </div>
          </div>
          <div>
            <div class="t-caption" style="color:var(--text3);margin-bottom:4px">
              Mode
            </div>
            <div class="mono" style="font-size:0.75rem">
              {session()?.mode ?? '—'}
            </div>
          </div>
          <div>
            <div class="t-caption" style="color:var(--text3);margin-bottom:4px">
              Version
            </div>
            <div class="mono" style="font-size:0.75rem">
              v{__APP_VERSION__}
            </div>
          </div>
          <div style="flex:1 1 300px;min-width:0">
            <div class="t-caption" style="color:var(--text3);margin-bottom:4px">
              Endpoint
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="mono" style="font-size:0.75rem;overflow-wrap:anywhere">
                {BASE_URL}
              </span>
              <button
                type="button"
                class="link-accent"
                style="font-size:0.75rem"
                onClick={() => app.copy(BASE_URL, 'Endpoint copied')}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
        <Show when={session()?.mode === 'selfhosted'}>
          <div class="t-caption" style="color:var(--text3);margin-top:12px">
            Self-hosted loopback uses auto-login with no session cookie — “Log out” (in the account
            menu, bottom of the sidebar) is inert here and you’ll land straight back in.
          </div>
        </Show>
      </div>

      {/* Two columns above the narrow threshold (`.rs-grid-2` collapses at the locked 768px);
          DOM order is reading order, so tab order matches. Children carry `min-width:0` because
          the class applies it only below the threshold. */}
      <div class="rs-grid-2" style="display:grid;gap:16px;align-items:start">
        <div style="min-width:0">
          <BodyCaptureCard />
        </div>
        <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
          <div class="panel card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <div class="section-title">Notifications</div>
              <button
                type="button"
                class="link-accent t-label"

                onClick={() => app.openChannel()}
              >
                + Add channel
              </button>
            </div>
            <div class="t-caption" style="color:var(--text3);margin-bottom:12px">
              Budget alerts, provider-down and failure spikes fan out to every enabled channel —
              delivered async, never blocking a request.
            </div>

            <Show when={state.channelsError}>
              <div class="t-caption" style="color:var(--red-text);margin-bottom:8px">
                Couldn’t load channels: {state.channelsError}
              </div>
            </Show>

            <div style="display:flex;flex-direction:column;gap:8px">
              <For
                each={state.channels}
                fallback={
                  <div class="t-caption" style="color:var(--text3)">
                    {state.channelsLoading ? 'Loading channels…' : 'No channels yet.'}
                  </div>
                }
              >
                {(c) => (
                  <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:6px">
                    <Toggle
                      on={c.enabled}
                      locked={state.channelToggling[c.id] ?? false}
                      label={`Toggle channel ${c.name}`}
                      onToggle={() => void app.toggleChannelEnabled(c)}
                    />
                    <div style="min-width:0">
                      <div class="t-label" style="color:var(--text)">
                        {c.name}{' '}
                        <span
                          class="chip mono"
                          style="font:500 0.6875rem/1rem 'Geist Mono',monospace;color:var(--text3);margin-left:4px"
                        >
                          {c.kind}
                        </span>
                      </div>
                      <div class="t-caption" style="color:var(--text3)">
                        {c.hasConfig ? 'config set (encrypted)' : 'no config'} ·{' '}
                        {c.eventsSubscribed.length} event
                        {c.eventsSubscribed.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
                      {(() => {
                        const line = testLine(c);
                        return (
                          <span
                            style={{
                              font: "400 0.6875rem/1rem 'Geist',sans-serif",
                              color:
                                line.ok === true
                                  ? 'var(--green-text)'
                                  : line.ok === false
                                    ? 'var(--red-text)'
                                    : 'var(--text3)',
                            }}
                          >
                            {line.text}
                          </span>
                        );
                      })()}
                      {/* No inline fill: it outranked `.btn-ghost:active`, so this was the one
                          ghost in the row with no pressed tone (DESIGN.md State matrix). */}
                      <button
                        type="button"
                        class="btn-ghost"
                        disabled={state.channelTesting[c.id] ?? false}
                        aria-busy={state.channelTesting[c.id] === true ? true : undefined}
                        onClick={() => void app.testChannelById(c.id)}
                      >
                        <StackedLabel
                          alt={state.channelTesting[c.id] ?? false}
                          rest="Send test"
                          altLabel="Sending…"
                        />
                      </button>
                      <button type="button" class="btn-ghost" onClick={() => app.openChannel(c)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        class="btn-ghost btn-ghost--amber"
                        onClick={() => removeChannel(c)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          <Show when={session()?.role === 'admin'}>
            <div class="panel card">
              <div class="section-title" style="margin-bottom:4px">
                Pricing catalog
              </div>
              <Show
                when={state.pc.status}
                keyed
                fallback={
                  /* Loading, error, and loaded are mutually exclusive: the error
                     block below owns the failure state. */
                  <Show when={state.pc.loadError === null}>
                    <div class="t-caption" style="color:var(--text3)">
                      Loading…
                    </div>
                  </Show>
                }
              >
                {(st) => (
                  <>
                    <Show
                      when={st.entryCount > 0}
                      fallback={
                        <div class="t-dense" style="color:var(--text2)">
                          Catalog is empty; pricing is unavailable.
                        </div>
                      }
                    >
                      <div class="t-dense" style="color:var(--text2)">
                        {st.entryCount.toLocaleString()} models
                        <Show when={st.newest} keyed>
                          {(n) => (
                            <span style="color:var(--text3)">
                              {' '}
                              · newest: {n.source} · effective {fmtDate(n.validFrom)} · applied{' '}
                              {fmtDate(n.appliedAt)}
                            </span>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px">
                      <span class="t-dense" style="color:var(--text2)">
                        Last refreshed:{' '}
                        <Show when={st.lastRefresh} keyed fallback={<b>never</b>}>
                          {(r) => (
                            <span>
                              {fmtDate(r.at)}{' '}
                              <span style="color:var(--text3)">
                                (+{r.added}
                                {r.skipped > 0 ? ` · ${String(r.skipped)} skipped` : ''})
                              </span>
                            </span>
                          )}
                        </Show>
                      </span>
                      <Show when={st.scheduler.modePermitted}>
                        <button
                          type="button"
                          class="btn-ghost"
                          disabled={state.pc.busy}
                          aria-busy={state.pc.busy ? true : undefined}
                          onClick={() => void app.runPricingRefresh()}
                        >
                          <StackedLabel
                            alt={state.pc.busy}
                            rest="Refresh now"
                            altLabel="Refreshing…"
                          />
                        </button>
                      </Show>
                    </div>
                    <div class="t-caption" style="color:var(--text3);margin-top:4px">
                      Auto-refresh:{' '}
                      {st.scheduler.effectiveEnabled
                        ? `scheduled — ${st.scheduler.cron} (UTC) · opt out: PRICING_REFRESH_SCHED_ENABLED=false`
                        : st.scheduler.configuredEnabled && !st.scheduler.modePermitted
                          ? 'unavailable in cloud mode'
                          : 'off — PRICING_REFRESH_SCHED_ENABLED=false is set'}
                    </div>
                    <div class="t-caption" style="color:var(--text3);margin-top:4px">
                      New prices apply to new requests; recorded costs never change.
                    </div>
                  </>
                )}
              </Show>
              <Show when={state.pc.loadError}>
                <div class="t-caption" style="color:var(--red-text);margin-top:4px">
                  {state.pc.loadError}{' '}
                  <button
                    type="button"
                    class="btn-ghost"
                    disabled={pricingRetry.busy()}
                    aria-busy={pricingRetry.busy() ? true : undefined}
                    onClick={() => void pricingRetry.run(() => app.loadPricingStatus())}
                  >
                    <StackedLabel alt={pricingRetry.busy()} rest="Retry" altLabel="Retrying…" />
                  </button>
                </div>
              </Show>
              <Show when={state.pc.refreshError}>
                {/* The refresh's retry is the Refresh-now button itself — this
                    line only reports why the last attempt failed (r3-Med-4). */}
                <div class="t-caption" style="color:var(--red-text);margin-top:4px">
                  Refresh failed — {state.pc.refreshError}
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
