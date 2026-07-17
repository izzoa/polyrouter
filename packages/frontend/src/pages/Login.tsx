import { createSignal, For, Show } from 'solid-js';
import { APP_NAME } from '@polyrouter/shared';
import { useApp } from '../state/context';

const OAUTH_LABELS: Record<string, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
  discord: 'Continue with Discord',
};

/** The auth gate (not a sidebar page). Rendered when `authView === 'gate'`:
 * email/password sign-in + sign-up (name required by better-auth) and one button
 * per configured OAuth provider. */
export function Login() {
  const app = useApp();
  const { state } = app;
  const [mode, setMode] = createSignal<'signin' | 'signup'>('signin');
  const [name, setName] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');

  const submit = (e: Event): void => {
    e.preventDefault();
    if (state.authBusy) return;
    if (mode() === 'signup') {
      void app.signUp({ name: name().trim(), email: email().trim(), password: password() });
    } else {
      void app.signIn({ email: email().trim(), password: password() });
    }
  };

  const providers = () => state.loginConfig?.oauthProviders ?? [];

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
          <div style="display:flex;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:2px">
            <For
              each={
                [
                  ['signin', 'Sign in'],
                  ['signup', 'Sign up'],
                ] as const
              }
            >
              {([id, label]) => (
                <button
                  type="button"
                  aria-pressed={mode() === id}
                  style={{
                    flex: '1',
                    'text-align': 'center',
                    padding: '6px 0',
                    'border-radius': '6px',
                    font: "500 12.5px 'Geist',sans-serif",
                    cursor: 'pointer',
                    background: mode() === id ? 'var(--chip)' : 'transparent',
                    color: mode() === id ? 'var(--text)' : 'var(--text3)',
                  }}
                  onClick={() => setMode(id)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>

          <form style="display:flex;flex-direction:column;gap:11px" onSubmit={submit}>
            <Show when={mode() === 'signup'}>
              <div>
                <label class="field-label" for="f-login-name" style="display:block">
                  Name
                </label>
                <input
                  class="input"
                  id="f-login-name"
                  value={name()}
                  placeholder="Ada Lovelace"
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </div>
            </Show>
            <div>
              <label class="field-label" for="f-login-email" style="display:block">
                Email
              </label>
              <input
                class="input"
                id="f-login-email"
                type="email"
                autocomplete="email"
                value={email()}
                placeholder="you@example.com"
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="field-label" for="f-login-password" style="display:block">
                Password
              </label>
              <input
                class="input"
                id="f-login-password"
                type="password"
                autocomplete={mode() === 'signup' ? 'new-password' : 'current-password'}
                value={password()}
                placeholder="••••••••"
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
            </div>
            <Show when={state.authError}>
              <div style="font:400 11.5px 'Geist',sans-serif;color:var(--red)">
                {state.authError}
              </div>
            </Show>
            <button
              type="submit"
              class="btn-primary"
              disabled={state.authBusy}
              style={{
                display: 'flex',
                'justify-content': 'center',
                width: '100%',
                border: 'none',
              }}
            >
              {state.authBusy ? 'Working…' : mode() === 'signup' ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <Show when={providers().length > 0}>
            <div style="display:flex;align-items:center;gap:10px;color:var(--text3);font:400 11px 'Geist',sans-serif">
              <span style="flex:1;height:1px;background:var(--border)" />
              or
              <span style="flex:1;height:1px;background:var(--border)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <For each={providers()}>
                {(p) => (
                  <button
                    type="button"
                    class="btn-ghost"
                    disabled={state.authBusy}
                    style="display:flex;justify-content:center;width:100%;background:transparent;padding:9px 0"
                    onClick={() => void app.oauth(p)}
                  >
                    {OAUTH_LABELS[p] ?? `Continue with ${p}`}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div style="text-align:center;font:400 11px 'Geist',sans-serif;color:var(--text3)">
          Self-hosted · your keys and data stay on this box.
        </div>
      </div>
    </div>
  );
}
