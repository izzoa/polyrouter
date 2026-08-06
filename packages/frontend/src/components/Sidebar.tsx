import { createEffect, For, onCleanup, onMount, Show } from 'solid-js';
import { useModalSurface } from '../a11y';
import { useApp } from '../state/context';
import type { Page } from '../types';
import { PageIcon } from './PageIcon';
import { UserMenu } from './UserMenu';

/** Held as a constant so the narrow-width z-index can be appended without restating it —
 * and without converting it to an object, which mangles the border shorthand. */
const SIDEBAR_STYLE =
  'flex:none;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--panel);min-height:0;overflow-y:auto;overscroll-behavior-y:contain';

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
  // The Users area is admin-only chrome — hidden entirely from non-admins.
  const nav = (): [Page, string][] =>
    state.session?.role === 'admin' ? [...NAV, ['users', 'Users'] as [Page, string]] : NAV;

  // The sidebar MUST own its overflow. It is a stretched flex item in a viewport-height
  // shell, and its content (logo + up to 9 nav items + setup card + account footer, ~520px)
  // is taller than a short viewport. Left at `overflow:visible` that spill enlarged the
  // SHELL's scrollable-overflow area — which the shell can then be translated by, moving
  // every pane at once — and left the lower nav and the account menu unreachable. Scrolling
  // internally fixes both. `overscroll-behavior-y` (not the shorthand — that would also
  // suppress horizontal swipe-back navigation) keeps a scroll past either end from chaining
  // out. `min-height:0` is belt-and-braces: height is the cross axis here so it is not
  // load-bearing today, but it costs nothing and states the intent explicitly.
  // Narrow-width nav (phase1-responsive-dashboard-layout). Below the locked `narrow`
  // threshold the sidebar is a 56px icon rail; expanding it overlays the page content,
  // because a 208px panel cannot sit beside content on a 390px screen.
  //
  // The WIDTH now lives in `.rs-sidebar`, not inline. That is not cosmetic: an inline
  // width outranks any class, so a media query could never have reached it. The shell
  // contract is untouched — `data-pane`, internal scrolling and axis-scoped
  // `overscroll-behavior-y` all stay exactly as they were.

  // The expanded rail must not survive leaving narrow width. Above the threshold the
  // toggle is `display:none`, so an expanded nav that outlives a resize leaves a
  // full-screen scrim over `inert` content with NO control able to dismiss it — a hard
  // lock-up requiring a reload. Rotating a phone to landscape is enough to hit it.
  //
  // This is a viewport LISTENER, not viewport-driven layout: it dismisses an overlay that
  // no longer applies. The layout adaptation itself stays declarative in CSS. The literal
  // matches the locked `narrow` value in styles.css; a test pins them together.
  onMount(() => {
    const mq = globalThis.matchMedia('(max-width: 768px)');
    const onChange = (): void => {
      if (!mq.matches) app.setNavExpanded(false);
    };
    mq.addEventListener('change', onChange);
    onCleanup(() => {
      mq.removeEventListener('change', onChange);
    });
  });

  // Any page change collapses it — not just a click on a nav item. Browser Back/Forward,
  // the account menu's Settings/Users entries, and a deep link all route without touching
  // the nav's own handlers, and each would otherwise leave the overlay covering the page
  // it just opened.
  // Track the PREVIOUS page rather than reading `navExpanded` here: an effect that reads
  // both re-runs the moment the nav opens and closes it again immediately.
  let lastPage = state.page;
  createEffect(() => {
    const page = state.page;
    if (page !== lastPage) {
      lastPage = page;
      app.setNavExpanded(false);
    }
  });

  // The expanded nav is a `dialog` — it claims aria-modal at narrow width. The
  // account-menu ordering that used to live in its `onClose` is gone: the menu registers
  // as a layer ABOVE the nav, so the arbiter dismisses it first by construction rather
  // than by this surface knowing about it.
  // Conditionally modal: an ordinary in-flow pane above the narrow threshold, a dialog
  // below it. The primitive's attributes track `when()`, so it claims `aria-modal` exactly
  // while it is a registered layer — never on the collapsed rail.
  const surface = useModalSurface(app, {
    when: () => state.navExpanded,
    label: 'Navigation',
    onDismiss: () => app.setNavExpanded(false),
  });

  return (
    <>
      {/* Inline `position:fixed` deliberately: the shell's in-flow-pane guard reads
          `element.style.position` to decide what is exempt, so a class-supplied position
          would make the scrim look like an unmarked pane and fail that test. */}
      <Show when={state.navExpanded}>
        {/* eslint-disable-next-line a11y-guard/no-noninteractive-click -- pointer-only backdrop redundancy; Escape and the toggle are the keyboard paths */}
        <div
          class="overlay rs-nav-scrim"
          // eslint-disable-next-line a11y-guard/no-inline-sheet-geometry -- see above: the in-flow-pane guard reads element.style.position, so this one must stay inline
          style={{ position: 'fixed', 'z-index': String(surface.z().backdrop) }}
          aria-hidden="true"
          onClick={() => app.setNavExpanded(false)}
        />
      </Show>
      <div
        data-pane="sidebar"
        classList={{ 'rs-sidebar': true, 'rs-nav-open': state.navExpanded }}
        {...surface.props}
        ref={surface.props['ref'] as (n: HTMLElement) => void}
        style={
          // String form deliberately: as an object, happy-dom expands the `border-right`
          // shorthand into longhands carrying the wrong values, and the serialisation the
          // shell contract test pins changes. The z-index is appended only while the panel
          // is a layer.
          state.navExpanded
            ? `${SIDEBAR_STYLE};z-index:${String(surface.z().surface)}`
            : SIDEBAR_STYLE
        }
      >
      <div class="rs-nav-header">
        <svg width="20" height="20" viewBox="0 0 20 20" style="flex:none" aria-hidden="true">
          <circle cx="4" cy="10" r="2.4" fill="var(--text)" />
          <circle cx="15" cy="4.5" r="2.4" fill="var(--accent)" />
          <circle cx="15" cy="10" r="2.4" fill="var(--faint)" />
          <circle cx="15" cy="15.5" r="2.4" fill="var(--faint)" />
          <line x1="6" y1="10" x2="12.8" y2="5.2" stroke="var(--accent)" stroke-width="1.4" />
          <line x1="6.4" y1="10" x2="12.6" y2="10" stroke="var(--border)" stroke-width="1.4" />
          <line x1="6" y1="10" x2="12.8" y2="14.8" stroke="var(--border)" stroke-width="1.4" />
        </svg>
        <div class="rs-nav-label" style="font:600 14px 'Geist',sans-serif;letter-spacing:-.02em">
          polyrouter
        </div>
        <button
          type="button"
          class="rs-nav-toggle"
          aria-expanded={state.navExpanded}
          aria-controls="sidebar-nav"
          aria-label={state.navExpanded ? 'Collapse navigation' : 'Expand navigation'}
          onClick={() => app.setNavExpanded(!state.navExpanded)}
        >
          <span aria-hidden="true">{state.navExpanded ? '\u2715' : '\u2630'}</span>
        </button>
      </div>
      <nav id="sidebar-nav" class="rs-nav-list">
        <For each={nav()}>
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
              onClick={() => {
                app.go(id);
                app.setNavExpanded(false);
              }}
            >
              <span class="nav-item-label">
                <PageIcon page={id} />
                <span class="rs-nav-label">{label}</span>
              </span>
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
      <Show when={!state.setupDismissed}>
        <div class="rs-setup-wrap">
          <button
            type="button"
            class="setup-card"
            onClick={() => {
              app.go('setup');
              app.setNavExpanded(false);
            }}
          >
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
          <button
            type="button"
            aria-label="Dismiss setup guide"
            title="Dismiss setup guide"
            style="position:absolute;top:16px;right:13px;width:22px;height:22px;border:none;background:transparent;color:var(--text3);cursor:pointer;font:400 14px 'Geist',sans-serif;line-height:1;border-radius:6px;display:flex;align-items:center;justify-content:center"
            onClick={() => app.dismissSetupGuide()}
          >
            ×
          </button>
        </div>
      </Show>
      <div
        class="rs-sidebar-footer"
        style="margin-top:auto;padding:14px 18px;border-top:1px solid var(--border2);gap:8px"
      >
        <UserMenu />
        <div style="display:flex;align-items:center;gap:6px;font:400 11px 'Geist Mono',monospace;color:var(--text3)">
          <span style="width:6px;height:6px;border-radius:50%;background:var(--green);flex:none" />
          {state.session?.mode === 'cloud' ? 'cloud' : 'self-hosted'} · v{__APP_VERSION__}
        </div>
        <div style="font:400 11px 'Geist Mono',monospace;color:var(--text3)">
          {globalThis.location.host}
        </div>
      </div>
      </div>
    </>
  );
}
