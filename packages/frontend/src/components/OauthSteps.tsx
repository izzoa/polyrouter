import { Show } from 'solid-js';
import { useApp } from '../state/context';
import { FieldNote, useFields } from './Field';
import { Icon } from './Icon';
import { StackedLabel } from './StackedLabel';

/** The two sign-in steps of the OAuth connect wizard — open the link, paste what
 * you land on — shared by a new connect and a reconnect (add-provider-health-
 * signals). Rendered only while a connect session is active. */
export function OauthSteps(props: { backLabel: string; onBack: () => void }) {
  const app = useApp();
  const { state, setState } = app;
  const f = useFields();
  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="t-dense" style="color:var(--text)">
        1. Open the sign-in link and approve access.
      </div>
      <a
        class="btn-ghost"
        style="align-self:flex-start;text-decoration:none"
        href={state.ow.active?.authorizeUrl ?? '#'}
        target="_blank"
        rel="noreferrer"
      >
        Open sign-in link <Icon name="externalLink" size={12} />
        <span class="sr-only"> (opens in a new tab)</span>
      </a>
      <div class="t-dense" style="color:var(--text)">
        2. Paste what you land on — the full redirect URL or the code#state string.
      </div>
      <label class="field-label" for="f-ow-paste" style="display:block">
        Redirect URL or code
      </label>
      <input
        class="input input--mono"
        id="f-ow-paste"
        value={state.ow.pasted}
        placeholder="https://…/callback?code=…&state=… or code#state"
        aria-invalid={f.invalid('f-ow-paste')}
        aria-describedby={f.describedBy('f-ow-paste')}
        onBlur={() => f.check('f-ow-paste')}
        onInput={(e) => {
          setState('ow', 'pasted', e.currentTarget.value);
          f.edit('f-ow-paste');
        }}
      />
      <FieldNote for="f-ow-paste" error={f.error('f-ow-paste')} alert />
      <Show when={state.ow.error}>
        <div role="alert" class="t-caption" style="color:var(--red-text)">
          {state.ow.error}
        </div>
      </Show>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn-cancel" disabled={state.ow.busy} onClick={props.onBack}>
          {props.backLabel}
        </button>
        <button
          type="button"
          class="btn-primary"
          disabled={state.ow.busy}
          aria-busy={state.ow.busy ? true : undefined}
          onClick={() => void app.completeOauthConnect()}
        >
          <StackedLabel alt={state.ow.busy} rest="Connect" altLabel="Connecting…" />
        </button>
      </div>
    </div>
  );
}
