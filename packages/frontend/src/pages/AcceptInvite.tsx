import { Show } from 'solid-js';
import { APP_NAME } from '@polyrouter/shared';
import { useApp } from '../state/context';

/** Public accept-invite page (user-administration). Rendered when
 * `authView === 'invite'` — the token was captured from the URL and scrubbed
 * by bootstrap(); this form only collects name + password. On success the
 * accept response set the session cookie and the app reboots signed-in. */
export function AcceptInvite() {
  const app = useApp();
  const { state, setState } = app;

  const submit = (e: Event): void => {
    e.preventDefault();
    void app.acceptInvite();
  };

  return (
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:var(--bg);color:var(--text);font-family:'Geist',sans-serif">
      <div style="width:380px;max-width:92vw;display:flex;flex-direction:column;gap:16px">
        <div style="display:flex;align-items:center;gap:9px;justify-content:center">
          <svg width="22" height="22" viewBox="0 0 20 20" style="flex:none" aria-hidden="true">
            <circle cx="4" cy="10" r="2.4" fill="var(--text)" />
            <circle cx="15" cy="4.5" r="2.4" fill="var(--accent)" />
            <circle cx="15" cy="10" r="2.4" fill="var(--faint)" />
            <circle cx="15" cy="15.5" r="2.4" fill="var(--faint)" />
            <line x1="6" y1="10" x2="12.8" y2="5.2" stroke="var(--accent)" stroke-width="1.4" />
            <line x1="6.4" y1="10" x2="12.6" y2="10" stroke="var(--border)" stroke-width="1.4" />
            <line x1="6" y1="10" x2="12.8" y2="14.8" stroke="var(--border)" stroke-width="1.4" />
          </svg>
          <div style="font:600 18px 'Geist',sans-serif;letter-spacing:-.02em">{APP_NAME}</div>
        </div>

        <div class="panel card" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <div style="font:600 14px 'Geist',sans-serif;letter-spacing:-.01em">
              You’ve been invited
            </div>
            <div style="font:400 12px 'Geist',sans-serif;color:var(--text3);margin-top:3px;line-height:1.5">
              Pick a name and password to finish creating your account. The email is the one the
              invite was sent to.
            </div>
          </div>

          <Show when={state.inviteToken === null}>
            <div style="font:400 11.5px 'Geist',sans-serif;color:var(--amber)">
              This link is missing its invite token — it may have been trimmed by your mail client.
              Ask your admin to copy the full link.
            </div>
          </Show>

          <form style="display:flex;flex-direction:column;gap:11px" onSubmit={submit}>
            <div>
              <label class="field-label" for="f-invite-name" style="display:block">
                Name
              </label>
              <input
                class="input"
                id="f-invite-name"
                value={state.ai.name}
                placeholder="Ada Lovelace"
                onInput={(e) => setState('ai', 'name', e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="field-label" for="f-invite-password" style="display:block">
                Password
              </label>
              <input
                class="input"
                id="f-invite-password"
                type="password"
                autocomplete="new-password"
                value={state.ai.password}
                placeholder="8+ characters"
                onInput={(e) => setState('ai', 'password', e.currentTarget.value)}
              />
            </div>
            <Show when={state.ai.error}>
              <div role="alert" style="font:400 11.5px 'Geist',sans-serif;color:var(--red)">
                {state.ai.error}
              </div>
            </Show>
            <button
              type="submit"
              class="btn-primary"
              disabled={state.ai.busy}
              style={{
                display: 'flex',
                'justify-content': 'center',
                width: '100%',
                border: 'none',
              }}
            >
              {state.ai.busy ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <button
            type="button"
            class="btn-ghost"
            style="display:flex;justify-content:center;width:100%;background:transparent"
            onClick={() => globalThis.location.assign('/')}
          >
            Already have an account? Sign in
          </button>
        </div>

        <div style="text-align:center;font:400 11px 'Geist',sans-serif;color:var(--text3)">
          Invite links are single-use and expire after 72 hours.
        </div>
      </div>
    </div>
  );
}
