/**
 * The docked Request Inspector (add-docked-inspector tasks 2.1–2.6; dashboard-analytics "At
 * wide viewports the inspector docks beside the request list"; dashboard-core "Overlays behave
 * as real dialogs" and "An overlay's behaviour is independent of its presentation").
 *
 * On the Requests page at a viewport of 1440px or more, the open inspector is the SAME
 * `#inspector-drawer` element presented as a non-modal panel: `rs-inspector-docked`, no scrim,
 * the content pane giving up its width (`rs-docked`), a complementary landmark registered as a
 * `docked` layer. Below the threshold, and on the Overview at every width, it is the modal
 * drawer it always was. Crossing the threshold while it is open changes only its modality.
 *
 * happy-dom applies no stylesheet and its viewport is 1024px, so its own `matchMedia` never
 * matches the dock query and every other suite keeps the modal drawer. Here `matchMedia` is a
 * mock that records `change` listeners per query and dispatches a change as a browser does
 * (the `theme.view.test.tsx` pattern), so a test can open at 1440 and cross in either
 * direction. Geometry — the 480px box, no shadow, the contained scroll, an operable list beside
 * the panel — is the browser suite's (`browser/dockedInspector.spec.ts`).
 *
 * The close-after-step cases of task 2.5 step twice: once with `store.select(id)` while the
 * inspector is open, which changes the shown record without closing it, and once through the
 * inspector's own Next control (task 4.3). Groups 3 and 4 add the retained record (3.1, 3.2),
 * stepping from the list (4.2), Previous / Next in every presentation (4.3) and focus kept on
 * the row through a list commit (4.4). The sheet presentation is the modal drawer with the
 * `narrow` query matching; happy-dom lays nothing out, so its geometry is the browser suite's.
 */
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unregisteredModalSurfaces, type LayerToken } from './a11y';
import { App } from './App';
import { rowCostLabel, toInspectorView } from './data/analytics';
import type { BatchJobDto, RequestRow } from './data/api';
import { fmtTime } from './data/catalog';
import { STEP_ANNOUNCE_SETTLE_MS } from './data/step';
import { createAppStore, DOCK_QUERY, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

type Listener = (e: { matches: boolean; media: string }) => void;

/** One `MediaQueryList` stand-in: its `matches`, its listeners, and a way to change it. */
class MediaMock {
  readonly listeners = new Set<Listener>();
  constructor(
    readonly media: string,
    public matches: boolean,
  ) {}
  addEventListener(type: string, fn: Listener): void {
    if (type === 'change') this.listeners.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    if (type === 'change') this.listeners.delete(fn);
  }
  /** The viewport crosses the query: `matches` first, then every listener, as a browser does. */
  dispatch(matches: boolean): void {
    this.matches = matches;
    for (const fn of [...this.listeners]) fn({ matches, media: this.media });
  }
}

/** The shell's `narrow` query (`Sidebar.tsx`): matching it is the sheet presentation. */
const NARROW_QUERY = '(max-width: 768px)';

/** Stub `matchMedia`; returns the dock query's mock. Every other query (the sidebar's
 * `narrow`, the theme's color scheme) gets its own inert mock, non-matching unless it is the
 * `narrow` query and `narrow` is asked for. */
function stubMedia(wide: boolean, narrow = false): MediaMock {
  const dock = new MediaMock(DOCK_QUERY, wide);
  const others = new Map<string, MediaMock>();
  vi.stubGlobal('matchMedia', (q: string): MediaMock => {
    if (q === DOCK_QUERY) return dock;
    const m = others.get(q) ?? new MediaMock(q, narrow && q === NARROW_QUERY);
    others.set(q, m);
    return m;
  });
  return dock;
}

interface H {
  host: HTMLElement;
  store: AppStore;
  client: FakeApiClient;
  media: MediaMock;
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** The app on `page`, with the viewport at the dock threshold (`wide`) or below it — at or
 * below `narrow` too when `narrow` is set (the sheet). */
async function mount(opts: {
  wide: boolean;
  narrow?: boolean;
  page?: 'requests' | 'overview';
  client?: FakeApiClient;
}): Promise<H> {
  const media = stubMedia(opts.wide, opts.narrow ?? false);
  const client = opts.client ?? new FakeApiClient();
  const store = createAppStore(client);
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  store.go(opts.page ?? 'requests');
  await flush();
  return { host, store, client, media };
}

const drawer = (h: H): HTMLElement | null => h.host.querySelector<HTMLElement>('#inspector-drawer');
const pane = (h: H): HTMLElement => h.host.querySelector<HTMLElement>('[data-pane="content"]')!;
const scrim = (h: H): HTMLElement | null => h.host.querySelector<HTMLElement>('.overlay');
/** The completed request rows, in the order they render. */
const rows = (h: H): HTMLButtonElement[] => [
  ...h.host.querySelectorAll<HTMLButtonElement>('.rs-table-requests button.req-row'),
];
const rowFor = (h: H, id: string): HTMLButtonElement | undefined =>
  rows(h).find((r) => r.dataset['requestId'] === id);
const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => labelText(b) === label);
const closeControl = (h: H): HTMLButtonElement =>
  drawer(h)!.querySelector<HTMLButtonElement>('button[aria-label="Close inspector"]')!;
const shownId = (h: H): string | null | undefined =>
  drawer(h)?.querySelector('[data-testid="inspector-id"]')?.textContent;
const panelRegion = (h: H, name: string): HTMLElement | null =>
  h.host.querySelector<HTMLElement>(`[role="region"][aria-label="${name}"]`);
/** A routing filter chip by its label (`button.filter-chip`, Requests l.155). */
const filterChip = (h: H, label: string): HTMLButtonElement =>
  [
    ...h.host.querySelectorAll<HTMLButtonElement>(
      '[data-testid="requests-filter-row"] .filter-chip',
    ),
  ].find((b) => labelText(b) === label)!;
/** The inspector's layer token, found by its root element. */
const inspectorToken = (h: H): LayerToken | undefined =>
  h.store.state.layers.find((l) => l.root() === drawer(h))?.token;

/** Escape, as the arbiter receives it: one keydown through the document. */
const escape = (): void => {
  (document.activeElement ?? document).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

/** Activate a row as a pointer or keyboard user does: focus it, then click it. */
async function activate(row: HTMLElement): Promise<void> {
  row.focus();
  row.click();
  await flush();
}

/** Focus never rests on the body or on content made inert. */
function expectFocusSomewhereReal(why: string): void {
  const a = document.activeElement;
  expect(a, `${why}: focus is on <body>`).not.toBe(document.body);
  expect(a, `${why}: nothing holds focus`).not.toBeNull();
  expect(a?.closest('[inert]'), `${why}: focus is on an inert element`).toBeNull();
}

function expectDocked(h: H): void {
  const d = drawer(h)!;
  expect(d.classList.contains('rs-inspector-docked'), 'the docked class').toBe(true);
  expect(d.classList.contains('drawer'), 'the drawer class stays').toBe(true);
  expect(d.getAttribute('role')).toBe('complementary');
  expect(d.hasAttribute('aria-modal'), 'a docked panel never claims aria-modal').toBe(false);
  expect(d.getAttribute('aria-label')).toBe('Request inspector');
  expect(scrim(h), 'no scrim is rendered while docked').toBeNull();
  expect(pane(h).classList.contains('rs-docked'), 'the content pane gives up the width').toBe(true);
  expect(h.store.state.layers.find((l) => l.root() === d)?.kind).toBe('docked');
  expect(unregisteredModalSurfaces(document, h.store.state.layers)).toEqual([]);
}

function expectModal(h: H): void {
  const d = drawer(h)!;
  expect(d.classList.contains('rs-inspector-docked'), 'no docked class').toBe(false);
  expect(d.getAttribute('role')).toBe('dialog');
  expect(d.getAttribute('aria-modal')).toBe('true');
  expect(d.getAttribute('aria-label')).toBe('Request inspector');
  expect(scrim(h), 'the modal drawer sits on its scrim').not.toBeNull();
  expect(pane(h).classList.contains('rs-docked'), 'the content pane keeps its width').toBe(false);
  expect(h.store.state.layers.find((l) => l.root() === d)?.kind).toBe('dialog');
  expect(unregisteredModalSurfaces(document, h.store.state.layers)).toEqual([]);
}

describe('the presentation (tasks 2.1, 2.2, 2.3)', () => {
  it('on Requests at the dock threshold a row opens the docked panel: no scrim, both classes; closing returns the width', async () => {
    const h = await mount({ wide: true });
    expect(h.media.listeners.size, 'the shell follows the dock query').toBe(1);
    expect(pane(h).classList.contains('rs-docked'), 'nothing is docked before a row opens').toBe(
      false,
    );
    await activate(rows(h)[0]!);
    expectDocked(h);
    expect(shownId(h)).toBe('req-000');

    closeControl(h).focus();
    closeControl(h).click();
    await flush();
    expect(drawer(h)).toBeNull();
    expect(pane(h).classList.contains('rs-docked'), 'the pane class goes on close').toBe(false);
    expect(scrim(h)).toBeNull();
  });

  it('below the threshold the same row opens the modal drawer on its scrim, exactly as before', async () => {
    const h = await mount({ wide: false });
    await activate(rows(h)[0]!);
    expectModal(h);
    expect(document.activeElement, 'the modal takes focus on open').toBe(drawer(h));
  });

  it('the Overview card opens its inspector modal at every width, the dock threshold included (2.3)', async () => {
    const h = await mount({ wide: true, page: 'overview' });
    const recent = h.host.querySelectorAll<HTMLButtonElement>('.rs-table-requests button.req-row');
    expect(recent.length, 'the Overview card lists recent requests').toBeGreaterThan(0);
    await activate(recent[0]!);
    expectModal(h);
    expect(document.activeElement, 'the modal takes focus on open').toBe(drawer(h));
  });

  it('the shell stops following the dock query when it unmounts', async () => {
    const h = await mount({ wide: true });
    expect(h.media.listeners.size).toBe(1);
    dispose?.();
    dispose = undefined;
    expect(h.media.listeners.size, 'a listener outlived the shell').toBe(0);
  });
});

describe('row activation (task 2.4, design D6)', () => {
  it('docked: activating a row leaves focus on it; another row shows its request and keeps focus there', async () => {
    const h = await mount({ wide: true });
    const first = rows(h)[0]!;
    await activate(first);
    expectDocked(h);
    const panel = drawer(h);
    expect(document.activeElement, 'opening the docked panel moves no focus').toBe(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');

    const third = rows(h)[3]!;
    await activate(third);
    expect(shownId(h)).toBe(third.dataset['requestId']);
    expect(drawer(h), 'the same panel, not a remount').toBe(panel);
    expect(document.activeElement).toBe(third);
    expect(third.getAttribute('aria-expanded')).toBe('true');
    expect(first.getAttribute('aria-expanded')).toBe('false');
  });

  it('docked: a bare click, with focus elsewhere as WebKit leaves it, still puts focus on the row, and ArrowDown steps', async () => {
    const h = await mount({ wide: true });
    const row = rows(h)[1]!;
    // The browser's click default is not modelled here: nothing focuses the row but the app.
    const outside = document.createElement('button');
    h.host.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    row.click();
    await flush();
    expectDocked(h);
    expect(document.activeElement, 'the clicked row does not hold focus').toBe(row);
    press(row, 'ArrowDown');
    expect(shownId(h)).toBe(rows(h)[2]!.dataset['requestId']);
    outside.remove();
  });

  it('docked: activating the selected row moves focus into the panel, which stays open and expanded', async () => {
    const h = await mount({ wide: true });
    const row = rows(h)[2]!;
    await activate(row);
    expect(document.activeElement).toBe(row);
    await activate(row);
    expect(drawer(h), 'a second activation closed the panel').not.toBeNull();
    expect(document.activeElement, 'focus moved to the panel root').toBe(drawer(h));
    expect(row.getAttribute('aria-expanded'), 'the row still announces the open panel').toBe(
      'true',
    );
    expect(row.getAttribute('aria-controls')).toBe('inspector-drawer');
    expect(h.store.state.selId).toBe(row.dataset['requestId']);
  });

  it('modal: activation opens the drawer and it takes focus; re-activating the row never closes it', async () => {
    const h = await mount({ wide: false });
    const row = rows(h)[1]!;
    await activate(row);
    expectModal(h);
    expect(document.activeElement).toBe(drawer(h));
    // Behind the scrim in a real browser; the handler itself has no toggle-to-close left.
    row.click();
    await flush();
    expect(drawer(h), 'toggle-to-close is gone').not.toBeNull();
    expect(h.store.state.selId).toBe(row.dataset['requestId']);
  });
});

describe('focus on close returns to the request shown (task 2.5, design D6)', () => {
  it('rows carry their request id; the request table panels are named, focusable regions', async () => {
    const h = await mount({ wide: true });
    for (const [i, r] of rows(h).entries()) {
      expect(r.dataset['requestId']).toBe(h.store.state.requestList[i]?.id);
    }
    const requests = panelRegion(h, 'Requests');
    expect(requests, 'the Requests table panel is a named region').not.toBeNull();
    expect(requests!.getAttribute('tabindex')).toBe('-1');
    expect(requests!.classList.contains('rs-table-requests')).toBe(true);
    h.store.go('overview');
    await flush();
    const recent = panelRegion(h, 'Recent requests');
    expect(recent, 'the Overview table panel is a named region').not.toBeNull();
    expect(recent!.getAttribute('tabindex')).toBe('-1');
    expect(recent!.classList.contains('rs-table-requests')).toBe(true);
  });

  for (const how of ['Escape', 'Close'] as const) {
    it(`docked, closed by ${how} with focus inside the panel: focus goes to the row shown`, async () => {
      const h = await mount({ wide: true });
      const row = rows(h)[4]!;
      await activate(row);
      closeControl(h).focus();
      if (how === 'Escape') escape();
      else closeControl(h).click();
      await flush();
      expect(drawer(h)).toBeNull();
      expect(document.activeElement).toBe(rowFor(h, 'req-004'));
      expectFocusSomewhereReal(how);
    });

    it(`docked, closed by ${how} with focus on the list: focus stays where it was`, async () => {
      const h = await mount({ wide: true });
      await activate(rows(h)[4]!);
      const other = rows(h)[7]!;
      other.focus();
      if (how === 'Escape') escape();
      else closeControl(h).click(); // activated without taking focus
      await flush();
      expect(drawer(h)).toBeNull();
      expect(document.activeElement).toBe(other);
    });
  }

  for (const wide of [true, false]) {
    for (const how of ['Escape', 'Close', ...(wide ? [] : ['scrim'])] as const) {
      it(`${wide ? 'docked' : 'modal drawer'}: closed by ${how} after two steps, focus goes to the row of the request shown, not the one opened`, async () => {
        const h = await mount({ wide });
        await activate(rows(h)[0]!);
        // Focus on a control inside the inspector, as it is on Previous / Next while stepping.
        closeControl(h).focus();
        const panel = drawer(h);
        h.store.select('req-001');
        await flush();
        h.store.select('req-002');
        await flush();
        expect(shownId(h)).toBe('req-002');
        expect(drawer(h), 'a step re-renders in place').toBe(panel);
        expect(document.activeElement).toBe(closeControl(h));
        if (how === 'Escape') escape();
        else if (how === 'Close') closeControl(h).click();
        else scrim(h)!.click();
        await flush();
        expect(drawer(h)).toBeNull();
        const a = document.activeElement as HTMLElement | null;
        expect(a?.dataset['requestId'], 'focus is on the row of the request shown').toBe('req-002');
        expect(a).not.toBe(panelRegion(h, 'Requests'));
        expectFocusSomewhereReal(how);
      });
    }
  }

  it('closed after its row was filtered away: focus lands on the Requests table panel', async () => {
    const h = await mount({ wide: true });
    await activate(rowFor(h, 'req-003')!); // a `structural` row: the Explicit filter excludes it
    closeControl(h).focus();
    h.store.setFilter('explicit');
    await flush();
    expect(rowFor(h, 'req-003'), 'the row is no longer rendered').toBeUndefined();
    expect(drawer(h), 'the inspector stays open on its record').not.toBeNull();
    escape();
    await flush();
    expect(drawer(h)).toBeNull();
    expect(document.activeElement).toBe(panelRegion(h, 'Requests'));
    expectFocusSomewhereReal('filtered away');
  });

  it('the Overview card: focus returns to its row, or to the Recent requests panel once the row is gone', async () => {
    const h = await mount({ wide: true, page: 'overview' });
    const first = h.host.querySelector<HTMLButtonElement>('.rs-table-requests button.req-row')!;
    const id = first.dataset['requestId']!;
    await activate(first);
    escape();
    await flush();
    expect(document.activeElement).toBe(rowFor(h, id));

    await activate(rowFor(h, id)!);
    expect(document.activeElement).toBe(drawer(h));
    h.store.setState('recentRequests', []); // the six-row window moved on
    await flush();
    expect(drawer(h), 'the inspector outlives its row').not.toBeNull();
    escape();
    await flush();
    expect(document.activeElement).toBe(panelRegion(h, 'Recent requests'));
    expectFocusSomewhereReal('Overview');
  });
});

describe('crossing the dock threshold while open (task 2.6, design D2)', () => {
  /** The inspector's identity across a crossing: the same element and the same token. */
  function identity(h: H): { el: HTMLElement; token: LayerToken } {
    const el = drawer(h);
    const token = inspectorToken(h);
    expect(el).not.toBeNull();
    expect(token).toBeDefined();
    return { el: el!, token: token! };
  }
  function expectSame(h: H, before: { el: HTMLElement; token: LayerToken }): void {
    expect(drawer(h), 'the same inspector element').toBe(before.el);
    expect(inspectorToken(h), 'the same layer registration').toBe(before.token);
    expect(h.store.state.layers.filter((l) => l.root() === before.el)).toHaveLength(1);
    expect(unregisteredModalSurfaces(document, h.store.state.layers)).toEqual([]);
  }

  it('focus inside the panel: down claims the modal and keeps focus; up drops it and keeps focus', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[0]!);
    const before = identity(h);
    closeControl(h).focus();

    h.media.dispatch(false);
    await flush();
    expectModal(h);
    expectSame(h, before);
    expect(document.activeElement, 'focus inside stays where it was').toBe(closeControl(h));
    expectFocusSomewhereReal('down');

    h.media.dispatch(true);
    await flush();
    expectDocked(h);
    expectSame(h, before);
    expect(document.activeElement).toBe(closeControl(h));
    expectFocusSomewhereReal('up');
  });

  for (const where of ['row', 'filter'] as const) {
    it(`focus on a ${where}: crossing down moves focus into the inspector; crossing back up leaves it there`, async () => {
      const h = await mount({ wide: true });
      await activate(rows(h)[0]!);
      const before = identity(h);
      const control = where === 'row' ? rows(h)[3]! : filterChip(h, 'Auto');
      control.focus();
      expect(document.activeElement).toBe(control);

      h.media.dispatch(false);
      await flush();
      expectModal(h);
      expectSame(h, before);
      expect(document.activeElement, 'focus moved into the now-modal inspector').toBe(drawer(h));
      expectFocusSomewhereReal('down');

      h.media.dispatch(true);
      await flush();
      expectDocked(h);
      expectSame(h, before);
      expect(document.activeElement).toBe(drawer(h));
      expectFocusSomewhereReal('up');
    });
  }

  it('opened modal, crossing up with focus on a row or a filter leaves focus where it was', async () => {
    const h = await mount({ wide: false });
    await activate(rows(h)[0]!);
    const before = identity(h);
    for (const control of [rows(h)[5]!, filterChip(h, 'All')]) {
      control.focus(); // programmatic: behind a modal a user cannot reach it
      h.media.dispatch(true);
      await flush();
      expectDocked(h);
      expectSame(h, before);
      expect(document.activeElement).toBe(control);
      h.media.dispatch(false);
      await flush();
      expectModal(h);
      expectSame(h, before);
      expect(document.activeElement, 'down again: focus into the inspector').toBe(drawer(h));
      expectFocusSomewhereReal('opened modal, crossed twice');
    }
  });

  it('the account menu open above the docked panel is dismissed on the downward crossing, and the inspector is topmost', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[0]!);
    const before = identity(h);
    const trigger = h.host.querySelector<HTMLButtonElement>('.account-trigger')!;
    trigger.focus();
    trigger.click();
    await flush();
    expect(h.store.state.accountMenuOpen, 'the menu opened').toBe(true);
    expect(h.store.state.layers.at(-1)?.kind).toBe('menu');

    h.media.dispatch(false);
    await flush();
    expect(h.store.state.accountMenuOpen, 'the menu was superseded').toBe(false);
    expect(h.host.querySelector('[role="menu"]')).toBeNull();
    expectModal(h);
    expectSame(h, before);
    expect(h.store.state.layers.at(-1)?.root(), 'the inspector is topmost').toBe(drawer(h));
    expect(document.activeElement, 'not pulled back to the menu trigger').toBe(drawer(h));
    expectFocusSomewhereReal('menu superseded');
    escape();
    await flush();
    expect(drawer(h), 'the first Escape reaches the inspector').toBeNull();
  });

  it('closing after a downward crossing returns focus to the row shown, never to the filter that held it', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[2]!);
    filterChip(h, 'Auto').focus();
    h.media.dispatch(false);
    await flush();
    expect(document.activeElement).toBe(drawer(h));
    escape();
    await flush();
    expect(drawer(h)).toBeNull();
    expect(document.activeElement).toBe(rowFor(h, 'req-002'));
    expectFocusSomewhereReal('close after crossing');
  });

  it('closing after a downward crossing, its row filtered away: focus lands on the Requests table panel', async () => {
    const h = await mount({ wide: true });
    await activate(rowFor(h, 'req-003')!); // `structural`: the Explicit filter excludes it
    const explicit = filterChip(h, 'Explicit');
    explicit.focus();
    explicit.click();
    await flush();
    expect(rowFor(h, 'req-003')).toBeUndefined();
    expect(document.activeElement).toBe(explicit);
    h.media.dispatch(false);
    await flush();
    expect(document.activeElement).toBe(drawer(h));
    escape();
    await flush();
    expect(drawer(h)).toBeNull();
    expect(document.activeElement).toBe(panelRegion(h, 'Requests'));
    expectFocusSomewhereReal('filtered, then crossed');
  });

  it('a dialog above at the crossing keeps focus and Escape; closing it returns focus to the panel’s Delete', async () => {
    const h = await mount({ wide: true });
    await activate(rowFor(h, 'req-000')!); // a row with stored bodies
    const before = identity(h);
    buttonIn(drawer(h)!, 'Show bodies')!.click();
    await flush();
    const del = buttonIn(drawer(h)!, 'Delete');
    expect(del, 'Delete renders once the bodies show').toBeDefined();
    del!.focus();
    del!.click();
    await flush();
    const confirm = h.host.querySelector<HTMLElement>('[role="dialog"].confirm-card');
    expect(confirm, 'the payload deletion confirmation opened').not.toBeNull();
    expect(drawer(h), 'the dialog did not supersede the docked panel').not.toBeNull();
    const focused = document.activeElement;
    expect(confirm!.contains(focused)).toBe(true);

    h.media.dispatch(false);
    await flush();
    expectSame(h, before);
    expect(drawer(h)!.getAttribute('role')).toBe('dialog');
    expect(drawer(h)!.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement, 'no focus moved at the crossing').toBe(focused);
    expectFocusSomewhereReal('dialog above');
    expect(h.store.state.layers.at(-1)?.root(), 'the confirmation is still topmost').toBe(confirm);

    escape();
    await flush();
    expect(h.host.querySelector('[role="dialog"].confirm-card'), 'Escape closed it').toBeNull();
    expect(drawer(h), 'and only it').not.toBeNull();
    expect(document.activeElement, 'focus returns to the panel’s Delete').toBe(
      buttonIn(drawer(h)!, 'Delete'),
    );
    expect(h.client.countOf('deleteRequestBodies')).toBe(0);
  });

  it('a dialog opened from outside the panel: after a downward crossing its close focuses the inspector root, never the now-inert opener', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[0]!);
    const opener = filterChip(h, 'Auto');
    opener.focus();
    h.store.confirmDestructive({
      title: 'Probe?',
      body: 'A dialog opened from the page beside the docked panel.',
      commitLabel: 'Probe',
      busyLabel: 'Probing…',
      run: () => Promise.resolve(),
      fallbackFocus: () => null,
    });
    await flush();
    const confirm = h.host.querySelector<HTMLElement>('[role="dialog"].confirm-card');
    expect(confirm).not.toBeNull();
    expect(confirm!.contains(document.activeElement)).toBe(true);

    h.media.dispatch(false);
    await flush();
    expect(confirm!.contains(document.activeElement), 'focus stays in the dialog').toBe(true);
    expectFocusSomewhereReal('dialog from outside, crossed');
    escape();
    await flush();
    expect(h.host.querySelector('[role="dialog"].confirm-card')).toBeNull();
    expect(document.activeElement, 'not the opener, now behind the modal inspector').toBe(
      drawer(h),
    );
    expectFocusSomewhereReal('dialog from outside');
  });
});

