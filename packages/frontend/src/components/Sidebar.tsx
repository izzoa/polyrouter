import { For, Show } from 'solid-js';
import { useApp } from '../state/context';
import type { Page } from '../types';

const NAV: [Page, string][] = [
  ['overview', 'Overview'],
  ['requests', 'Requests'],
  ['costs', 'Costs'],
  ['agents', 'Agents'],
  ['providers', 'Providers'],
  ['routing', 'Routing'],
  ['limits', 'Limits'],
  ['settings', 'Settings'],
];

export function Sidebar() {
  const app = useApp();
  const { state } = app;
  // Only the real providers count is shown; the simulated request count would
  // misrepresent an empty instance.
  const badge = (id: Page): string | null =>
    id === 'providers' && state.providers.length > 0 ? String(state.providers.length) : null;
  const setupProgress = () =>
    state.ob.done2 ? '3 of 3 done' : state.ob.done1 ? '2 of 3 done' : '1 of 3 — connect an agent';

  return (
    <div style="width:208px;flex:none;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--panel)">
      <div style="display:flex;align-items:center;gap:9px;padding:20px 18px 16px">
        <svg width="20" height="20" viewBox="0 0 20 20" style="flex:none" aria-hidden="true">
          <circle cx="4" cy="10" r="2.4" fill="var(--text)" />
          <circle cx="15" cy="4.5" r="2.4" fill="var(--accent)" />
          <circle cx="15" cy="10" r="2.4" fill="var(--faint)" />
          <circle cx="15" cy="15.5" r="2.4" fill="var(--faint)" />
          <line x1="6" y1="10" x2="12.8" y2="5.2" stroke="var(--accent)" stroke-width="1.4" />
          <line x1="6.4" y1="10" x2="12.6" y2="10" stroke="var(--border)" stroke-width="1.4" />
          <line x1="6" y1="10" x2="12.8" y2="14.8" stroke="var(--border)" stroke-width="1.4" />
        </svg>
        <div style="font:600 14px 'Geist',sans-serif;letter-spacing:-.02em">polyrouter</div>
      </div>
      <nav style="display:flex;flex-direction:column;gap:2px;padding:0 10px">
        <For each={NAV}>
          {([id, label]) => (
            <button
              type="button"
              class="nav-item"
              aria-current={state.page === id ? 'page' : undefined}
              style={{
                font: `${state.page === id ? '500' : '400'} 13px 'Geist',sans-serif`,
                color: state.page === id ? 'var(--accent-deep)' : 'var(--text2)',
                background: state.page === id ? 'var(--accent-bg)' : 'transparent',
              }}
              onClick={() => app.go(id)}
            >
              <span>{label}</span>
              <Show when={badge(id)}>
                {(b) => (
                  <span style="font:500 10px 'Geist Mono',monospace;color:var(--text3);background:var(--chip);border-radius:8px;padding:1px 6px">
                    {b()}
                  </span>
                )}
              </Show>
            </button>
          )}
        </For>
      </nav>
      <button type="button" class="setup-card" onClick={() => app.go('setup')}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="7" fill="none" stroke="var(--border)" stroke-width="2" />
          <path
            d="M9 2 a7 7 0 0 1 6.06 10.5"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
        <span style="display:block">
          <span style="display:block;font:500 12px 'Geist',sans-serif;color:var(--text)">
            Setup guide
          </span>
          <span style="display:block;font:400 10.5px 'Geist',sans-serif;color:var(--text3)">
            {setupProgress()}
          </span>
        </span>
      </button>
      <div style="margin-top:auto;padding:14px 18px;border-top:1px solid var(--border2);display:flex;flex-direction:column;gap:8px">
        <button type="button" class="theme-toggle" onClick={() => app.toggleTheme()}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <line
              x1="7"
              y1="0.5"
              x2="7"
              y2="2.5"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
            <line
              x1="7"
              y1="11.5"
              x2="7"
              y2="13.5"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
            <line
              x1="0.5"
              y1="7"
              x2="2.5"
              y2="7"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
            <line
              x1="11.5"
              y1="7"
              x2="13.5"
              y2="7"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
          <span>{state.theme === 'light' ? 'Switch to dark' : 'Switch to light'}</span>
        </button>
        <div style="display:flex;align-items:center;gap:6px;font:400 11px 'Geist Mono',monospace;color:var(--text3)">
          <span style="width:6px;height:6px;border-radius:50%;background:var(--green);flex:none" />
          {state.session?.mode === 'cloud' ? 'cloud' : 'self-hosted'} · v{__APP_VERSION__}
        </div>
        <div style="font:400 11px 'Geist Mono',monospace;color:var(--text3)">
          {globalThis.location.host}
        </div>
      </div>
    </div>
  );
}
