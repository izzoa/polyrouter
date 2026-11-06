import { createSignal, For, Show } from 'solid-js';
import { APP_NAME } from '@polyrouter/shared';
import { createLocalFields, FieldNote } from '../components/Field';
import { EMAIL_FORMAT } from '../state/fieldChecks';
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
  // The browser's email-format check reports on the field (task 8.2, design.md D20): the form
  // is `novalidate`, so no bubble, and the field reads its own `validity`. A failure only the
  // server reports (`authError`) names no field and stays the form's message.
  let emailEl: HTMLInputElement | undefined;
  const f = createLocalFields({
    'f-login-email': () => (emailEl?.validity.typeMismatch === true ? EMAIL_FORMAT : null),
  });

  // Under invite_only the sign-up tab disappears (user-administration) — the
  // server refuses ungated sign-ups anyway; this just keeps the gate honest.
  const inviteOnly = () => state.loginConfig?.registration === 'invite_only';
  const signingUp = () => mode() === 'signup' && !inviteOnly();

  const submit = (e: Event): void => {
    e.preventDefault();
    if (state.authBusy) return;
    if (!f.submit(['f-login-email'])) return;
    if (signingUp()) {
      void app.signUp({ name: name().trim(), email: email().trim(), password: password() });
    } else {
      void app.signIn({ email: email().trim(), password: password() });
    }
  };

  const providers = () => state.loginConfig?.oauthProviders ?? [];

  return (
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:var(--bg);color:var(--text);font-family:'Geist',sans-serif">
      <div style="width:380px;max-width:92vw;display:flex;flex-direction:column;gap:16px">
        <div style="display:flex;align-items:center;gap:8px;justify-content:center">
          {/* The brand mark: its lit route is identity, outside the Indigo Budget
              (adopt-design-tokens-v2 D11), so `data-brand-mark` names it to the guards. */}
          <svg
            width="22"
            height="22"
            viewBox="0 0 20 20"
            style="flex:none"
            aria-hidden="true"
            data-brand-mark
          >
            <circle cx="4" cy="10" r="2.4" fill="var(--text)" />
            <circle cx="15" cy="4.5" r="2.4" fill="var(--accent)" />
            <circle cx="15" cy="10" r="2.4" fill="var(--faint)" />
            <circle cx="15" cy="15.5" r="2.4" fill="var(--faint)" />
            <line x1="6" y1="10" x2="12.8" y2="5.2" stroke="var(--accent)" stroke-width="1.4" />
            <line x1="6.4" y1="10" x2="12.6" y2="10" stroke="var(--border)" stroke-width="1.4" />
            <line x1="6" y1="10" x2="12.8" y2="14.8" stroke="var(--border)" stroke-width="1.4" />
          </svg>
          <div class="t-title" style="letter-spacing:-.02em">
            {APP_NAME}
          </div>
        </div>

        <div class="panel card" style="display:flex;flex-direction:column;gap:16px">
          <Show
            when={!inviteOnly()}
            fallback={
              <div>
                <div class="t-title" style="letter-spacing:-.01em">
                  Sign in
                </div>
                <div class="t-caption" style="color:var(--text3);margin-top:4px">
                  New accounts are invite-only — ask an admin for an invite link.
                </div>
              </div>
            }
          >
            <div class="seg-track" style="background:var(--bg)">
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
                    class="rs-seg rs-seg--fill"
                    data-label={label}
                    aria-pressed={mode() === id}
                    onClick={() => setMode(id)}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <form novalidate style="display:flex;flex-direction:column;gap:12px" onSubmit={submit}>
            <Show when={signingUp()}>
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
                ref={(el) => {
                  emailEl = el;
                }}
                class="input"
                id="f-login-email"
                type="email"
                autocomplete="email"
                value={email()}
                placeholder="you@example.com"
                aria-invalid={f.invalid('f-login-email')}
                aria-describedby={f.describedBy('f-login-email')}
                onBlur={() => f.check('f-login-email')}
                onInput={(e) => {
                  setEmail(e.currentTarget.value);
                  f.edit('f-login-email');
                }}
              />
              <FieldNote for="f-login-email" error={f.error('f-login-email')} />
            </div>
            <div>
              <label class="field-label" for="f-login-password" style="display:block">
                Password
              </label>
              <input
                class="input"
                id="f-login-password"
                type="password"
                autocomplete={signingUp() ? 'new-password' : 'current-password'}
                value={password()}
                placeholder="••••••••"
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
            </div>
            <Show when={state.authError}>
              <div class="t-caption" style="color:var(--red-text)">
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
              {state.authBusy ? 'Working…' : signingUp() ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <Show when={providers().length > 0}>
            <div
              class="t-caption"
              style="display:flex;align-items:center;gap:8px;color:var(--text3)"
            >
              <span style="flex:1;height:1px;background:var(--border)" />
              or
              <span style="flex:1;height:1px;background:var(--border)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <For each={providers()}>
                {(p) => (
                  <button
                    type="button"
                    class="btn-cancel"
                    disabled={state.authBusy}
                    style="display:flex;justify-content:center;width:100%"
                    onClick={() => void app.oauth(p)}
                  >
                    {OAUTH_LABELS[p] ?? `Continue with ${p}`}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="t-caption" style="text-align:center;color:var(--text3)">
          Self-hosted · your keys and data stay on this box.
        </div>
      </div>
    </div>
  );
}