// ---------------------------------------------------------------------------------------------
// Groups 3 and 4: the retained record, stepping from the list, Previous / Next, focus kept
// through a list commit.
// ---------------------------------------------------------------------------------------------

/** The three presentations, as this suite can mount them. */
const PRESENTATIONS = [
  { name: 'docked', wide: true, narrow: false },
  { name: 'modal drawer', wide: false, narrow: false },
  { name: 'sheet', wide: false, narrow: true },
] as const;

const stepControl = (h: H, label: 'Previous request' | 'Next request'): HTMLButtonElement =>
  drawer(h)!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const prev = (h: H): HTMLButtonElement => stepControl(h, 'Previous request');
const next = (h: H): HTMLButtonElement => stepControl(h, 'Next request');

/** One keydown on `el`, bubbling and cancelable as a browser sends it. Returns the event so a
 * test can read `defaultPrevented`. */
function press(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

/** The rows with the Selected state. */
const selectedRows = (h: H): string[] =>
  rows(h)
    .filter((r) => r.getAttribute('aria-expanded') === 'true')
    .map((r) => r.dataset['requestId'] ?? '?');

/** The fake's request rows with `n` newer requests in front: what a later page-1 read returns
 * once they have arrived. */
function arrive(client: FakeApiClient, n: number): void {
  const base = Date.parse(client.requestRows[0]!.createdAt);
  const newer = client.requestRows.slice(0, n).map((r, i) => ({
    ...r,
    id: `new-${String(i).padStart(3, '0')}`,
    createdAt: new Date(base + (n - i) * 1000).toISOString(),
  }));
  client.requestRows = [...newer, ...client.requestRows];
}

/** Every `scrollIntoView` call, by the element it was called on. */
function spyScroll(): { calls: { el: Element; arg: unknown }[] } {
  const calls: { el: Element; arg: unknown }[] = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
    this: Element,
    arg?: boolean | ScrollIntoViewOptions,
  ) {
    calls.push({ el: this, arg });
  });
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('close after stepping with Next returns focus to the row shown (task 2.5, with 4.3)', () => {
  for (const wide of [true, false]) {
    for (const how of ['Escape', 'Close', ...(wide ? [] : ['scrim'])] as const) {
      it(`${wide ? 'docked' : 'modal drawer'}: two Next steps, then ${how}: focus is on the row of the request shown`, async () => {
        const h = await mount({ wide });
        await activate(rows(h)[0]!);
        const panel = drawer(h);
        next(h).focus();
        next(h).click();
        await flush();
        next(h).click();
        await flush();
        expect(shownId(h)).toBe('req-002');
        expect(drawer(h), 'a step re-renders in place').toBe(panel);
        expect(document.activeElement, 'focus stays on Next while stepping').toBe(next(h));
        if (how === 'Escape') escape();
        else if (how === 'Close') closeControl(h).click();
        else scrim(h)!.click();
        await flush();
        expect(drawer(h)).toBeNull();
        const a = document.activeElement as HTMLElement | null;
        expect(a?.dataset['requestId'], 'not the row that first opened it').toBe('req-002');
        expectFocusSomewhereReal(how);
      });
    }
  }
});

