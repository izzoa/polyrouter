import { createEffect, createSignal, createUniqueId, on, onCleanup, onMount, Show } from 'solid-js';
import { useModalSurface } from '../a11y';
import type { DestructiveRequest } from '../state/appState';
import { useApp } from '../state/context';
import { Notice } from './Notice';
import { StackedLabel } from './StackedLabel';
import { pageTitle } from './Topbar';

/** The shared destructive confirmation (adopt-red-destructive-actions D6; dashboard-core
 * "Destructive actions are consistent and confirmed" and "A destructive confirmation holds
 * while busy and reports failure in place").
 *
 * Mounted ONCE, at the app shell, and opened through the store (`app.confirmDestructive`), so
 * every destructive site, including `removeUnlistedModel` inside the store, opens the same
 * registered layer, and a second request while one is open is ignored. It renders on
 * `.confirm-card`, the class every confirmation already uses, so its anchoring and width are
 * that card's: the `x`, `y` and `w` the confirmation pins hold.
 *
 * It consumes the overlay contract (`useModalSurface`: the focus trap, Escape to the topmost
 * layer, focus restore) and the button busy state (native `disabled`, `aria-busy`, a
 * progressive label stacked over the rest label so the button keeps its width). Neither is
 * restated here.
 *
 * Its body is the dialog's accessible description, so the consequence is announced with the
 * title when focus moves to the dismissing action on open. */
export function ConfirmDialog() {
  const app = useApp();
  return (
    <Show when={app.state.destructive} keyed>
      {(request) => <Confirmation request={request} />}
    </Show>
  );
}

type Step = 'commit' | 'secondary';

/** How long after the dialog opens a press still belongs to the activation that opened it: the
 * double-click time platforms default to (Windows' 500ms), the longest interval at which a
 * second press is still part of the same gesture. The click count alone cannot tell such a press
 * apart everywhere: measured with Playwright, WebKit and Firefox give the second tap of a
 * double-tap a count of 1, and only Chromium counts it 2. A press aimed at the dialog comes
 * later: reading it and reaching an action takes longer than this. */
export const STRAY_PRESS_MS = 500;

/** The reason a rejected `run` gives, for the alert to name. */
const reasonOf = (e: unknown): string =>
  e instanceof Error && e.message.trim() !== '' ? e.message : 'Unexpected error';

