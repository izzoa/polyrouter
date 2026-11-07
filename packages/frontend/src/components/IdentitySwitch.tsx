/**
 * The identity-imitation switch (allow-preset-client-identity, design D10): a native
 * checkbox, like the provider modal's auto-prune setting, because both commit with the form's
 * own button and a native checkbox already follows the control-edge and `accent-color` rules.
 *
 * It never turns itself on. Checking it only ASKS (`onAsk`): the box stays off until the
 * consent confirmation commits, so Cancel and Escape need no undo. Unchecking is `onOff` and
 * asks nothing.
 */
export function IdentitySwitch(props: {
  /** The checkbox's id: the consent dialog hands focus back to it. */
  id: string;
  /** The imitated client's name, as the preset declares it. */
  label: string;
  checked: boolean;
  onAsk: () => void;
  onOff: () => void;
}) {
  const captionId = `${props.id}-caption`;
  return (
    <div>
      <label
        for={props.id}
        class="t-label"
        style="display:flex;align-items:center;gap:8px;min-height:24px;color:var(--text2)"
      >
        <input
          type="checkbox"
          id={props.id}
          checked={props.checked}
          aria-describedby={captionId}
          onChange={(e) => {
            if (e.currentTarget.checked) {
              // The state, not the DOM, says whether it is on: hold the box off until the
              // consent commits.
              e.currentTarget.checked = false;
              props.onAsk();
            } else {
              props.onOff();
            }
          }}
        />
        Imitate {props.label}’s client identity
      </label>
      <div id={captionId} class="t-caption" style="color:var(--text3);margin-top:4px">
        Sends {props.label}’s identity headers on this provider’s requests.
      </div>
    </div>
  );
}