describe('the retained record (tasks 3.1, 3.2, design D7)', () => {
  it('an id in neither list opens nothing at the dock threshold, and the pane keeps its width', async () => {
    const h = await mount({ wide: true });
    h.store.select('no-such-request');
    await flush();
    expect(drawer(h)).toBeNull();
    expect(h.store.inspectorDocked()).toBe(false);
    expect(pane(h).classList.contains('rs-docked'), 'width reserved for no panel').toBe(false);
  });

  it('a refresh that drops R keeps the docked panel open on R, focus unmoved, no row selected; a later load re-selects its row', async () => {
    const h = await mount({ wide: true });
    await activate(rowFor(h, 'req-020')!);
    const panel = drawer(h);
    const reason = panel!.querySelector('[data-testid="inspector-decision"]')!.textContent;
    closeControl(h).focus();
    const original = h.client.requestRows;

    arrive(h.client, 10); // ten newer requests push R off page 1
    await h.store.refreshRequestsPage();
    await flush();
    expect(rowFor(h, 'req-020'), 'R is no longer listed').toBeUndefined();
    expect(drawer(h), 'the same panel, open').toBe(panel);
    expect(shownId(h)).toBe('req-020');
    expect(panel!.querySelector('[data-testid="inspector-decision"]')!.textContent).toBe(reason);
    expect(document.activeElement, 'focus inside the panel did not move').toBe(closeControl(h));
    expect(selectedRows(h), 'no row shows the Selected state').toEqual([]);
    expectDocked(h);

    h.client.requestRows = original;
    await h.store.refreshRequestsPage();
    await flush();
    expect(selectedRows(h), 'the row is selected again').toEqual(['req-020']);
    expect(drawer(h)).toBe(panel);
    expect(shownId(h)).toBe('req-020');
    expect(document.activeElement).toBe(closeControl(h));
  });

  it('a filter that excludes R keeps the panel open on R; clearing it re-selects R’s row', async () => {
    const h = await mount({ wide: true });
    await activate(rowFor(h, 'req-003')!); // `structural`: the Explicit filter excludes it
    const panel = drawer(h);
    closeControl(h).focus();
    h.store.setFilter('explicit');
    await flush();
    expect(rowFor(h, 'req-003')).toBeUndefined();
    expect(drawer(h)).toBe(panel);
    expect(shownId(h)).toBe('req-003');
    expect(document.activeElement).toBe(closeControl(h));
    expect(selectedRows(h)).toEqual([]);
    h.store.setFilter('all');
    await flush();
    expect(selectedRows(h)).toEqual(['req-003']);
    expect(drawer(h)).toBe(panel);
  });

  for (const p of PRESENTATIONS) {
    it(`${p.name}: one inspector node across a replaced record and every kind of step`, async () => {
      const h = await mount({ wide: p.wide, narrow: p.narrow });
      await activate(rows(h)[1]!);
      const panel = drawer(h);
      expect(panel).not.toBeNull();
      if (p.wide) expectDocked(h);
      else expectModal(h);
      const decision = (): string =>
        drawer(h)!.querySelector('[data-testid="inspector-decision"]')!.textContent ?? '';

      // A newer same-id row from a later load re-renders in place.
      h.client.requestRows = h.client.requestRows.map((r) =>
        r.id === 'req-001' ? { ...r, routingReason: 'newer reason for req-001' } : r,
      );
      await h.store.refreshRequestsPage();
      await flush();
      expect(decision()).toContain('newer reason for req-001');
      expect(drawer(h), 'a replaced record remounted the inspector').toBe(panel);

      next(h).click();
      await flush();
      expect(shownId(h)).toBe('req-002');
      expect(drawer(h), 'a Next step remounted the inspector').toBe(panel);
      press(prev(h), 'ArrowUp');
      await flush();
      expect(shownId(h)).toBe('req-001');
      expect(drawer(h), 'an arrow step on Previous remounted the inspector').toBe(panel);
      if (p.wide) {
        rowFor(h, 'req-001')!.focus();
        press(rowFor(h, 'req-001')!, 'ArrowDown');
        await flush();
        expect(shownId(h)).toBe('req-002');
        expect(drawer(h), 'a row step remounted the inspector').toBe(panel);
      }
    });
  }

  it('docked twin of the payload delete: one delete; the Payload section is gone and focus is in the inspector', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const h = await mount({ wide: true });
    await activate(rowFor(h, 'req-000')!); // a row with stored bodies
    expectDocked(h);
    buttonIn(drawer(h)!, 'Show bodies')!.click();
    await flush();
    const del = buttonIn(drawer(h)!, 'Delete')!;
    del.focus();
    del.click();
    await flush();
    const dialog = h.host.querySelector<HTMLElement>('[role="dialog"].confirm-card')!;
    const commit = dialog.querySelector<HTMLButtonElement>('button.btn-destructive')!;
    commit.click();
    commit.click();
    await flush();
    expect(h.client.countOf('deleteRequestBodies')).toBe(1);
    expect(h.host.querySelector('[role="dialog"].confirm-card')).toBeNull();
    const payloadLabel = [...drawer(h)!.querySelectorAll('.upper-label')].some(
      (l) => l.textContent === 'Payload',
    );
    expect(payloadLabel, 'the Payload section outlived its bodies').toBe(false);
    expect(drawer(h)).not.toBeNull();
    expectDocked(h);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(drawer(h));
    expect(h.store.state.toast).toEqual({ kind: 'confirm', text: 'Payloads deleted' });
  });
});