/** One open request. Keyed on it, so the request is fixed for this instance's life. */
function Confirmation(props: { request: DestructiveRequest }) {
  const app = useApp();
  // Keyed on the request: this instance renders one, so it is read once.
  const request = props.request;
  // The control that opened the dialog, read before the layer registers and moves focus in.
  // A pointer activation that never focused it (Safari) leaves the body, which is no trigger.
  const opener = document.activeElement;
  const trigger = opener instanceof HTMLElement && opener !== document.body ? opener : null;

  /** Which action's request is in flight. ONE flag guards the commit and the secondary
   * action, so a burst of activations runs one `run` once, and neither starts while the
   * other is pending. */
  const [busy, setBusy] = createSignal<Step | null>(null);
  const [failure, setFailure] = createSignal<{ step: Step; reason: string } | null>(null);
  let card: HTMLDivElement | undefined;
  let dismissButton: HTMLButtonElement | undefined;
  /** False once this instance is gone, whoever closed it. A request the store closed first
   * (leaving one's own account, an identity change) unmounts it, and its `run` settling later
   * then does nothing here: focus is left to whoever closed it. */
  let open = true;
  onCleanup(() => {
    open = false;
  });

  /** Close, then settle focus (D8). The layer's own restore has already returned focus to the
   * trigger if it is still in the document. A commit that removed it (a deleted row, a gone
   * payload) leaves focus on the body: the site's stable fallback takes it instead, never the
   * body. When that surface is gone too, because the page changed while a request was still in
   * flight, the page's own title takes it. */
  const close = (): void => {
    if (!open) return;
    open = false;
    app.closeDestructive();
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    if (trigger?.isConnected) {
      trigger.focus();
      return;
    }
    const fallback = request.fallbackFocus();
    (fallback?.isConnected === true ? fallback : pageTitle())?.focus();
  };

  /** Escape, a scrim click and the dismissing action. Refused while busy: the layer stays
   * registered, so it stays topmost and a second Escape cannot reach the layer beneath. */
  const dismiss = (): void => {
    if (busy() !== null) return;
    close();
  };

  const surface = useModalSurface(app, {
    when: () => true, // this component renders only while a request is open
    label: request.label ?? request.title,
    onDismiss: dismiss,
  });
  /** The body's id: the dialog's accessible description. */
  const bodyId = createUniqueId();

  // A confirmation belongs to the surface that opened it. When that surface goes (browser Back
  // changes the page, or a different request is inspected), an idle confirmation goes with it,
  // so it can never commit against a page that no longer shows what it would remove. A busy one
  // stays: its request is already sent, and it settles and reports in the dialog. Dismissed
  // once the update that changed the page has finished: closed inside it, the dialog would stay
  // mounted, holding focus, until the update ends, and focus would then fall to the body.
  createEffect(
    on(
      [() => app.state.page, () => app.state.selId],
      () => {
        queueMicrotask(dismiss);
      },
      { defer: true },
    ),
  );

  /** Every trigger opens the dialog in the same task as its click, so the later presses of a
   * double-click or double-tap on the trigger land on whatever now sits under the pointer: on a
   * bottom sheet that can be the commit, elsewhere the scrim. They are not a choice made in the
   * dialog, and every action ignores them. Two signs mark them, because engines differ:
   * - the press began within STRAY_PRESS_MS of the dialog opening;
   * - its click count is above 1 although no sequence has begun inside the dialog: a slow
   *   double-click under a long system double-click time still counts 2.
   * Once a press of the dialog's own has begun a sequence (count 1, after the window), a quick
   * second click is the user's: a retry after a failure. Keyboard activation counts 0 and is
   * always a choice. */
  const openedAt = performance.now();
  let pressEarly = false;
  let ownClicks = false;
  const chosen = (e: MouseEvent): boolean =>
    e.detail === 0 || (!pressEarly && (e.detail === 1 || ownClicks));
  /** Whether the press behind a click on the scrim began on the scrim. A text selection
   * dragged out of the card and released over the scrim is not a dismissal. */
  let pressedScrim = false;

  // The dismissing action takes initial focus, after the layer has focused its root, so
  // Enter on open dismisses and sends nothing.
  onMount(() => dismissButton?.focus());

  /** Await one action's request. Success closes the dialog; failure keeps it open with the
   * reason in an alert inside it, re-enables the actions and hands focus back to the one the
   * user took. Nothing is toasted: the dialog is where the failure is reported. */
  const settle = async (
    step: Step,
    run: () => Promise<void>,
    from: Element | null,
  ): Promise<void> => {
    try {
      await run();
    } catch (e) {
      if (!open) return;
      setBusy(null);
      setFailure({ step, reason: reasonOf(e) });
      const active = document.activeElement;
      const parked = active === card || active === null || active === document.body;
      if (parked && from instanceof HTMLElement && from.isConnected) from.focus();
      return;
    }
    close();
  };

  const launch = (step: Step, run: () => Promise<void>): void => {
    if (busy() !== null) return;
    const from = document.activeElement;
    setFailure(null);
    setBusy(step);
    // Native `disabled` drops focus to the body; hold it on the dialog itself while it works,
    // so Escape, Tab and assistive technology stay inside it.
    card?.focus({ preventScroll: true });
    void settle(step, run, from);
  };

  const failedLabel = (step: Step): string =>
    step === 'secondary' ? (request.secondary?.label ?? request.commitLabel) : request.commitLabel;

  return (
    // eslint-disable-next-line a11y-guard/no-noninteractive-click -- pointer-only scrim redundancy; Escape and the dismissing action are the keyboard paths
    <div
      class="overlay"
      style={{ 'z-index': String(surface.z().backdrop) }}
      onPointerDown={(e) => {
        pressedScrim = e.target === e.currentTarget;
        pressEarly = performance.now() - openedAt < STRAY_PRESS_MS;
      }}
      onMouseDown={(e) => {
        if (e.detail === 1 && !pressEarly) ownClicks = true;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedScrim && chosen(e)) dismiss();
      }}
    >
      <div
        class="panel card confirm-card"
        {...surface.props}
        aria-describedby={bodyId}
        ref={(el: HTMLDivElement) => {
          card = el;
          (surface.props['ref'] as (n: HTMLElement) => void)(el);
        }}
        style={{ 'z-index': String(surface.z().surface) }}
      >
        <div class="section-title" style="margin-bottom:8px">
          {request.title}
        </div>
        <div id={bodyId} class="t-dense" style="color:var(--text2);margin-bottom:12px">
          {request.body}
        </div>
        <Show when={failure()}>
          {(f) => (
            <Notice
              tone="failure"
              title={`${failedLabel(f().step)} failed`}
              style="margin-bottom:12px"
            >
              {f().reason}
            </Notice>
          )}
        </Show>
        {/* A row that cannot fit wraps its controls, never a label (styles.css, the family's
            `nowrap`): at 320px keep-or-purge's three actions need more than the sheet's width. */}
        <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">
          <button
            type="button"
            class="btn-cancel"
            ref={(el) => {
              dismissButton = el;
            }}
            disabled={busy() !== null}
            onClick={(e) => {
              if (chosen(e)) dismiss();
            }}
          >
            {request.dismissLabel ?? 'Cancel'}
          </button>
          <Show when={request.secondary}>
            {(secondary) => (
              <button
                type="button"
                class="btn-cancel"
                disabled={busy() !== null}
                aria-busy={busy() === 'secondary' ? true : undefined}
                onClick={(e) => {
                  if (chosen(e)) launch('secondary', secondary().run);
                }}
              >
                <StackedLabel
                  alt={busy() === 'secondary'}
                  rest={secondary().label}
                  altLabel={secondary().busyLabel}
                />
              </button>
            )}
          </Show>
          <button
            type="button"
            class="btn-destructive"
            disabled={busy() !== null}
            aria-busy={busy() === 'commit' ? true : undefined}
            onClick={(e) => {
              if (chosen(e)) launch('commit', request.run);
            }}
          >
            <StackedLabel
              alt={busy() === 'commit'}
              rest={request.commitLabel}
              altLabel={request.busyLabel}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
