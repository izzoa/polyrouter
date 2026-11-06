/**
 * The theme follows the operating system until the user chooses (dashboard-core "The theme
 * follows the operating system until the user chooses"; adopt-design-tokens-v2 task 11.2,
 * design.md D9).
 *
 * Two halves, run in the order a browser runs them:
 * - `index.html`'s pre-paint script, the REAL one read out of the file, runs before the app
 *   and sets `data-theme` from the stored choice or, with none, from the system preference;
 * - the store starts from that attribute, and `App` keeps following the preference until the
 *   user toggles.
 *
 * `matchMedia` is a mock that records its `change` listeners per query and can dispatch a
 * change. Only the color-scheme query is counted: the sidebar listens to the `narrow` query
 * too, and that listener is not the theme's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createAppStore, DARK_SCHEME_QUERY, THEME_KEY, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const HTML = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const HEAD = HTML.slice(0, HTML.indexOf('</head>'));
const PREPAINT = /<script data-prepaint-theme>([\s\S]*?)<\/script>/.exec(HTML)?.[1] ?? '';

/** The pre-paint script exactly as `index.html` ships it, run in the test's global (where
 * `window`, `document`, `localStorage` and `matchMedia` are the happy-dom ones). */
function runPrePaint(): void {
  runInThisContext(PREPAINT, { filename: 'index.html <script data-prepaint-theme>' });
}

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
  /** The system preference changes: `matches` first, then every listener, as a browser does. */
  dispatch(matches: boolean): void {
    this.matches = matches;
    for (const fn of [...this.listeners]) fn({ matches, media: this.media });
  }
}

/** Stub `matchMedia`; returns the color-scheme query's mock. Every other query gets its own
 * inert mock, so the sidebar's `narrow` listener never counts as the theme's. */
function stubMedia(dark: boolean): MediaMock {
  const scheme = new MediaMock(DARK_SCHEME_QUERY, dark);
  const others = new Map<string, MediaMock>();
  vi.stubGlobal('matchMedia', (q: string): MediaMock => {
    if (q === DARK_SCHEME_QUERY) return scheme;
    const m = others.get(q) ?? new MediaMock(q, false);
    others.set(q, m);
    return m;
  });
  return scheme;
}

/** A storage whose every read and write throws, as a blocked or sandboxed one does. */
function stubThrowingStorage(): void {
  const deny = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.stubGlobal('localStorage', {
    getItem: deny,
    setItem: deny,
    removeItem: deny,
    clear: deny,
    key: deny,
    get length(): number {
      return deny();
    },
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Boot as the browser does: the pre-paint script, then the store, then the app. */
async function boot(): Promise<{
  host: HTMLElement;
  store: AppStore;
  /** `state.theme` as the store was created, before the app mounted. */
  initial: string;
  dispose: () => void;
}> {
  runPrePaint();
  const store = createAppStore(new FakeApiClient());
  const initial = store.state.theme;
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
  return { host, store, initial, dispose: () => (dispose(), host.remove()) };
}

const attr = (): string | null => document.documentElement.getAttribute('data-theme');

/** The theme toggle, through the account menu as a user reaches it. */
async function toggle(host: HTMLElement): Promise<void> {
  host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
  await flush();
  const item = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) =>
    /^Switch to (dark|light)$/.test(e.textContent?.trim() ?? ''),
  );
  if (!item) throw new Error('no theme item in the account menu');
  item.click();
  await flush();
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
});

describe('the pre-paint script (index.html)', () => {
  it('is a classic script in <head>, ahead of the app, reading the key the toggle writes', () => {
    expect(PREPAINT.length, 'index.html carries <script data-prepaint-theme>').toBeGreaterThan(0);
    const tag = /<script data-prepaint-theme[^>]*>/.exec(HEAD)?.[0];
    expect(tag, 'the script sits in <head>, so it runs before the body paints').toBeDefined();
    expect(tag).not.toMatch(/type=|async|defer|src=/);
    expect(PREPAINT).toContain(`'${THEME_KEY}'`);
    expect(PREPAINT).toContain(`'${DARK_SCHEME_QUERY}'`);
  });

  it('resolves light when the runtime has no usable matchMedia', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('unsupported');
    });
    runPrePaint();
    expect(attr()).toBe('light');
  });
});