/** A live batch job for the Requests band. */
const bandJob = (over: Partial<BatchJobDto> = {}): BatchJobDto => ({
  id: 'bj-band',
  upstreamBatchId: 'up-bj-band',
  status: 'in_progress',
  terminal: false,
  endpoint: '/v1/chat/completions',
  agentId: 'agent-0',
  providerId: 'p1',
  providerLabel: 'prov-band',
  modelId: 'm1',
  modelLabel: 'model-band',
  tierAssigned: 'nightly',
  counts: { total: 50, completed: 12, failed: 0 },
  submittedAt: new Date(Date.now() - 3 * 3_600_000 - 5 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  terminalAt: null,
  reservedCeilingMicros: 25_000,
  settledCostMicros: null,
  resultsExpireAt: null,
  errorKind: null,
  ...over,
});
const LIVE = {
  id: 'live-1',
  startedAt: Date.now(),
  decisionLayer: 'explicit',
  tierAssigned: 'tier-live',
  modelLabel: 'model-live-1',
  providerLabel: 'ProvLive',
  protocol: 'openai',
  status: 'running',
} as const;

describe('docked stepping from the list (task 4.2, design D8)', () => {
  it('ArrowDown and ArrowUp on a focused row step the selection, move focus, scroll the row into view, and prevent the default', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[2]!);
    const panel = drawer(h);
    const scroll = spyScroll();
    const down = press(rowFor(h, 'req-002')!, 'ArrowDown');
    await flush();
    expect(down.defaultPrevented, 'the page would also scroll').toBe(true);
    expect(h.store.state.selId).toBe('req-003');
    expect(shownId(h)).toBe('req-003');
    expect(document.activeElement, 'focus moves to the row stepped to').toBe(rowFor(h, 'req-003'));
    expect(selectedRows(h)).toEqual(['req-003']);
    expect(scroll.calls.at(-1)?.el).toBe(rowFor(h, 'req-003'));
    expect(scroll.calls.at(-1)?.arg).toEqual({ block: 'nearest' });
    expect(drawer(h)).toBe(panel);

    press(rowFor(h, 'req-003')!, 'ArrowUp');
    await flush();
    press(document.activeElement!, 'ArrowUp');
    await flush();
    expect(shownId(h)).toBe('req-001');
    expect(document.activeElement).toBe(rowFor(h, 'req-001'));
    expectDocked(h);
  });

  it('steps from the focused row, not from the selection', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[2]!);
    rowFor(h, 'req-007')!.focus(); // tabbed down the list without opening anything
    press(rowFor(h, 'req-007')!, 'ArrowDown');
    await flush();
    expect(shownId(h)).toBe('req-008');
    expect(document.activeElement).toBe(rowFor(h, 'req-008'));
  });

  it('passes over the agent boundaries between rows, never steps onto a live or batch-job row, and never wraps', async () => {
    const h = await mount({ wide: true, client: new FakeApiClient({ batchJobs: [bandJob()] }) });
    // A running request and a live batch job above the completed rows.
    // (a settling row too, and a loaded batch band: the rows a step must never reach)
    h.store.setState('inflightRows', [
      { ...LIVE, phase: 'live' },
      { ...LIVE, id: 'finishing-1', phase: 'settling' },
    ]);
    await h.store.loadBatchBand();
    await flush();
    const band = h.host.querySelectorAll('.rs-table-requests div.req-row');
    expect(band.length, 'the live, settling and batch-job rows render above the list').toBe(3);
    // The store's order is the completed request list's ids and nothing else (design D8).
    const completed = h.store.state.requestList.map((r) => r.id);
    expect(completed.length).toBeGreaterThan(5);
    expect(h.store.state.inflightRows.map((r) => r.id)).toEqual(['live-1', 'finishing-1']);
    await activate(rows(h)[0]!);
    expect(h.store.canStep('previous'), 'Previous from the first completed row').toBe(false);
    expect(h.store.canStep('next')).toBe(true);
    // Every default fixture row starts a new agent run: a boundary sits between rows 0 and 1.
    const first = rowFor(h, 'req-000')!;
    expect(first.nextElementSibling?.classList.contains('rs-agent-boundary')).toBe(true);
    press(first, 'ArrowDown');
    await flush();
    expect(shownId(h), 'over the boundary to the next request').toBe('req-001');
    press(rowFor(h, 'req-001')!, 'ArrowUp');
    await flush();
    expect(shownId(h)).toBe('req-000');

    // The first completed row: nothing above it can open, so ArrowUp changes nothing.
    const up = press(rowFor(h, 'req-000')!, 'ArrowUp');
    await flush();
    expect(up.defaultPrevented, 'a bound still owns the key').toBe(true);
    expect(shownId(h)).toBe('req-000');
    expect(h.store.state.selId).toBe('req-000');
    expect(document.activeElement).toBe(rowFor(h, 'req-000'));
    // Previous from the first completed row is unavailable and reaches neither the running,
    // the finishing nor the batch-job row above it.
    const prev = h.host.querySelector<HTMLElement>(
      '#inspector-drawer [aria-label="Previous request"]',
    )!;
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    prev.click();
    await flush();
    expect(h.store.state.selId).toBe('req-000');
  });

  it('ArrowDown on the last loaded row issues no list request and changes nothing', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[0]!);
    const last = rows(h).at(-1)!;
    expect(last.dataset['requestId']).toBe('req-024');
    expect(h.store.state.requestCursor, 'further pages exist').not.toBeNull();
    last.focus();
    const reads = h.client.countOf('requests');
    press(last, 'ArrowDown');
    await flush();
    expect(h.client.countOf('requests'), 'a step loaded a page').toBe(reads);
    expect(h.store.state.selId).toBe('req-000');
    expect(rows(h)).toHaveLength(25);
    expect(document.activeElement).toBe(last);
  });

  it('ArrowUp on the first row under the "N new" offer does not take it', async () => {
    const h = await mount({ wide: true });
    h.store.setState({
      requestsPaged: true,
      requestsNew: { count: 3, atLeast: false, unknown: false },
    });
    await flush();
    const offer = buttonIn(h.host, '3 new · load');
    expect(offer, 'the offer is shown above the list').toBeDefined();
    await activate(rows(h)[0]!);
    const reads = h.client.countOf('requests');
    press(rowFor(h, 'req-000')!, 'ArrowUp');
    await flush();
    expect(h.client.countOf('requests'), 'the offer was taken').toBe(reads);
    expect(h.store.state.requestsNew).toEqual({ count: 3, atLeast: false, unknown: false });
    expect(document.activeElement, 'focus moved onto the offer').toBe(rowFor(h, 'req-000'));
    expect(shownId(h)).toBe('req-000');
  });

  it('stepping to a request with captured payloads issues no bodies request; its Payload starts collapsed', async () => {
    const h = await mount({ wide: true });
    await activate(rowFor(h, 'req-004')!);
    press(rowFor(h, 'req-004')!, 'ArrowDown');
    await flush();
    expect(shownId(h)).toBe('req-005');
    expect(
      buttonIn(drawer(h)!, 'Show bodies'),
      'the Payload section starts collapsed',
    ).toBeDefined();
    expect(h.client.countOf('requestBodies')).toBe(0);

    // Expanded, then stepped away and back: collapsed again, and nothing is fetched by the steps.
    buttonIn(drawer(h)!, 'Show bodies')!.click();
    await flush();
    expect(h.client.countOf('requestBodies')).toBe(1);
    press(rowFor(h, 'req-005')!, 'ArrowDown');
    await flush();
    press(rowFor(h, 'req-006')!, 'ArrowUp');
    await flush();
    expect(shownId(h)).toBe('req-005');
    expect(buttonIn(drawer(h)!, 'Show bodies')).toBeDefined();
    expect(h.client.countOf('requestBodies'), 'a step fetched payload bodies').toBe(1);
  });

  describe('stays out of other keyboard owners’ way', () => {
    /** Open row 2 docked; then `act` presses a key somewhere. The selection must not change. */
    async function expectNoStep(
      act: (h: H) => KeyboardEvent | Promise<KeyboardEvent>,
      opts: { prevented?: boolean } = {},
    ): Promise<H> {
      const h = await mount({ wide: true });
      await activate(rows(h)[2]!);
      const e = await act(h);
      await flush();
      expect(h.store.state.selId, 'the selection changed').toBe('req-002');
      expect(shownId(h)).toBe('req-002');
      if (opts.prevented !== undefined) expect(e.defaultPrevented).toBe(opts.prevented);
      return h;
    }

    for (const role of [null, 'combobox'] as const) {
      it(`a ${role === null ? 'text field' : 'combobox'} — even one inside a row`, async () => {
        await expectNoStep(
          (h) => {
            const input = document.createElement('input');
            if (role !== null) input.setAttribute('role', role);
            rowFor(h, 'req-002')!.appendChild(input); // inside the row: the row's handler sees it
            input.focus();
            return press(input, 'ArrowDown');
          },
          { prevented: false },
        );
        expect(document.activeElement?.tagName).toBe('INPUT');
      });
    }

    it('the Agent filter select', async () => {
      await expectNoStep(
        (h) => {
          const select = h.host.querySelector<HTMLSelectElement>('#req-agent')!;
          select.focus();
          return press(select, 'ArrowDown');
        },
        { prevented: false },
      );
      expect(document.activeElement?.id).toBe('req-agent');
    });

    it('a filter chip', async () => {
      await expectNoStep(
        (h) => {
          const chip = filterChip(h, 'Auto');
          chip.focus();
          return press(chip, 'ArrowDown');
        },
        { prevented: false },
      );
    });

    it('a composing input method', async () => {
      await expectNoStep((h) => press(rowFor(h, 'req-002')!, 'ArrowDown', { isComposing: true }), {
        prevented: false,
      });
    });

    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      it(`a held modifier (${mod})`, async () => {
        await expectNoStep((h) => press(rowFor(h, 'req-002')!, 'ArrowDown', { [mod]: true }), {
          prevented: false,
        });
      });
    }

    it('a menu open above the inspector', async () => {
      const h = await expectNoStep(async (h) => {
        const trigger = h.host.querySelector<HTMLButtonElement>('.account-trigger')!;
        trigger.focus();
        trigger.click();
        await flush();
        expect(h.store.state.layers.at(-1)?.kind).toBe('menu');
        return press(rowFor(h, 'req-002')!, 'ArrowDown');
      });
      // The menu kept the key: its own arrow navigation moved focus into it.
      expect(h.host.querySelector('[role="menu"]')?.contains(document.activeElement)).toBe(true);
    });

    it('a dialog open above the inspector', async () => {
      const h = await expectNoStep(
        async (h) => {
          h.store.confirmDestructive({
            title: 'Probe?',
            body: 'A dialog above the docked panel.',
            commitLabel: 'Probe',
            busyLabel: 'Probing…',
            run: () => Promise.resolve(),
            fallbackFocus: () => null,
          });
          await flush();
          expect(h.store.state.layers.at(-1)?.kind).toBe('dialog');
          return press(rowFor(h, 'req-002')!, 'ArrowDown');
        },
        { prevented: false },
      );
      expect(
        h.host.querySelector('[role="dialog"].confirm-card')?.contains(document.activeElement),
      ).toBe(true);
    });

    it('a modal presentation: the rows’ arrow keys are not stepping keys below the dock threshold', async () => {
      const h = await mount({ wide: false });
      await activate(rows(h)[2]!);
      const e = press(rowFor(h, 'req-002')!, 'ArrowDown');
      await flush();
      expect(e.defaultPrevented).toBe(false);
      expect(shownId(h)).toBe('req-002');
    });

    it('no inspector open: the rows’ arrow keys do nothing at the dock threshold', async () => {
      const h = await mount({ wide: true });
      rows(h)[2]!.focus();
      const e = press(rows(h)[2]!, 'ArrowDown');
      await flush();
      expect(e.defaultPrevented).toBe(false);
      expect(h.store.state.selId).toBeNull();
      expect(drawer(h)).toBeNull();
    });
  });
});

