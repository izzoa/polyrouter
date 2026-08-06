import { Match, onMount, Show, Switch, type ParentProps, createEffect, onCleanup } from 'solid-js';
import { installLayerArbiter } from './a11y';
import { Inspector } from './components/Inspector';
import { Modals } from './components/Modals';
import { createVisibility } from './data/poller';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { Topbar } from './components/Topbar';
import { AcceptInvite } from './pages/AcceptInvite';
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
import { Users } from './pages/Users';
import { useApp } from './state/context';

export interface AppProps {
  /** Disable the aggregate-page polling interval (tests). */
  live?: boolean;
}

function Shell(props: { live: boolean }) {
  const app = useApp();
  const { state } = app;
  const visible = createVisibility();

  // The event stream is ONE app-wide connection (phase2-add-dashboard-event-stream),
  // held only while the shell is mounted, `live`, and the document is VISIBLE. Hiding
  // CLOSES it rather than pausing it: on HTTP/1.1 the ~6 connections per origin are
  // shared across every tab, so a hidden tab holding one starves the others.
  createEffect(() => {
    if (props.live && visible()) app.connectStream();
    else app.disconnectStream();
  });
  onCleanup(() => app.disconnectStream());

  // The overlay arbiter is installed by the mounted shell, NOT by `createAppStore` — the
  // test suites construct many stores and would otherwise accumulate document listeners.
  onMount(() => {
    onCleanup(installLayerArbiter({ layers: () => state.layers }));
  });

  // Shell sizing and containment (fix-shell-scroll-containment):
  //
  // `100dvh` with a `100vh` fallback — the static `vh` unit resolves against the viewport
  // with mobile browser chrome RETRACTED, so a `100vh` shell is taller than what is
  // actually visible and the page scrolls past the window. An engine that cannot parse
  // `dvh` drops that declaration and keeps `100vh`, i.e. today's behaviour.
  //
  // `overflow:hidden` then `overflow:clip` — `hidden` suppresses a scrollbar but still
  // makes the shell a scroll CONTAINER: it cannot be wheel-scrolled (the spec forbids
  // that), but it can still be translated by `focus()`/`scrollIntoView` on a clipped
  // control, by CSSOM `scrollTop`, or by scroll anchoring — each of which moves every
  // pane at once. `clip` creates no scroll container at all, so the shell can never move
  // by ANY mechanism. It does not affect scrolling inside the panes: the sidebar and
  // `<main>` are their own scroll containers and keep working normally.
  //
  // Every in-flow child carries `data-pane` and must contain its own overflow — the
  // sidebar shipped without that, which is how its spill reached the shell at all.
  return (
    <div
      data-shell="true"
      style="display:flex;height:100vh;height:100dvh;overflow:hidden;overflow:clip;background:var(--bg);color:var(--text);font-family:'Geist',sans-serif"
    >
      <Sidebar />
      {/* `inert` while the narrow-width nav overlay is open: `aria-modal` + the focus
          trap cover keyboard and assistive tech, but pointer input needs this too. */}
      <div
        data-pane="content"
        inert={state.navExpanded ? true : undefined}
        style="flex:1;min-width:0;display:flex;flex-direction:column"
      >
        <Topbar />
        {/* `overscroll-behavior-Y`, not the shorthand: the shorthand applies to both axes
            and would suppress the horizontal swipe-back/forward navigation gesture across
            most of the app. Only vertical chaining needs containing. */}
        <main style="flex:1;min-height:0;overflow-y:auto;overscroll-behavior-y:contain">
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
            <Match when={state.page === 'users'}>
              <Users />
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
    // Routing starts BEFORE the probe so the requested page is captured and
    // held while authorization resolves (add-dashboard-hash-routing). The
    // listener lives on App's lifecycle, not the store constructor: production
    // has one store while the test suites build many, and a constructor-owned
    // global listener would leak handlers across them.
    onCleanup(app.startRouting());
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
      <Match when={state.authView === 'invite'}>
        <AcceptInvite />
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
