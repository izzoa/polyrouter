/** App-shell scroll containment.
 *
 * The sidebar shipped at `overflow: visible` inside a viewport-height shell. Its ~520px of
 * content enlarged the SHELL's scrollable-overflow area on any shorter viewport, and left
 * the lower nav and the account menu unreachable.
 *
 * WHAT THESE TESTS ARE. `happy-dom` performs no layout — `scrollHeight`/`clientHeight` are
 * meaningless here — so these assert the shipped DECLARATIONS on the rendered DOM. They are
 * a regression guard against the declarations being dropped, NOT proof of scroll behaviour;
 * that needs a real browser at a short viewport (the change's task 4.5).
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

async function mountShell(): Promise<{ host: HTMLElement; dispose: () => void }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <AppProvider store={createAppStore(new FakeApiClient())}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  return {
    host,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

/** Found by an explicit marker, not by guessing at style values. */
function shellOf(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('[data-shell="true"]');
  if (!el) throw new Error('app shell not found (missing data-shell)');
  return el;
}
const paneOf = (host: HTMLElement, name: string): HTMLElement | null =>
  shellOf(host).querySelector<HTMLElement>(`:scope > [data-pane="${name}"]`);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('app shell scroll containment', () => {
  it('sizes the shell to the visible viewport and makes it unscrollable', async () => {
    const h = await mountShell();
    try {
      const style = shellOf(h.host).getAttribute('style') ?? '';
      // `dvh` tracks the retracting mobile URL bar; the `vh` declaration before it is the
      // fallback for engines that cannot parse `dvh`.
      expect(style).toContain('height:100vh');
      expect(style).toContain('height:100dvh');
      // `clip` after `hidden`: `hidden` still leaves the shell a scroll CONTAINER that
      // focus/scrollIntoView/anchoring can translate, which moves every pane at once.
      // `clip` creates no scroll container at all. The `hidden` before it is the fallback.
      expect(style).toContain('overflow:hidden');
      expect(style).toContain('overflow:clip');
    } finally {
      h.dispose();
    }
  });

  it('gives the sidebar its own scrolling, contained on the vertical axis only', async () => {
    const h = await mountShell();
    try {
      const sidebar = paneOf(h.host, 'sidebar');
      expect(sidebar?.style.width).toBe('208px'); // sanity: this really is the sidebar
      expect(sidebar?.style.overflowY).toBe('auto');
      expect(['0', '0px']).toContain(sidebar?.style.minHeight);
      // Y only — the shorthand would also suppress horizontal swipe-back navigation.
      expect(sidebar?.getAttribute('style')).toContain('overscroll-behavior-y:contain');
      expect(sidebar?.getAttribute('style')).not.toMatch(/[^-]overscroll-behavior:/);
    } finally {
      h.dispose();
    }
  });

  it('keeps main scrollable without chaining out, contained on the vertical axis only', async () => {
    const h = await mountShell();
    try {
      const main = h.host.querySelector<HTMLElement>('main');
      expect(main?.style.overflowY).toBe('auto');
      expect(['0', '0px']).toContain(main?.style.minHeight);
      expect(main?.getAttribute('style')).toContain('overscroll-behavior-y:contain');
      expect(main?.getAttribute('style')).not.toMatch(/[^-]overscroll-behavior:/);
    } finally {
      h.dispose();
    }
  });

  it('forces every in-flow shell child to declare itself a pane', async () => {
    const h = await mountShell();
    try {
      const shell = shellOf(h.host);
      // Out-of-flow overlays (inspector drawer, modals, toast) are position:fixed and
      // cannot enlarge the shell's scrollable overflow, so they are exempt.
      const inFlow = [...shell.children].filter((c): c is HTMLElement => {
        const pos = (c as HTMLElement).style.position;
        return pos !== 'fixed' && pos !== 'absolute';
      });
      expect(inFlow.length).toBeGreaterThan(0);
      for (const pane of inFlow) {
        // Deliberately a MARKER check, not a style sniff: this cannot prove an arbitrary
        // pane contains its overflow, so it instead forces a conscious decision — a new
        // in-flow child fails here until someone marks it and adds its contract below.
        expect(
          pane.dataset['pane'],
          `unmarked in-flow shell child: ${pane.outerHTML.slice(0, 120)}`,
        ).toBeTruthy();
      }
      expect(new Set(inFlow.map((p) => p.dataset['pane']))).toEqual(
        new Set(['sidebar', 'content']),
      );
    } finally {
      h.dispose();
    }
  });

  it('has the content pane delegate scrolling to a main it owns', async () => {
    const h = await mountShell();
    try {
      const content = paneOf(h.host, 'content');
      // The content pane does not scroll itself; it holds a fixed-height topbar plus a
      // flex:1/min-height:0 <main> that absorbs the remaining height, so it never spills.
      expect(content?.style.overflowY).toBe('');
      const main = content?.querySelector('main');
      expect(main).not.toBeNull();
      expect((main as HTMLElement | null)?.style.overflowY).toBe('auto');
    } finally {
      h.dispose();
    }
  });
});