describe('the theme follows the operating system until the user chooses (D9)', () => {
  it('a dark preference with empty storage boots dark, before the app and inside it', async () => {
    stubMedia(true);
    runPrePaint();
    expect(attr(), 'the first frame is already dark').toBe('dark');
    const h = await boot();
    try {
      // The store starts from the attribute the script set, so the first render agrees with
      // the first frame — it does not start light and correct itself after mount.
      expect(h.initial).toBe('dark');
      expect(attr()).toBe('dark');
      expect(h.store.state.theme).toBe('dark');
    } finally {
      h.dispose();
    }
  });

  it('a stored light wins over a dark preference, and registers no listener', async () => {
    localStorage.setItem(THEME_KEY, 'light');
    const mq = stubMedia(true);
    const h = await boot();
    try {
      expect(attr()).toBe('light');
      expect(h.store.state.theme).toBe('light');
      expect(mq.listeners.size, 'a stored choice is not following anything').toBe(0);
      mq.dispatch(true);
      await flush();
      expect(attr(), 'a change to dark moves nothing').toBe('light');
      expect(h.store.state.theme).toBe('light');
    } finally {
      h.dispose();
    }
  });

  it('a throwing localStorage still boots, in the preferred theme', async () => {
    stubThrowingStorage();
    stubMedia(true);
    const h = await boot();
    try {
      expect(h.host.querySelector('[data-shell]'), 'the dashboard started').not.toBeNull();
      expect(attr()).toBe('dark');
      expect(h.store.state.theme).toBe('dark');
    } finally {
      h.dispose();
    }
  });

  it('the toggle still persists the choice', async () => {
    stubMedia(true);
    const h = await boot();
    try {
      await toggle(h.host);
      expect(attr()).toBe('light');
      expect(h.store.state.theme).toBe('light');
      expect(localStorage.getItem(THEME_KEY)).toBe('light');
    } finally {
      h.dispose();
    }
  });

  it('with no stored choice, each change of the preference flips the theme, until a toggle', async () => {
    const mq = stubMedia(true);
    const h = await boot();
    try {
      expect(attr()).toBe('dark');
      expect(mq.listeners.size, 'following the preference').toBe(1);

      mq.dispatch(false);
      await flush();
      expect(attr()).toBe('light');
      expect(h.store.state.theme).toBe('light');

      mq.dispatch(true);
      await flush();
      expect(attr()).toBe('dark');
      expect(h.store.state.theme).toBe('dark');

      await toggle(h.host); // dark → light, by hand
      expect(attr()).toBe('light');
      expect(mq.listeners.size, 'a manual choice stops the following').toBe(0);
      mq.dispatch(true);
      await flush();
      expect(attr(), 'after a manual toggle a further change moves nothing').toBe('light');
      expect(h.store.state.theme).toBe('light');
    } finally {
      h.dispose();
    }
  });

  it('with a throwing localStorage it follows each change until the toggle, and then the in-session choice holds', async () => {
    stubThrowingStorage();
    const mq = stubMedia(false);
    const h = await boot();
    try {
      expect(attr()).toBe('light');
      mq.dispatch(true);
      await flush();
      expect(attr()).toBe('dark');
      mq.dispatch(false);
      await flush();
      expect(attr()).toBe('light');

      await toggle(h.host); // light → dark; the write throws and is swallowed
      expect(attr()).toBe('dark');
      expect(h.store.state.theme).toBe('dark');
      expect(mq.listeners.size).toBe(0);
      mq.dispatch(false);
      await flush();
      expect(attr(), 'the in-session choice holds').toBe('dark');
      expect(h.store.state.theme).toBe('dark');
    } finally {
      h.dispose();
    }
  });

  it('unmounting the app stops the following', async () => {
    const mq = stubMedia(false);
    const h = await boot();
    expect(mq.listeners.size).toBe(1);
    h.dispose();
    expect(mq.listeners.size).toBe(0);
  });
});
