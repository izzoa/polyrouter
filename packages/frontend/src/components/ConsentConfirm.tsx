import { createEffect, createUniqueId, on, onMount, Show, type JSX } from 'solid-js';
import { useModalSurface } from '../a11y';
import { useApp } from '../state/context';
import { Notice } from './Notice';
import { StackedLabel } from './StackedLabel';

/**
 * The consent confirmation (DESIGN.md "Confirm dialog": consent confirmations use the same
 * structure and commit with the Primary button), shared by every non-destructive confirmation
 * that is not the shared `ConfirmDialog`.
 *
 * Its own markup on `.panel.card.confirm-card`, the way the body-capture consent is: consent is
 * not loss, so it is never the destructive dialog, and its commit is the Primary, never Red Fill.
 * Initial focus is the commit button, so the warning is the dialog's accessible DESCRIPTION
 * (`aria-describedby`): a screen-reader user lands on the commit with the risk already read out,
 * never able to accept it unheard. Cancel and Escape close it; focus goes to `restoreTo`.
 *
 * Two optional props serve a confirmation whose commit sends a request (classify-plan-quota-errors,
 * the risk-control Resume), which the identity consent, that only sets form state, does not need:
 * - `busy`: the commit's label turns progressive (`busyLabel`), both buttons are natively
 *   disabled, and Escape is refused so the layer stays topmost while the request is in flight;
 * - `failure`: the reason the request failed, shown inline in the dialog, which stays open.
 * Left unset, the dialog behaves exactly as the identity consent always did.
 */
export function ConsentConfirm(props: {
  /** The dialog's title and accessible name. */
  title: string;
  /** The consequence, one or two sentences: the dialog's accessible description. */
  body: JSX.Element;
  /** The commit, labelled with the verb. */
  commitLabel: string;
  /** The commit's progressive label while `busy`. */
  busyLabel?: string;
  busy?: boolean;
  /** The failed request's reason; the dialog stays open on it. */
  failure?: string | null;
  /** Where focus returns on close, when the layer's own opener is not the right control. */
  restoreTo?: () => HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const app = useApp();
  const bodyId = createUniqueId();
  let commit: HTMLButtonElement | undefined;
  let card: HTMLDivElement | undefined;
  const busy = (): boolean => props.busy === true;
  const surface = useModalSurface(app, {
    when: () => true, // this component renders only while the confirmation is open
    label: props.title,
    describedBy: bodyId,
    // Refused while busy: the layer stays registered and topmost, so a second Escape cannot
    // reach the layer beneath.
    onDismiss: () => {
      if (!busy()) props.onCancel();
    },
    ...(props.restoreTo !== undefined ? { restoreTo: props.restoreTo } : {}),
  });
  // After the layer has focused its root: Enter on open commits, as a non-destructive dialog's
  // initial focus does (DESIGN.md).
  onMount(() => commit?.focus());
  // Native `disabled` drops focus to the body: hold it on the dialog itself while the request
  // runs, so Escape, Tab and assistive technology stay inside it. When it fails and the buttons
  // return, focus goes back to the commit so a retry is one keypress.
  createEffect(
    on(
      busy,
      (isBusy, was) => {
        if (isBusy) card?.focus({ preventScroll: true });
        else if (was === true) {
          const active = document.activeElement;
          if (active === card || active === null || active === document.body) commit?.focus();
        }
      },
      { defer: true },
    ),
  );
  return (
    <div class="overlay" style={{ 'z-index': String(surface.z().backdrop) }}>
      <div
        class="panel card confirm-card"
        {...surface.props}
        ref={(el: HTMLDivElement) => {
          card = el;
          (surface.props['ref'] as (n: HTMLElement) => void)(el);
        }}
        style={{ 'z-index': String(surface.z().surface) }}
      >
        <div class="section-title" style="margin-bottom:8px">
          {props.title}
        </div>
        <div id={bodyId} class="t-dense" style="color:var(--text2);margin-bottom:12px">
          {props.body}
        </div>
        <Show when={props.failure}>
          {(reason) => (
            <Notice tone="failure" title={`${props.commitLabel} failed`} style="margin-bottom:12px">
              {reason()}
            </Notice>
          )}
        </Show>
        <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">
          <button
            type="button"
            class="btn-cancel"
            disabled={busy()}
            onClick={() => props.onCancel()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            ref={(el) => {
              commit = el;
            }}
            disabled={busy()}
            aria-busy={busy() ? true : undefined}
            onClick={() => props.onConfirm()}
          >
            <Show when={props.busyLabel !== undefined} fallback={props.commitLabel}>
              <StackedLabel
                alt={busy()}
                rest={props.commitLabel}
                altLabel={props.busyLabel ?? props.commitLabel}
              />
            </Show>
          </button>
        </div>
      </div>
    </div>
  );
}