describe('Previous and Next (task 4.3, design D8)', () => {
  it('are named, expose their shortcuts, take the rs-inspector-step size, and sit in the head beside Close — never a chip', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[1]!);
    for (const [el, label, keyName, icon] of [
      [prev(h), 'Previous request', 'ArrowUp', 'chevronUp'],
      [next(h), 'Next request', 'ArrowDown', 'chevronDown'],
    ] as const) {
      expect(el, `${label} is missing`).toBeDefined();
      expect(el.getAttribute('aria-label')).toBe(label);
      expect(el.getAttribute('aria-keyshortcuts')).toBe(keyName);
      expect(el.classList.contains('rs-inspector-step')).toBe(true);
      expect(el.classList.contains('chip'), 'the badge is read as `.drawer-head .chip`').toBe(
        false,
      );
      expect(el.closest('.drawer-head')).not.toBeNull();
      expect(el.querySelector(`[data-icon="${icon}"]`)?.getAttribute('aria-hidden')).toBe('true');
      expect(el.parentElement).toBe(closeControl(h).parentElement);
    }
    expect(drawer(h)!.querySelectorAll('.drawer-head .chip'), 'one badge only').toHaveLength(1);
  });

  for (const p of PRESENTATIONS) {
    describe(`${p.name}`, () => {
      it('Next and Previous step, focus stays on the control, and the row is scrolled into view', async () => {
        const h = await mount({ wide: p.wide, narrow: p.narrow });
        await activate(rows(h)[0]!);
        const panel = drawer(h);
        const scroll = spyScroll();
        next(h).focus();
        next(h).click();
        await flush();
        expect(shownId(h)).toBe('req-001');
        expect(document.activeElement).toBe(next(h));
        expect(scroll.calls.at(-1)?.el).toBe(rowFor(h, 'req-001'));
        expect(scroll.calls.at(-1)?.arg).toEqual({ block: 'nearest' });

        const down = press(next(h), 'ArrowDown');
        await flush();
        expect(down.defaultPrevented).toBe(true);
        expect(shownId(h)).toBe('req-002');
        expect(document.activeElement).toBe(next(h));
        // The key decides the direction, on either control.
        press(next(h), 'ArrowUp');
        await flush();
        expect(shownId(h)).toBe('req-001');
        prev(h).focus();
        prev(h).click();
        await flush();
        expect(shownId(h)).toBe('req-000');
        expect(document.activeElement).toBe(prev(h));
        expect(drawer(h)).toBe(panel);
        if (p.wide) expectDocked(h);
        else expectModal(h);
      });

      it('a bound leaves the control focusable but unavailable: aria-disabled, never disabled, and it keeps focus', async () => {
        const h = await mount({ wide: p.wide, narrow: p.narrow });
        await activate(rows(h)[0]!);
        expect(prev(h).getAttribute('aria-disabled')).toBe('true');
        expect(prev(h).disabled, 'natively disabled drops focus').toBe(false);
        expect(next(h).hasAttribute('aria-disabled')).toBe(false);
        prev(h).focus();
        prev(h).click();
        const up = press(prev(h), 'ArrowUp');
        await flush();
        expect(up.defaultPrevented, 'the key still never scrolls the panel').toBe(true);
        expect(shownId(h)).toBe('req-000');
        expect(document.activeElement, 'a bound dropped focus').toBe(prev(h));

        // The last loaded row: Next is the unavailable one.
        h.store.select('req-024');
        await flush();
        expect(next(h).getAttribute('aria-disabled')).toBe('true');
        expect(prev(h).hasAttribute('aria-disabled')).toBe(false);
        const reads = h.client.countOf('requests');
        next(h).focus();
        next(h).click();
        press(next(h), 'ArrowDown');
        await flush();
        expect(shownId(h)).toBe('req-024');
        expect(document.activeElement).toBe(next(h));
        expect(h.client.countOf('requests'), 'Next at the last row loaded a page').toBe(reads);
      });

      it('a request that has left the list has no neighbours, and stays readable', async () => {
        const h = await mount({ wide: p.wide, narrow: p.narrow });
        await activate(rowFor(h, 'req-003')!); // `structural`
        h.store.setFilter('explicit');
        await flush();
        expect(rowFor(h, 'req-003')).toBeUndefined();
        expect(shownId(h)).toBe('req-003');
        expect(prev(h).getAttribute('aria-disabled')).toBe('true');
        expect(next(h).getAttribute('aria-disabled')).toBe('true');
        next(h).click();
        press(next(h), 'ArrowDown');
        await flush();
        expect(shownId(h)).toBe('req-003');
      });
    });
  }

  it('docked: stepping from a focused row still works once the request shown has left the list', async () => {
    const h = await mount({ wide: true });
    await activate(rowFor(h, 'req-003')!);
    h.store.setFilter('explicit');
    await flush();
    const first = rows(h)[0]!;
    first.focus();
    press(first, 'ArrowDown');
    await flush();
    expect(shownId(h)).toBe(rows(h)[1]!.dataset['requestId']);
    expect(prev(h).hasAttribute('aria-disabled')).toBe(false);
  });

  it('the controls’ arrow keys keep the same guards: a modifier, composition, a dialog above', async () => {
    const h = await mount({ wide: false });
    await activate(rows(h)[3]!);
    next(h).focus();
    for (const init of [
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { isComposing: true },
    ]) {
      const e = press(next(h), 'ArrowDown', init);
      await flush();
      expect(e.defaultPrevented, JSON.stringify(init)).toBe(false);
      expect(shownId(h), JSON.stringify(init)).toBe('req-003');
    }
    h.store.confirmDestructive({
      title: 'Probe?',
      body: 'A dialog above the inspector.',
      commitLabel: 'Probe',
      busyLabel: 'Probing…',
      run: () => Promise.resolve(),
      fallbackFocus: () => null,
    });
    await flush();
    const e = press(next(h), 'ArrowDown');
    await flush();
    expect(e.defaultPrevented).toBe(false);
    expect(shownId(h)).toBe('req-003');
  });

  it('the Overview card steps through its own recent requests, modal', async () => {
    const h = await mount({ wide: true, page: 'overview' });
    const recent = [
      ...h.host.querySelectorAll<HTMLButtonElement>('.rs-table-requests button.req-row'),
    ];
    await activate(recent[0]!);
    expectModal(h);
    next(h).click();
    await flush();
    expect(shownId(h)).toBe(recent[1]!.dataset['requestId']);
    h.store.select(recent.at(-1)!.dataset['requestId']!);
    await flush();
    expect(next(h).getAttribute('aria-disabled'), 'the card’s last row is a bound').toBe('true');
  });
});

/** Request listings as the wire delivers them: new objects on every read. The plain fake hands
 * back its own row objects, and `<For>` keeps a row's node for the same object — so without
 * this a refresh would recreate nothing and focus would survive it for the wrong reason. */
class WireRows extends FakeApiClient {
  override requests(query: Parameters<FakeApiClient['requests']>[0]) {
    return super.requests(query).then((p) => ({ ...p, rows: p.rows.map((r) => ({ ...r })) }));
  }
}

describe('focus survives a list commit, by request id (task 4.4, design D9)', () => {
  /** Docked on row 0, rows read off the wire. */
  async function docked(): Promise<H> {
    const h = await mount({ wide: true, client: new WireRows() });
    await activate(rows(h)[0]!);
    expectDocked(h);
    return h;
  }

  it('a refresh: focus stays on the same request’s row, a new node', async () => {
    const h = await docked();
    const before = rowFor(h, 'req-003')!;
    before.focus();
    await h.store.refreshRequestsPage();
    await flush();
    const after = rowFor(h, 'req-003')!;
    expect(after, 'the refresh did not recreate the rows').not.toBe(before);
    expect(document.activeElement).toBe(after);
    expectFocusSomewhereReal('refresh');
  });

  it('newer rows arriving: focus follows the same request down the list', async () => {
    const h = await docked();
    const before = rowFor(h, 'req-003')!;
    before.focus();
    arrive(h.client, 2);
    await h.store.refreshRequestsPage();
    await flush();
    expect(rows(h)[5]?.dataset['requestId']).toBe('req-003');
    expect(rowFor(h, 'req-003')).not.toBe(before);
    expect(document.activeElement).toBe(rowFor(h, 'req-003'));
    expectFocusSomewhereReal('newer rows');
  });

  it('newer rows that push the focused row off page 1: focus lands on the Requests table panel', async () => {
    const h = await docked();
    rowFor(h, 'req-024')!.focus();
    arrive(h.client, 3);
    await h.store.refreshRequestsPage();
    await flush();
    expect(rowFor(h, 'req-024')).toBeUndefined();
    expect(document.activeElement).toBe(panelRegion(h, 'Requests'));
    expectFocusSomewhereReal('pushed off');
  });

  it('a filter change: the same id’s row while it is listed, the table panel once it is not', async () => {
    const h = await docked();
    const before = rowFor(h, 'req-001')!;
    before.focus(); // `header`: still listed under Explicit
    h.store.setFilter('explicit');
    await flush();
    expect(rowFor(h, 'req-001')).not.toBe(before);
    expect(document.activeElement).toBe(rowFor(h, 'req-001'));
    h.store.setFilter('auto'); // excludes it
    await flush();
    expect(rowFor(h, 'req-001')).toBeUndefined();
    expect(document.activeElement).toBe(panelRegion(h, 'Requests'));
    expectFocusSomewhereReal('filter');
  });

  it('focus on a control outside the list is never pulled back to a row', async () => {
    const h = await docked();
    rowFor(h, 'req-003')!.focus();
    const chip = filterChip(h, 'Auto');
    chip.focus();
    await h.store.refreshRequestsPage();
    await flush();
    expect(document.activeElement).toBe(chip);
    // Leaving the list forgot the row: a later blur to <body> and a commit bring nothing back.
    chip.blur();
    await h.store.refreshRequestsPage();
    await flush();
    expect(document.activeElement, 'a row the user had left took focus back').toBe(document.body);
  });

  it('a deliberate blur is not undone by a later commit', async () => {
    const h = await docked();
    const row = rowFor(h, 'req-003')!;
    row.focus();
    row.blur(); // a click on blank space
    await flush();
    expect(document.activeElement).toBe(document.body);
    await h.store.refreshRequestsPage();
    await flush();
    expect(document.activeElement, 'a commit took focus the user had put down').toBe(document.body);
  });
});

