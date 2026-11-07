import { createUniqueId, onMount } from 'solid-js';
import { useModalSurface } from '../a11y';
import { useApp } from '../state/context';

/**
 * The consent confirmation for turning client-identity imitation on
 * (allow-preset-client-identity, design D10).
 *
 * Its own markup on `.panel.card.confirm-card`, stacked over the provider modal, the way the
 * body-capture consent is: consent is not loss, so it is not the destructive `ConfirmDialog`,
 * and its commit is the Primary. Confirming only sets form state (the provider's Save sends
 * the PATCH, the wizard's Continue sends the start), so the dialog has no busy or failure state.
 *
 * Initial focus is the commit button, so the warning is the dialog's accessible DESCRIPTION
 * (`aria-describedby`): a screen-reader user lands on the commit with the risk already read out,
 * never able to accept it unheard. Cancel and Escape close it; focus goes back to the switch.
 */
export function IdentityConsent(props: {
  /** The imitated client's name, as the preset declares it. */
  label: string;
  /** The switch that opened it: where focus returns. */
  switchId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const app = useApp();
  const bodyId = createUniqueId();
  let commit: HTMLButtonElement | undefined;
  const surface = useModalSurface(app, {
    when: () => true, // this component renders only while the confirmation is open
    label: `Imitate ${props.label}’s client identity?`,
    describedBy: bodyId,
    onDismiss: props.onCancel,
    // A checkbox is not focused by a click in every engine (Safari), so the layer's captured
    // opener can be the body: name the switch itself.
    restoreTo: () => document.getElementById(props.switchId),
  });
  // After the layer has focused its root: Enter on open commits, as a non-destructive dialog's
  // initial focus does (DESIGN.md).
  onMount(() => commit?.focus());
  return (
    <div class="overlay" style={{ 'z-index': String(surface.z().backdrop) }}>
      <div
        class="panel card confirm-card"
        {...surface.props}
        style={{ 'z-index': String(surface.z().surface) }}
      >
        <div class="section-title" style="margin-bottom:8px">
          Imitate {props.label}’s client identity?
        </div>
        <div id={bodyId} class="t-dense" style="color:var(--text2);margin-bottom:12px">
          polyrouter will send {props.label}’s identity headers on this provider’s requests. The
          provider sees these requests coming from this polyrouter instance, not only from you. This
          likely violates the provider’s terms: the account can be suspended, and the provider can
          block it at any time.
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">
          <button type="button" class="btn-cancel" onClick={() => props.onCancel()}>
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            ref={(el) => {
              commit = el;
            }}
            onClick={() => props.onConfirm()}
          >
            Turn on imitation
          </button>
        </div>
      </div>
    </div>
  );
}
