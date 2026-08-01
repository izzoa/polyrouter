import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';

/**
 * add-dashboard-hash-routing tasks 1.5 + 2.3. The invite-token collision is
 * FIRST by contract: a router that parses or overwrites that fragment leaks a
 * secret into browser history, which is the one regression here that matters
 * more than any routing bug.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}

/** Mount the real App at a given URL. `url` is applied BEFORE mount, so the
 * router sees it exactly as a fresh browser visit would. */
async function mountAt(url: string, fake = new FakeApiClient({})): Promise<Harness> {
  globalThis.history.replaceState(null, '', url);
  const store = createAppStore(fake);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  return {
    host,
    store,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

describe('dashboard hash routing', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
    globalThis.history.replaceState(null, '', '/');
  });

  // ---- the token-leak guard, first ----

  it('never parses or overwrites the accept-invite token fragment', async () => {
    h = await mountAt('/accept-invite#token=s3cret-token');
    // The existing scrub still owns that fragment.
    expect(globalThis.location.hash).toBe('');
    expect(globalThis.location.pathname).toBe('/accept-invite');
    // The token was captured by the invite flow, not treated as a page.
    expect(h.store.state.inviteToken).toBe('s3cret-token');
    expect(h.store.state.authView).toBe('invite');
    // No page fragment was ever written, and the token is in no URL state.
    expect(globalThis.location.href).not.toContain('s3cret-token');
    expect(globalThis.location.href).not.toContain('#/');
  });

  // ---- inbound selection + canonicalization ----

  it('selects the page named by a recognized fragment, writing no history entry', async () => {
    const before = globalThis.history.length;
    h = await mountAt('/#/costs');
    expect(h.store.state.page).toBe('costs');
    expect(globalThis.location.hash).toBe('#/costs');
    expect(globalThis.history.length).toBe(before); // recognized ⇒ no write
  });

  it('canonicalizes an absent or unknown fragment to the default without pushing', async () => {
    const before = globalThis.history.length;
    h = await mountAt('/#/nope');
    expect(h.store.state.page).toBe('overview');
    expect(globalThis.location.hash).toBe('#/overview');
    expect(globalThis.history.length).toBe(before); // replace, never push
    h.dispose();
    h = await mountAt('/');
    expect(h.store.state.page).toBe('overview');
    expect(globalThis.location.hash).toBe('#/overview');
  });

  // ---- outbound writes ----

  it('pushes on a real page change and replaces when already there', async () => {
    h = await mountAt('/#/overview');
    const start = globalThis.history.length;
    h.store.go('costs');
    await flush();
    expect(globalThis.location.hash).toBe('#/costs');
    expect(globalThis.history.length).toBe(start + 1); // changed ⇒ push
    h.store.go('costs');
    await flush();
    expect(globalThis.history.length).toBe(start + 1); // same page ⇒ replace
  });

  it('clears the record selection on a page change from either direction', async () => {
    h = await mountAt('/#/requests');
    h.store.setState('selId', 'req-1');
    h.store.go('costs');
    await flush();
    expect(h.store.state.selId).toBeNull();
    // Browser-originated: set the selection again, then traverse.
    h.store.setState('selId', 'req-2');
    globalThis.history.replaceState(null, '', '#/agents');
    h.store.applyLocation();
    await flush();
    expect(h.store.state.page).toBe('agents');
    expect(h.store.state.selId).toBeNull();
  });

  // ---- browser-originated transitions never push ----

  it('applyLocation never pushes, is idempotent, and canonicalizes an unknown fragment in place', async () => {
    h = await mountAt('/#/costs');
    const start = globalThis.history.length;
    // A recognized location: state follows, nothing written.
    globalThis.history.replaceState(null, '', '#/agents');
    h.store.applyLocation();
    h.store.applyLocation(); // idempotent — double-firing is harmless
    await flush();
    expect(h.store.state.page).toBe('agents');
    expect(globalThis.location.hash).toBe('#/agents');
    expect(globalThis.history.length).toBe(start);
    // An unknown location mid-session: canonicalized by REPLACE, so the entry
    // count is untouched and a forward entry would survive.
    globalThis.history.replaceState(null, '', '#/bogus');
    h.store.applyLocation();
    await flush();
    expect(h.store.state.page).toBe('overview');
    expect(globalThis.location.hash).toBe('#/overview');
    expect(globalThis.history.length).toBe(start);
  });

  // ---- authorization ----

  it('does not let a URL reach the admin-only Users page as a non-admin', async () => {
    const fake = new FakeApiClient({ session: { ...DEFAULT_SESSION, role: null } });
    h = await mountAt('/#/users', fake);
    expect(h.store.state.page).toBe('overview');
    expect(globalThis.location.hash).toBe('#/overview');
    expect(h.host.textContent).not.toContain('Invite a user');
  });

  it('admits the Users page for an admin with no history write', async () => {
    const before = globalThis.history.length;
    h = await mountAt('/#/users');
    expect(h.store.state.session?.role).toBe('admin');
    expect(h.store.state.page).toBe('users');
    expect(globalThis.location.hash).toBe('#/users');
    expect(globalThis.history.length).toBe(before);
  });

  it('retains a held gated route across the login gate, then honors the role', async () => {
    // Unauthenticated: the gate renders and the request is HELD, not discarded.
    const fake = new FakeApiClient({ session: null });
    h = await mountAt('/#/users', fake);
    expect(h.store.state.authView).toBe('gate');
    expect(h.store.state.page).not.toBe('users'); // never rendered while unresolved
    // Now authenticate AS AN ADMIN — bootstrap re-runs and adjudicates.
    fake.session = { ...DEFAULT_SESSION, role: 'admin' };
    await h.store.bootstrap();
    await flush();
    expect(h.store.state.page).toBe('users'); // the route survived the gate
  });

  it('drops a held gated route when the login resolves to a non-admin', async () => {
    const fake = new FakeApiClient({ session: null });
    h = await mountAt('/#/users', fake);
    fake.session = { ...DEFAULT_SESSION, role: null };
    await h.store.bootstrap();
    await flush();
    expect(h.store.state.page).toBe('overview');
    expect(globalThis.location.hash).toBe('#/overview');
  });

  it('re-adjudicates on an identity change, so Users is not left rendered', async () => {
    const fake = new FakeApiClient({});
    h = await mountAt('/#/users', fake);
    expect(h.store.state.page).toBe('users');
    // Re-authenticate as a different, non-admin principal.
    fake.session = { ...DEFAULT_SESSION, userId: 'u2', role: null };
    await h.store.bootstrap();
    await flush();
    expect(h.store.state.page).toBe('overview');
    expect(globalThis.location.hash).toBe('#/overview');
  });

  // ---- listener lifecycle ----

  it('unsubscribes on unmount, so remounting leaves no duplicate listener', async () => {
    h = await mountAt('/#/costs');
    h.dispose();
    h = null;
    // With the listener removed, a fragment change must not touch the disposed
    // store; mounting fresh must still route correctly.
    globalThis.history.replaceState(null, '', '#/agents');
    globalThis.dispatchEvent(new Event('hashchange'));
    h = await mountAt('/#/limits');
    expect(h.store.state.page).toBe('limits');
  });
});