describe('step announcements (task 5.1, design D10)', { timeout: 20_000 }, () => {
  const observers: MutationObserver[] = [];
  // Real timers at the start of every case: a case that timed out under load can still be
  // running when the next starts, and must not leave the next one's `flush()` on fake timers.
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    for (const o of observers.splice(0)) o.disconnect();
    // Spies first: a `setTimeout` spy taken while the clock is fake restores the FAKE
    // function, so restoring it after `useRealTimers()` would leave a dead clock's timer on
    // `globalThis` for every later case.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** From here on the settle timer and the frame are the test's: `setTimeout` and
   * `requestAnimationFrame` (and their clears) are faked; microtasks stay real, so a fake
   * client's promises and a `MutationObserver` still deliver. Installed after mount and open,
   * which `flush()` waits on with real timers. */
  const fakeTimers = (): void => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
  };
  /** Let the settle interval elapse, then the frame the line is written on. */
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(STEP_ANNOUNCE_SETTLE_MS);
    vi.advanceTimersToNextFrame();
    await vi.advanceTimersByTimeAsync(0);
  };

  /** The step region: the inspector root's own `role="status"` child (D10). */
  const region = (h: H): HTMLElement | null =>
    drawer(h)?.querySelector<HTMLElement>(':scope > [role="status"]') ?? null;
  /** Every text the region takes, in order — what a live-region observer is handed. */
  function watch(el: HTMLElement): string[] {
    const log: string[] = [];
    const mo = new MutationObserver(() => log.push(el.textContent ?? ''));
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    observers.push(mo);
    return log;
  }
  const writes = (log: readonly string[]): string[] => log.filter((t) => t !== '');

  /** A cell's visible value in a rendered row, as the row renders it: the cell's text without
   * its stacked-form field label (and without the docked-only state marks). */
  function cellText(row: HTMLElement, label: string): string {
    const cell = [...row.querySelectorAll<HTMLElement>('.rs-cell')].find(
      (c) => c.querySelector('.rs-cell-label')?.textContent === label,
    );
    expect(cell, `the row has no ${label} cell`).toBeDefined();
    const copy = cell!.cloneNode(true) as HTMLElement;
    for (const x of copy.querySelectorAll('.rs-cell-label, .rs-docked-marks')) x.remove();
    return (copy.textContent ?? '').trim();
  }
  /** The line for request `id`, read off its rendered row's time, model, status and cost cells. */
  const rowLine = (h: H, id: string): string => {
    const row = rowFor(h, id)!;
    return ['Time', 'Model', 'Status', 'Cost'].map((l) => cellText(row, l)).join(' · ');
  };
  const loaded = (h: H, id: string): RequestRow =>
    h.store.state.requestList.find((r) => r.id === id)!;

  /** `req-005` priced `· est.` (the default fixture estimates no price), so the free figure
   * state carries both of its words; `req-006` is `unpriced`. */
  function estimatedClient(): FakeApiClient {
    const client = new FakeApiClient();
    client.requestRows = client.requestRows.map((r) =>
      r.id === 'req-005' ? { ...r, priceEstimated: true } : r,
    );
    return client;
  }

  it('is a polite, visually hidden status region and a direct child of the inspector root, empty on open, in every presentation — inside the dialog when modal', async () => {
    for (const p of PRESENTATIONS) {
      const h = await mount({ wide: p.wide, narrow: p.narrow });
      await activate(rows(h)[0]!);
      const d = drawer(h)!;
      const r = region(h);
      expect(r, `${p.name}: no status region on the inspector root`).not.toBeNull();
      expect(r!.parentElement).toBe(d);
      expect(r!.getAttribute('aria-live')).toBe('polite');
      expect(r!.classList.contains('sr-only')).toBe(true);
      expect(r!.textContent, `${p.name}: opening a row wrote to the region`).toBe('');
      expect(r!.closest('.drawer-head, .drawer-body'), 'inside the per-record part').toBeNull();
      expect(d.querySelectorAll('[role="status"]'), 'one step region').toHaveLength(1);
      if (p.wide) {
        expect(r!.closest('[role="complementary"]')).toBe(d);
      } else {
        expect(r!.closest('[aria-modal="true"]'), `${p.name}: outside the dialog`).toBe(d);
      }
      dispose?.();
      dispose = undefined;
      document.body.innerHTML = '';
      vi.unstubAllGlobals();
    }
  });

  for (const p of PRESENTATIONS) {
    it(`${p.name}: each step is announced once in one line — absolute time · model · status · cost, as the row renders them — and focus never moves`, async () => {
      const h = await mount({ wide: p.wide, narrow: p.narrow, client: estimatedClient() });
      await activate(rowFor(h, 'req-004')!);
      if (!p.wide) expect(region(h)!.closest('[aria-modal="true"]')).toBe(drawer(h));
      const r = region(h)!;
      const log = watch(r);
      fakeTimers();

      /** Step once by `how`, check nothing is written inside the interval, then the line. */
      const step = async (how: () => void, to: string, literal?: string): Promise<void> => {
        const before = log.length;
        how();
        const focused = document.activeElement;
        expect(shownId(h)).toBe(to);
        await vi.advanceTimersByTimeAsync(STEP_ANNOUNCE_SETTLE_MS - 1);
        expect(log.length, `${to}: written inside the settle interval`).toBe(before);
        await settle();
        expect(region(h), 'the region was replaced').toBe(r);
        expect(writes(log.slice(before)), `${to}: not announced exactly once`).toHaveLength(1);
        const line = r.textContent ?? '';
        expect(line, `${to}: the line is not the row's`).toBe(rowLine(h, to));
        if (literal !== undefined) expect(line).toBe(literal);
        // The cost part is the row's cost label, which is also the receipt's total.
        const row = loaded(h, to);
        expect(line.endsWith(` · ${rowCostLabel(row)}`)).toBe(true);
        expect(drawer(h)!.querySelector('[data-testid="inspector-total-cost"]')?.textContent).toBe(
          rowCostLabel(row),
        );
        expect(document.activeElement, `${to}: the announcement moved focus`).toBe(focused);
      };
      const time = (id: string): string =>
        fmtTime(Date.parse(h.client.requestRows.find((x) => x.id === id)!.createdAt));

      if (p.wide) {
        // From the list: the focused row's arrow keys.
        await step(
          () => press(rowFor(h, 'req-004')!, 'ArrowDown'),
          'req-005',
          `${time('req-005')} · Model 1 · OK · $0 free · est.`,
        );
        await step(
          () => press(rowFor(h, 'req-005')!, 'ArrowDown'),
          'req-006',
          `${time('req-006')} · Model 2 · Fallback · unpriced`,
        );
        await step(() => press(rowFor(h, 'req-006')!, 'ArrowUp'), 'req-005');
      } else {
        next(h).focus();
        await step(
          () => next(h).click(),
          'req-005',
          `${time('req-005')} · Model 1 · OK · $0 free · est.`,
        );
        await step(
          () => press(next(h), 'ArrowDown'),
          'req-006',
          `${time('req-006')} · Model 2 · Fallback · unpriced`,
        );
        await step(() => press(next(h), 'ArrowUp'), 'req-005');
      }
      // Previous / Next, in every presentation.
      prev(h).focus();
      await step(() => prev(h).click(), 'req-004');
      next(h).focus();
      await step(() => next(h).click(), 'req-005');
      await step(() => press(prev(h), 'ArrowUp'), 'req-004');
    });
  }

  it('is the same node across a step and a crossing either way, and modal after a downward crossing it is inside the dialog', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[0]!);
    expectDocked(h);
    const r = region(h)!;
    const log = watch(r);
    fakeTimers();
    press(rowFor(h, 'req-000')!, 'ArrowDown');
    await settle();
    expect(region(h)).toBe(r);
    expect(r.textContent).toBe(rowLine(h, 'req-001'));
    const written = log.length;

    h.media.dispatch(false);
    await vi.advanceTimersByTimeAsync(0);
    expectModal(h);
    expect(region(h), 'a downward crossing replaced the region').toBe(r);
    expect(r.closest('[aria-modal="true"]')).toBe(drawer(h));
    await settle();
    expect(log.length, 'a crossing wrote to the region').toBe(written);

    next(h).click();
    await settle();
    expect(r.textContent).toBe(rowLine(h, 'req-002'));

    h.media.dispatch(true);
    await vi.advanceTimersByTimeAsync(0);
    expectDocked(h);
    expect(region(h), 'an upward crossing replaced the region').toBe(r);
    expect(writes(log)).toEqual([rowLine(h, 'req-001'), rowLine(h, 'req-002')]);
  });

  it('two separate steps whose lines are identical are each announced: the region is cleared first', async () => {
    const client = new FakeApiClient();
    const twin = client.requestRows[1]!;
    // req-002 says exactly what req-001 says: the same second, model, status and cost.
    client.requestRows = client.requestRows.map((r) =>
      r.id === 'req-002' ? { ...twin, id: 'req-002' } : r,
    );
    const h = await mount({ wide: true, client });
    await activate(rows(h)[0]!);
    const r = region(h)!;
    const log = watch(r);
    fakeTimers();
    next(h).click();
    await settle();
    next(h).click();
    await settle();
    expect(shownId(h)).toBe('req-002');
    const line = rowLine(h, 'req-002');
    expect(rowLine(h, 'req-001'), 'the fixture lines differ').toBe(line);
    expect(writes(log), 'an identical line was announced once').toEqual([line, line]);
    // Cleared before each write, so the second write is a change a screen reader hears.
    expect(log).toEqual([line, '', line]);
  });

  for (const p of [PRESENTATIONS[0], PRESENTATIONS[1]] as const) {
    it(`${p.name}: five steps 30ms apart are written once, for the request where they stop`, async () => {
      const h = await mount({ wide: p.wide });
      await activate(rows(h)[0]!);
      const log = watch(region(h)!);
      fakeTimers();
      if (!p.wide) next(h).focus();
      for (let i = 0; i < 5; i += 1) {
        // A held key: the row stepped to holds focus when docked, Next keeps it when modal.
        press(p.wide ? document.activeElement! : next(h), 'ArrowDown');
        await vi.advanceTimersByTimeAsync(30);
      }
      expect(shownId(h)).toBe('req-005');
      expect(log, 'a step in the burst was written').toEqual([]);
      await settle();
      expect(writes(log)).toEqual([rowLine(h, 'req-005')]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(writes(log), 'written again later').toHaveLength(1);
    });
  }

  for (const p of [PRESENTATIONS[0], PRESENTATIONS[1]] as const) {
    it(`${p.name}: a step followed, inside its settle interval, by another way of choosing a request announces nothing`, async () => {
      const h = await mount({ wide: p.wide });
      await activate(rows(h)[0]!);
      const log = watch(region(h)!);
      fakeTimers();
      // The step to req-001 schedules the announcement ...
      if (p.wide) press(rowFor(h, 'req-000')!, 'ArrowDown');
      else next(h).click();
      expect(shownId(h)).toBe('req-001');
      await vi.advanceTimersByTimeAsync(100);
      // ... then a row ACTIVATION (a click docked; the store's `select` is the one path a
      // modal presentation has to it) chooses req-003: not a step, so never announced.
      if (p.wide) rowFor(h, 'req-003')!.click();
      else h.store.select('req-003');
      await vi.advanceTimersByTimeAsync(0);
      expect(shownId(h)).toBe('req-003');
      await settle();
      await vi.advanceTimersByTimeAsync(2000);
      expect(log, 'a selection that was not a step was announced').toEqual([]);
      // A later step is still announced, once, for the request it reaches.
      if (p.wide) press(rowFor(h, 'req-003')!, 'ArrowDown');
      else next(h).click();
      await settle();
      expect(writes(log)).toEqual([rowLine(h, 'req-004')]);
    });
  }

  it('opening, a refresh, a replaced record, live rows starting and settling and the "N new" count never write to it', async () => {
    const h = await mount({ wide: true, client: new WireRows() });
    fakeTimers();
    rows(h)[0]!.focus();
    rows(h)[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    expectDocked(h);
    const r = region(h)!;
    const log = watch(r);
    await settle();
    expect(log, 'opening a row wrote to the region').toEqual([]);

    const refresh = h.store.refreshRequestsPage();
    await vi.advanceTimersByTimeAsync(0);
    await refresh;
    expect(h.store.state.selRecord, 'the refresh did not replace the record').not.toBe(null);
    const live = {
      id: 'live-1',
      startedAt: Date.now(),
      decisionLayer: 'explicit',
      tierAssigned: 'default',
      modelLabel: 'model-live-1',
      providerLabel: 'ProvA',
      protocol: 'openai',
      status: 'running',
    } as const;
    h.store.setState('inflightRows', [{ ...live, phase: 'live' }]);
    await vi.advanceTimersByTimeAsync(0);
    h.store.setState('inflightRows', [{ ...live, phase: 'settling' }]);
    await vi.advanceTimersByTimeAsync(0);
    h.store.setState('inflightRows', []);
    h.store.setState({
      requestsPaged: true,
      requestsNew: { count: 3, atLeast: false, unknown: false },
    });
    await vi.advanceTimersByTimeAsync(0);
    h.store.setState('requestsNew', { count: 5, atLeast: true, unknown: false });
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(log, 'a background change was announced').toEqual([]);
    expect(region(h)).toBe(r);

    // A step, then a refresh inside its interval: one write, the step's, and nothing after.
    press(rowFor(h, 'req-000')!, 'ArrowDown');
    await vi.advanceTimersByTimeAsync(100);
    const again = h.store.refreshRequestsPage();
    await vi.advanceTimersByTimeAsync(0);
    await again;
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes(log)).toEqual([rowLine(h, 'req-001')]);
  });

  it('a pending announcement dies with the inspector: closing clears its timer, and a reopened inspector starts empty', async () => {
    const h = await mount({ wide: false });
    await activate(rows(h)[0]!);
    fakeTimers();
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    next(h).click();
    const at = set.mock.calls.findIndex(([, ms]) => ms === STEP_ANNOUNCE_SETTLE_MS);
    expect(at, 'a step scheduled no settle timer').toBeGreaterThanOrEqual(0);
    const timer = set.mock.results[at]!.value as unknown;
    escape();
    await vi.advanceTimersByTimeAsync(0);
    expect(drawer(h), 'Escape did not close the inspector').toBeNull();
    expect(clear, 'the close left the settle timer running').toHaveBeenCalledWith(timer);
    await settle();
    rows(h)[3]!.click();
    await vi.advanceTimersByTimeAsync(0);
    const log = watch(region(h)!);
    await settle();
    expect(region(h)!.textContent, 'a reopened inspector is not empty').toBe('');
    expect(log).toEqual([]);
  });

  it('an account change clears the pending announcement with the record', async () => {
    const h = await mount({ wide: true });
    await activate(rows(h)[0]!);
    fakeTimers();
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    next(h).click();
    const at = set.mock.calls.findIndex(([, ms]) => ms === STEP_ANNOUNCE_SETTLE_MS);
    const timer = set.mock.results[at]!.value as unknown;
    h.client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@x.test' };
    let booted = false;
    void h.store.bootstrap().then(() => {
      booted = true;
    });
    // Inside the settle interval: the account changes before the step would be written.
    for (let ms = 0; ms < STEP_ANNOUNCE_SETTLE_MS - 50 && !booted; ms += 5) {
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(booted, 'the account change did not complete inside the interval').toBe(true);
    expect(h.store.state.selRecord, 'the identity reset kept the record').toBeNull();
    expect(drawer(h)).toBeNull();
    expect(clear, 'the identity reset left the settle timer running').toHaveBeenCalledWith(timer);
  });
});

