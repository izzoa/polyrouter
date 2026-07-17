import { Match, onMount, Show, Switch, type ParentProps } from 'solid-js';
import { Inspector } from './components/Inspector';
import { Modals } from './components/Modals';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { Topbar } from './components/Topbar';
import { Agents } from './pages/Agents';
import { Costs } from './pages/Costs';
import { Limits } from './pages/Limits';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Providers } from './pages/Providers';
import { Requests } from './pages/Requests';
import { Routing } from './pages/Routing';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { useApp } from './state/context';

export interface AppProps {
  /** Disable the aggregate-page polling interval (tests). */
  live?: boolean;
}

function Shell(props: { live: boolean }) {
  const app = useApp();
  const { state } = app;
  return (
    <div style="display:flex;height:100vh;overflow:hidden;background:var(--bg);color:var(--text);font-family:'Geist',sans-serif">
      <Sidebar />
      <div style="flex:1;min-width:0;display:flex;flex-direction:column">
        <Topbar />
        <main style="flex:1;min-height:0;overflow-y:auto">
          <Switch>
            <Match when={state.page === 'overview'}>
              <Overview live={props.live} />
            </Match>
            <Match when={state.page === 'requests'}>
              <Requests />
            </Match>
            <Match when={state.page === 'costs'}>
              <Costs live={props.live} />
            </Match>
            <Match when={state.page === 'agents'}>
              <Agents />
            </Match>
            <Match when={state.page === 'providers'}>
              <Providers />
            </Match>
            <Match when={state.page === 'routing'}>
              <Routing />
            </Match>
            <Match when={state.page === 'limits'}>
              <Limits />
            </Match>
            <Match when={state.page === 'settings'}>
              <Settings />
            </Match>
            <Match when={state.page === 'setup'}>
              <Setup />
            </Match>
          </Switch>
        </main>
      </div>
      <Inspector />
      <Modals />
      <Toast />
    </div>
  );
}

function CenterFrame(props: ParentProps) {
  return (
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:var(--bg);color:var(--text);font-family:'Geist',sans-serif">
      {props.children}
    </div>
  );
}

export function App(props: AppProps) {
  const app = useApp();
  const { state } = app;
  const live = () => props.live !== false;

  onMount(() => {
    let stored: string | null;
    try {
      stored = localStorage.getItem('polyrouter-theme');
    } catch {
      stored = null;
    }
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.dataset['theme'] = stored;
      app.setState('theme', stored);
    }
    // Authorization probe before anything else renders the shell.
    void app.bootstrap();
  });

  return (
    <Switch>
      <Match when={state.authView === 'loading'}>
        <CenterFrame>
          <div style="font:400 13px 'Geist',sans-serif;color:var(--text3)">Loading…</div>
        </CenterFrame>
      </Match>
      <Match when={state.authView === 'gate'}>
        <Login />
      </Match>
      <Match when={state.authView === 'error'}>
        <CenterFrame>
          <div style="display:flex;flex-direction:column;gap:12px;align-items:center;max-width:360px;text-align:center">
            <div style="font:600 15px 'Geist',sans-serif">Couldn’t reach the server</div>
            <Show when={state.authError}>
              <div style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
                {state.authError}
              </div>
            </Show>
            <button type="button" class="btn-primary" onClick={() => void app.retry()}>
              Retry
            </button>
          </div>
        </CenterFrame>
      </Match>
      <Match when={state.authView === 'ready'}>
        <Shell live={live()} />
      </Match>
    </Switch>
  );
}
