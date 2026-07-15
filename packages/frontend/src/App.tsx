import { Match, onCleanup, onMount, Switch } from 'solid-js';
import { Inspector } from './components/Inspector';
import { Modals } from './components/Modals';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { Topbar } from './components/Topbar';
import { Agents } from './pages/Agents';
import { Costs } from './pages/Costs';
import { Limits } from './pages/Limits';
import { Overview } from './pages/Overview';
import { Providers } from './pages/Providers';
import { Requests } from './pages/Requests';
import { Routing } from './pages/Routing';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { app } from './state/appState';

const LIVE_FEED_INTERVAL_MS = 4000;

export interface AppProps {
  /** Disable the simulated live feed (tests). */
  live?: boolean;
}

export function App(props: AppProps) {
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
    if (live()) {
      const timer = setInterval(() => app.pushLiveRequest(), LIVE_FEED_INTERVAL_MS);
      onCleanup(() => clearInterval(timer));
    }
  });

  return (
    <div style="display:flex;height:100vh;overflow:hidden;background:var(--bg);color:var(--text);font-family:'Geist',sans-serif">
      <Sidebar />
      <div style="flex:1;min-width:0;display:flex;flex-direction:column">
        <Topbar />
        <main style="flex:1;min-height:0;overflow-y:auto">
          <Switch>
            <Match when={state.page === 'overview'}>
              <Overview live={live()} />
            </Match>
            <Match when={state.page === 'requests'}>
              <Requests live={live()} />
            </Match>
            <Match when={state.page === 'costs'}>
              <Costs />
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