describe(
  'column priorities from one DOM, and the docked compact list (tasks 6.1, 6.2, design D11)',
  { timeout: 20_000 },
  () => {
    beforeEach(() => {
      vi.useRealTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A cell's own column class, as the head and every row carry it. */
    const colOf = (el: Element): string =>
      [...el.classList].find((c) => c.startsWith('rs-col-'))?.slice('rs-col-'.length) ?? '?';
    /** The row's layout, as its DOM holds it: the line-one cells, then the second line's two
     * groups. */
    function shape(row: Element): {
      line1: string[];
      sub: string[];
      p3: string[];
      p2: string[];
      rest: string[];
    } {
      const kids = [...row.children];
      const sub = row.querySelector(':scope > .rs-subline');
      return {
        line1: kids.filter((k) => k.classList.contains('rs-cell')).map(colOf),
        // P3 before P2: form two's line two, and the row's name, read in this order.
        sub: [...(sub?.children ?? [])].map((c) => c.className),
        p3: [...(sub?.querySelector(':scope > .rs-sub-p3')?.children ?? [])].map(colOf),
        p2: [...(sub?.querySelector(':scope > .rs-sub-p2')?.children ?? [])].map(colOf),
        rest: kids
          .filter((k) => !k.classList.contains('rs-cell') && !k.classList.contains('rs-subline'))
          .map((k) => k.className),
      };
    }
    const REQUEST_SHAPE = {
      line1: ['time', 'model', 'cost', 'status'],
      sub: ['rs-sub-p3', 'rs-sub-p2'],
      p3: ['provider', 'tier', 'decided'],
      p2: ['tokens', 'latency'],
      rest: [],
    };
    const value = (row: Element, col: string): HTMLElement =>
      row.querySelector<HTMLElement>(`.rs-col-${col} > :not(.rs-cell-label)`)!;

    it('every row of the request table — completed, live and batch job — holds P1 first, then one second-line wrapper (P3, then P2); the head stays flat in COLUMNS order', async () => {
      const h = await mount({ wide: true, client: new FakeApiClient({ batchJobs: [bandJob()] }) });
      h.store.setState('inflightRows', [{ ...LIVE, phase: 'live' }]);
      await h.store.loadBatchBand();
      await flush();
      const head = h.host.querySelector('.rs-table-requests .table-head')!;
      expect([...head.children].map(colOf)).toEqual([
        'time',
        'model',
        'provider',
        'tier',
        'decided',
        'tokens',
        'cost',
        'latency',
        'status',
      ]);
      expect([...head.children].map((c) => c.textContent)).toEqual([
        'Time',
        'Model',
        'Provider',
        'Tier',
        'Decided by',
        'Tokens',
        'Cost',
        'Latency',
        'Status',
      ]);
      const live = h.host.querySelector('.rs-table-requests div.req-row:not([data-batch-row])')!;
      const jobRow = h.host.querySelector('.rs-table-requests div.req-row[data-batch-row]')!;
      for (const [name, row] of [
        ['completed', rows(h)[0]!],
        ['live', live],
        ['batch job', jobRow],
      ] as const) {
        expect(row, `no ${name} row`).not.toBeNull();
        expect(shape(row), `${name} row`).toEqual(REQUEST_SHAPE);
        // Nine cells, nine aria-hidden labels, one per column — the head's count.
        expect(row.querySelectorAll('.rs-cell'), name).toHaveLength(9);
        // Phrasing content only: a completed row is a <button>.
        const block = [...row.querySelectorAll('*')].filter(
          (e) =>
            !['SPAN', 'svg', 'path', 'line', 'polyline', 'circle', 'rect', 'g'].includes(e.tagName),
        );
        expect(
          block.map((e) => e.tagName),
          `${name}: non-phrasing content`,
        ).toEqual([]);
      }
    });

    it('the status cell carries the escalated mark and the batch chip in .rs-docked-marks, rendered by the same components as the Decided-by cell', async () => {
      const client = new FakeApiClient();
      // req-004 is a cascade escalation; make it a settled batch item too, the widest status
      // cell the docked list can show. req-002 stays a plain row.
      client.requestRows = client.requestRows.map((r) =>
        r.id === 'req-004' ? { ...r, batchId: 'bj-x', priceMode: 'batch' as const } : r,
      );
      const h = await mount({ wide: true, client });
      const marked = rowFor(h, 'req-004')!;
      const status = marked.querySelector('.rs-col-status')!;
      const marks = status.querySelector('.rs-docked-marks');
      expect(marks, 'no docked marks in the status cell').not.toBeNull();
      expect(marks!.closest('.rs-cell-label'), 'inside the field label').toBeNull();
      expect(marks!.classList.contains('rs-cell'), 'the marks are a cell').toBe(false);
      // After the status word.
      expect((status.textContent ?? '').indexOf('OK')).toBeLessThan(
        (status.textContent ?? '').indexOf('escalated'),
      );
      const decided = marked.querySelector('.rs-col-decided')!;
      const escalated = (root: Element): string =>
        [...root.querySelectorAll('.sr-only')]
          .filter((e) => e.textContent === 'escalated')
          .map((e) => `${e.previousElementSibling?.outerHTML ?? ''}${e.outerHTML}`)
          .join('');
      expect(escalated(marks!), 'the escalated mark').not.toBe('');
      expect(escalated(marks!), 'not the Decided-by component').toBe(escalated(decided));
      const chip = (root: Element): string =>
        [...root.querySelectorAll('.chip')].find((c) => c.textContent?.trim() === 'batch')
          ?.outerHTML ?? '';
      expect(chip(marks!), 'the batch chip').not.toBe('');
      expect(chip(marks!), 'not the Decided-by component').toBe(chip(decided));
      // A row with neither mark has no docked copy.
      expect(rowFor(h, 'req-002')!.querySelector('.rs-docked-marks')).toBeNull();
    });

    it('the Requests panel is the docked compact list exactly while the inspector is docked beside it', async () => {
      const h = await mount({ wide: true });
      const panel = panelRegion(h, 'Requests')!;
      expect(panel.classList.contains('rs-docked-list'), 'compact before anything opens').toBe(
        false,
      );
      await activate(rows(h)[0]!);
      expectDocked(h);
      expect(panel.classList.contains('rs-docked-list'), 'not compact while docked').toBe(true);
      // Closing returns the width-selected form: the class goes, the list is not reloaded.
      const reads = h.client.countOf('requests');
      closeControl(h).click();
      await flush();
      expect(panel.classList.contains('rs-docked-list'), 'still compact after close').toBe(false);
      expect(h.client.countOf('requests'), 'closing reloaded the list').toBe(reads);
      // Crossing below the threshold while open: modal, so the list is not compact.
      await activate(rows(h)[1]!);
      expect(panel.classList.contains('rs-docked-list')).toBe(true);
      h.media.dispatch(false);
      await flush();
      expectModal(h);
      expect(panel.classList.contains('rs-docked-list'), 'compact beside a modal drawer').toBe(
        false,
      );
    });

    it('the Overview card and the modal presentations never take the compact list', async () => {
      const o = await mount({ wide: true, page: 'overview' });
      o.host.querySelector<HTMLButtonElement>('.rs-table-requests button.req-row')!.click();
      await flush();
      expect(o.host.querySelector('.rs-docked-list')).toBeNull();
      dispose?.();
      dispose = undefined;
      document.body.innerHTML = '';
      vi.unstubAllGlobals();
      const m = await mount({ wide: false });
      await activate(rows(m)[0]!);
      expectModal(m);
      expect(m.host.querySelector('.rs-docked-list')).toBeNull();
    });

    it('a running row in the docked list keeps provider, tier, decided-by, tokens and a ticking latency on its second line, and stays a non-interactive div', async () => {
      const h = await mount({ wide: true });
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: LIVE.startedAt });
      h.store.setState('inflightRows', [{ ...LIVE, phase: 'live' }]);
      await vi.advanceTimersByTimeAsync(0);
      rows(h)[0]!.click();
      await vi.advanceTimersByTimeAsync(0);
      expectDocked(h);
      const live = h.host.querySelector<HTMLElement>(
        '.rs-table-requests div.req-row:not([data-batch-row])',
      )!;
      expect(shape(live)).toEqual(REQUEST_SHAPE);
      const sub = live.querySelector('.rs-subline')!;
      expect(value(sub, 'provider').textContent).toBe('ProvLive');
      expect(value(sub, 'tier').textContent).toBe('tier-live');
      expect(value(sub, 'decided').textContent?.trim()).toBe('explicit');
      expect(value(sub, 'tokens').textContent?.trim()).toBe('—');
      const before = value(sub, 'latency').textContent;
      await vi.advanceTimersByTimeAsync(3000);
      expect(value(sub, 'latency').textContent, 'the live latency stopped ticking').not.toBe(
        before,
      );
      // Non-interactive, with no added role or tab stop.
      expect(live.tagName).toBe('DIV');
      expect(live.getAttribute('role')).toBeNull();
      expect(live.getAttribute('tabindex')).toBeNull();
      expect(live.querySelector('button, [tabindex], a, input, select')).toBeNull();
      // Line one still names time, model, cost and status.
      expect(value(live, 'model').textContent).toBe('model-live-1');
      expect(value(live, 'status').textContent).toContain('Running');
    });

    it('a batch-job row in the docked list renders every one of its fields', async () => {
      const h = await mount({ wide: true, client: new FakeApiClient({ batchJobs: [bandJob()] }) });
      await h.store.loadBatchBand();
      await flush();
      await activate(rows(h)[0]!);
      expectDocked(h);
      const jobRow = h.host.querySelector<HTMLElement>('.rs-table-requests div[data-batch-row]')!;
      expect(shape(jobRow)).toEqual(REQUEST_SHAPE);
      expect(value(jobRow, 'model').textContent).toBe('model-band');
      expect(value(jobRow, 'cost').textContent?.trim()).toBe('—');
      expect(value(jobRow, 'status').textContent).toContain('12 of 50');
      const sub = jobRow.querySelector('.rs-subline')!;
      expect(value(sub, 'provider').textContent).toBe('prov-band');
      expect(value(sub, 'tier').textContent).toBe('nightly');
      expect(value(sub, 'decided').textContent?.trim()).toBe('batch');
      expect(value(sub, 'tokens').textContent?.trim()).toBe('—');
      expect(value(sub, 'latency').textContent).toMatch(/^3h 0?5m/);
      expect(jobRow.querySelector('button, [tabindex]')).toBeNull();
    });

    it('the group boundaries still precede the first row and every change of agent in the docked list', async () => {
      const h = await mount({ wide: true });
      await activate(rows(h)[0]!);
      expectDocked(h);
      const list = h.store.state.requestList;
      const all = rows(h);
      for (const [i, row] of all.entries()) {
        const before = row.previousElementSibling;
        const starts = i === 0 || list[i]!.agentId !== list[i - 1]!.agentId;
        expect(
          before?.classList.contains('rs-agent-boundary') ?? false,
          `${row.dataset['requestId'] ?? '?'}: boundary`,
        ).toBe(starts);
      }
    });

    it('hidden fields reach the inspector: activating the row, ArrowDown and Next to it each show its provider, tier, decided-by, tokens and latency', async () => {
      // A served row whose provider label, tier, decision layer, token counts and latency no
      // other fixture row shares, so finding each in the inspector proves it came from THIS row.
      const client = new FakeApiClient();
      client.requestRows = client.requestRows.map((r) =>
        r.id === 'req-001'
          ? {
              ...r,
              status: 'success' as const,
              providerLabel: 'Provider Solo',
              tierAssigned: 'tier-solo',
              decisionLayer: 'semantic',
              inputTokens: 4321,
              outputTokens: 987,
              durationMs: 6543,
            }
          : r,
      );
      const solo = client.requestRows.find((r) => r.id === 'req-001')!;
      const others = client.requestRows.filter((r) => r.id !== 'req-001');
      expect(others.some((r) => r.providerLabel === solo.providerLabel)).toBe(false);
      expect(others.some((r) => r.tierAssigned === solo.tierAssigned)).toBe(false);
      expect(others.some((r) => r.decisionLayer === solo.decisionLayer)).toBe(false);
      expect(others.some((r) => r.inputTokens === solo.inputTokens)).toBe(false);
      expect(others.some((r) => r.outputTokens === solo.outputTokens)).toBe(false);
      expect(others.some((r) => r.durationMs === solo.durationMs)).toBe(false);

      const h = await mount({ wide: true, client });
      const view = toInspectorView(solo);
      const outcome = view.trace.find((n) => n.kind === 'outcome');
      expect(outcome?.kind === 'outcome' ? outcome.provider : null).toBe('Provider Solo');
      const expectReachable = (how: string): void => {
        expectDocked(h);
        expect(shownId(h), how).toBe('req-001');
        const d = drawer(h)!;
        const node = d.querySelector('li.rt-node[data-kind="outcome"] .rt-text')!;
        if (outcome?.kind !== 'outcome') throw new Error('no outcome node');
        expect(node.textContent, `${how}: the provider`).toContain(outcome.provider!);
        expect(d.querySelector('[data-testid="rt-latency"]')?.textContent, `${how}: latency`).toBe(
          outcome.latency,
        );
        expect(d.querySelector('[data-testid="inspector-tier"]')?.textContent, how).toBe(view.tier);
        const decision = d.querySelector('[data-testid="inspector-decision"]')!;
        expect(decision.textContent, `${how}: the decision layer`).toContain(view.decisionLayer);
        for (const [testid, label] of [
          ['inspector-input-tokens', 'input'],
          ['inspector-output-tokens', 'output'],
        ] as const) {
          const want = view.tokenRows.find((t) => t.label === label)?.countParts;
          expect(
            d.querySelector(`[data-testid="${testid}"]`)?.textContent,
            `${how}: ${label}`,
          ).toBe((want ?? []).map((p) => p.text).join(' '));
        }
      };
      await activate(rowFor(h, 'req-001')!);
      expectReachable('activation');
      closeControl(h).click();
      await flush();
      await activate(rowFor(h, 'req-000')!);
      press(rowFor(h, 'req-000')!, 'ArrowDown');
      await flush();
      expectReachable('ArrowDown');
      press(rowFor(h, 'req-001')!, 'ArrowUp');
      await flush();
      expect(shownId(h)).toBe('req-000');
      next(h).click();
      await flush();
      expectReachable('Next');
    });

    it('an unlit row whose provider the trace cannot confirm still shows it: the Decision section records it (flag F3)', async () => {
      // An exhausted chain whose terminal member is on another provider: the trace outcome
      // names no provider (flag RF-1), and the docked list hides the table's Provider cell, so
      // the inspector's `recorded provider` row is the only place the field survives.
      const client = new FakeApiClient();
      client.requestRows = client.requestRows.map((r) =>
        r.id === 'req-001'
          ? {
              ...r,
              status: 'error' as const,
              providerId: 'prov-solo',
              providerLabel: 'Provider Unconfirmed',
              attemptFailures: [
                {
                  index: 0,
                  providerId: 'prov-solo',
                  model: 'a',
                  kind: 'rate_limit' as const,
                  dispatched: true,
                },
                {
                  index: 1,
                  providerId: 'prov-other',
                  model: 'b',
                  kind: 'unavailable' as const,
                  dispatched: true,
                  terminal: true,
                },
              ],
            }
          : r,
      );
      const solo = client.requestRows.find((r) => r.id === 'req-001')!;
      const h = await mount({ wide: true, client });
      const view = toInspectorView(solo);
      const outcome = view.trace.find((n) => n.kind === 'outcome');
      expect(outcome?.kind === 'outcome' ? outcome.provider : 'missing').toBeNull();
      expect(view.recordedProvider).toBe('Provider Unconfirmed');
      const expectRecorded = (how: string): void => {
        expectDocked(h);
        expect(shownId(h), how).toBe('req-001');
        const d = drawer(h)!;
        expect(d.querySelector('[data-testid="inspector-provider"]')?.textContent, how).toBe(
          'Provider Unconfirmed',
        );
        expect(d.querySelector('ol.rt')?.textContent, `${how}: not in the trace`).not.toContain(
          'Provider Unconfirmed',
        );
      };
      await activate(rowFor(h, 'req-001')!);
      expectRecorded('activation');
      closeControl(h).click();
      await flush();
      await activate(rowFor(h, 'req-000')!);
      press(rowFor(h, 'req-000')!, 'ArrowDown');
      await flush();
      expectRecorded('ArrowDown');
    });
  },
);
