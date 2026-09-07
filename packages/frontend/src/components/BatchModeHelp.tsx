import { createSignal, createUniqueId, onCleanup, Show } from 'solid-js';
import { BATCH_COMPLETION_WINDOW_TEXT } from '@polyrouter/shared';
import { useLayer } from '../a11y';
import { useApp } from '../state/context';
import type { ModelDto } from '../data/api';

/** `$1.25` style, matching the chain row's own price label. */
const usd = (n: number): string => `$${n < 1 ? n.toFixed(4).replace(/0+$/, '') : n.toFixed(2)}`;

/**
 * What a batch reservation actually costs the reader, in the order it matters
 * (add-batch-mode-help task 2.3): what the control does, then the latency it buys,
 * then the rate it buys it with. A reader who stops after the first line still has
 * what the caption alone used to tell them.
 *
 * The rate is THIS model's resolved batch price, never a ratio of the synchronous
 * one. The batch pair comes from the bundled catalog and is frequently absent — a
 * native Anthropic provider has none at all — so "about half" would be an unsourced
 * price claim (invariant 4) and simply wrong wherever the real rate is not half.
 * When it cannot be resolved the text says so.
 */
export function batchHelpLines(model: ModelDto | undefined): string[] {
  const lines = [
    'Held for batch work — interactive requests skip this entry.',
    `Results can take up to ${BATCH_COMPLETION_WINDOW_TEXT}, and arrive only when the whole batch finishes. Nothing streams.`,
  ];
  const bp = model?.batchEffectivePrice;
  const sp = model?.effectivePrice;
  if (!bp) {
    lines.push('Batch rate unknown for this model — the provider publishes none we can read.');
  } else if (bp.isFree) {
    lines.push(`Batch rate: free${bp.estimated ? ' (estimate)' : ''}.`);
  } else {
    const sync = sp
      ? sp.isFree
        ? 'free'
        : `${usd(sp.inputPricePer1m)} / ${usd(sp.outputPricePer1m)}`
      : 'unpriced';
    lines.push(
      `Batch ${usd(bp.inputPricePer1m)} / ${usd(bp.outputPricePer1m)} per 1M${
        bp.estimated ? ' (estimate)' : ''
      } — synchronous is ${sync}.`,
    );
  }
  return lines;
}

interface Props {
  /** Names the entry this help belongs to, for the trigger's accessible name. */
  entryLabel: string;
  model: ModelDto | undefined;
  /** Receives the element id, to hang on the switch's `aria-describedby`. */
  onId: (id: string) => void;
  /** Called on pointer-down so the row can suppress its own drag. */
  onPress?: () => void;
}

/**
 * The help surface for one reservation control.
 *
 * Disclosed on hover and on keyboard FOCUS above the narrow threshold; below it the
 * same element is static, in-flow and always visible (`styles.css`). It is never
 * revealed by a tap: a tap on a `role="switch"` must toggle that switch, and its hit
 * area already expands to 44x44 under a coarse pointer with the overlay inside the
 * button — so tap-to-reveal would either steal the toggle or raise this on every
 * state change. Below the threshold there is nothing to tap because nothing is
 * hidden.
 *
 * Revealed, it is `position: fixed`: every tier card is `overflow: hidden`, so a card
 * positioned within the row would be clipped at the panel's edge — most visibly on a
 * tier holding one row. Same reason, and same treatment, as the add-model combobox.
 */
export function BatchModeHelp(props: Props) {
  const app = useApp();
  const id = createUniqueId();
  const [shown, setShown] = createSignal(false);
  const [box, setBox] = createSignal({ left: 0, top: 0 });
  let anchorEl: HTMLSpanElement | undefined;
  let cardEl: HTMLDivElement | undefined;
  props.onId(id);

  const z = useLayer(app, {
    when: () => shown(),
    kind: 'popover',
    root: () => cardEl,
    onDismiss: () => setShown(false),
  });

  const measure = (): void => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const W = 300;
    // Kept inside the viewport on both axes; flipped above the anchor when it would
    // otherwise run off the bottom.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
    const below = r.bottom + 6;
    const top = below + 160 > window.innerHeight ? Math.max(8, r.top - 166) : below;
    setBox({ left, top });
  };

  const reveal = (): void => {
    measure();
    setShown(true);
  };

  // The app scrolls `<main>`, not the window, and scroll does not bubble — so this is
  // capture-phase, exactly as the combobox does it. A fixed card must not float away
  // from an anchor that has moved.
  const onScroll = (): void => {
    setShown(false);
  };
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  onCleanup(() => {
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  });

  return (
    <span
      class="chain-help"
      ref={(el) => {
        anchorEl = el;
      }}
      onMouseEnter={reveal}
      onMouseLeave={() => setShown(false)}
      onFocusIn={reveal}
      onFocusOut={() => setShown(false)}
      // A press inside the help must not start the row's HTML5 drag: the nearest
      // draggable ancestor wins, so only the row's own dragstart can be cancelled —
      // the row supplies that suppression through `onPress`.
      onPointerDown={() => props.onPress?.()}
    >
      <button
        type="button"
        class="chain-help-trigger"
        aria-label={`What reserving ${props.entryLabel} for batch means`}
        aria-expanded={shown()}
        aria-describedby={id}
        onClick={() => {
          if (shown()) setShown(false);
          else reveal();
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      <div
        id={id}
        class="chain-help-card"
        classList={{ 'chain-help-shown': shown() }}
        ref={(el) => {
          cardEl = el;
        }}
        style={{
          left: `${String(box().left)}px`,
          top: `${String(box().top)}px`,
          ...(shown() ? { 'z-index': String(z().surface) } : {}),
        }}
      >
        <Show when={true}>
          {batchHelpLines(props.model).map((l) => (
            <div class="chain-help-line">{l}</div>
          ))}
        </Show>
      </div>
    </span>
  );
}
