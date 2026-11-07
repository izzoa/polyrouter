import { ConsentConfirm } from './ConsentConfirm';

/**
 * The consent confirmation for turning client-identity imitation on
 * (allow-preset-client-identity, design D10): the shared `ConsentConfirm` with this change's
 * words, stacked over the provider modal. Confirming only sets form state (the provider's Save
 * sends the PATCH, the wizard's Continue sends the start), so it uses neither the busy state nor
 * the in-dialog failure.
 *
 * Initial focus is the commit button, so the warning is the dialog's accessible DESCRIPTION: a
 * screen-reader user lands on the commit with the risk already read out, never able to accept it
 * unheard. Cancel and Escape close it; focus goes back to the switch.
 */
export function IdentityConsent(props: {
  /** The imitated client's name, as the preset declares it. */
  label: string;
  /** The switch that opened it: where focus returns. */
  switchId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConsentConfirm
      title={`Imitate ${props.label}’s client identity?`}
      body={
        <>
          polyrouter will send {props.label}’s identity headers on this provider’s requests. The
          provider sees these requests coming from this polyrouter instance, not only from you. This
          likely violates the provider’s terms: the account can be suspended, and the provider can
          block it at any time.
        </>
      }
      commitLabel="Turn on imitation"
      // A checkbox is not focused by a click in every engine (Safari), so the layer's captured
      // opener can be the body: name the switch itself.
      restoreTo={() => document.getElementById(props.switchId)}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}
