import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { useApp } from '../state/context';
import { BASE_URL } from '../data/catalog';
import type { Page } from '../types';
import { PageIcon } from './PageIcon';
import { Icon } from './Icon';
import { StackedLabel } from './StackedLabel';

/** The endpoint chip's confirmation. Exported so a test can tell it from other toasts. */
export const ENDPOINT_COPIED = 'Endpoint copied';

/** The Live lamp's blink (adopt-design-tokens-v2 D12; DESIGN.md Live lamp): one 600ms
 * `lamp-blink`, at most one per second. A data event inside the second after a blink is
 * dropped, not queued, so a burst reads as one blink. */
export const LAMP_BLINK_MS = 600;
export const LAMP_MIN_INTERVAL_MS = 1000;

const TITLES: Record<Page, [string, string]> = {
  overview: ['Overview', 'last 24 hours'],
  requests: ['Requests', 'every routed call, with its why'],
  batches: ['Batches', 'jobs the provider is still working through'],
  costs: ['Costs', 'where the money goes'],
  agents: ['Agents', 'things that call the router'],
  providers: ['Providers', 'where requests get served'],
  routing: ['Routing', 'tiers, fallbacks & auto layers'],
  limits: ['Limits', 'budgets that alert or block'],
  settings: ['Settings', 'instance & notifications'],
  users: ['Users', 'who can sign in, and how'],
  setup: ['Setup guide', 'three steps to your first routed request'],
};

export function Topbar() {
  const app = useApp();
  const { state } = app;
  const streaming = (): boolean => state.streamHealth === 'live';
  // `Copied` belongs to the chip's OWN copy (dashboard-core "The endpoint chip confirms a copy
  // in place"): set by its successful write, shown while that confirmation is the toast on
  // screen, and dropped once it has cleared — or once another confirmation has taken the region
  // first. Settings copies the same URL with the same words, and that copy must not flip the
  // chip, so the toast text alone is never read as the chip's.
  const [ownCopy, setOwnCopy] = createSignal(false);
  const endpointConfirmShowing = (): boolean =>
    state.toast?.kind === 'confirm' && state.toast.text === ENDPOINT_COPIED;
  let ownSeen = false;
  createEffect(() => {
    if (!ownCopy()) {
      ownSeen = false;
      return;
    }
    if (endpointConfirmShowing()) {
      ownSeen = true;
      return;
    }
    // A failure on screen may be holding the confirmation back (it waits its turn, D13).
    if (ownSeen || state.toast?.kind === 'confirm') setOwnCopy(false);
  });
  const copied = (): boolean => ownCopy() && endpointConfirmShowing();

  // The lamp moves only when something happened (D12): each NEW data stamp from the live
  // stream blinks it once, throttled to one blink a second with the trailing edge dropped. A
  // heartbeat never stamps, and while polling no stamp arrives, so neither blinks. The class
  // is applied for one blink's length and then removed, so the next blink re-applies it and
  // restarts the keyframe. Under reduced motion the stylesheet collapses the keyframe to a
  // single imperceptible frame that ends fully visible, so the dot stays steady.
  const [blinking, setBlinking] = createSignal(false);
  let lastBlinkAt = Number.NEGATIVE_INFINITY;
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => state.lastDataEventAt,
      (at) => {
        if (at === null || state.streamHealth !== 'live') return;
        if (at - lastBlinkAt < LAMP_MIN_INTERVAL_MS) return; // inside the second: dropped
        lastBlinkAt = at;
        clearTimeout(blinkTimer);
        setBlinking(true);
        blinkTimer = setTimeout(() => setBlinking(false), LAMP_BLINK_MS);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(blinkTimer));
  return (
    <div
      class="rs-topbar rs-wrap"
      style="flex:none;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);background:var(--bg)"
    >
      {/* ONE flex row, not a nested group. The old markup wrapped icon+title in an inner
          flex and baseline-aligned the subtitle against that group — but a flex container
          exports its FIRST item's baseline, and the first item was the icon, which has no
          text baseline, so its bottom edge was used. The subtitle's baseline landed on the
          icon's bottom edge (~3.5px below the title's real baseline) on every page. Flat
          siblings let the title and subtitle share a true text baseline; the icon opts out
          via align-self:center, which also keeps its previous optical position (centered on
          the title's line box). */}
      <div style="display:flex;align-items:baseline;gap:8px">
        <span style="display:flex;align-self:center;color:var(--text3)" aria-hidden="true">
          <PageIcon page={state.page} size={17} />
        </span>
        {/* The page title is the Title role (15px, D5): a page title is not a headline. */}
        <div class="t-title" data-testid="page-title">
          {TITLES[state.page][0]}
        </div>
        <div class="t-dense" style="color:var(--text3)">
          {TITLES[state.page][1]}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        {/* HONEST transport state (phase2-add-dashboard-event-stream): a buffering
            proxy or a dropped stream must be diagnosable, not look like an idle
            instance. Greyscale for the fallback — no second accent hue. */}
        <div
          class="live-pill"
          data-testid="live-pill"
          style={{ color: streaming() ? 'var(--green-text)' : 'var(--text3)' }}
          title={
            streaming()
              ? 'Live updates are streaming from the server'
              : 'Streaming unavailable — falling back to periodic polling (the dashboard still updates)'
          }
        >
          {/* The lamp's dot: Signal Green while live, blinking once per data event; a steady
              Faint while polling. Decorative — the word beside it carries the state — and the
              pill is not a live region, so a blink announces nothing. */}
          <span
            aria-hidden="true"
            data-testid="live-dot"
            classList={{ 'lamp-blink': streaming() && blinking() }}
            style={{
              width: '6px',
              height: '6px',
              'border-radius': '50%',
              background: streaming() ? 'var(--green)' : 'var(--faint)',
            }}
          />
          {streaming() ? 'Live' : 'Polling'}
        </div>
        {/* After its own successful copy the chip reads `Copied` until that confirmation
            toast clears (adopt-design-tokens-v2 D19). `copy()` calls back only on a
            successful write — a failed one toasts its own failure. Stacked labels keep the
            width; `aria-label` keeps the name, and the toast still announces. */}
        <button
          type="button"
          class="endpoint-chip"
          aria-label="Copy endpoint URL"
          onClick={() => app.copy(BASE_URL, ENDPOINT_COPIED, () => setOwnCopy(true))}
        >
          <StackedLabel alt={copied()} rest="/v1" altLabel="Copied" />
          {/* Ink 3, not the decorative --faint (2.03:1): the copy glyph carries meaning,
              so it takes the token the contrast suite holds at ≥ 3:1 (dashboard-core). */}
          <Icon name="copy" size={12} style="color:var(--text3)" />
        </button>
      </div>
    </div>
  );
}
