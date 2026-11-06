/**
 * The type scale follows the user's font-size setting (dashboard-core "Dashboard text uses
 * five locked sizes", scenario "Text follows the user's font-size setting";
 * adopt-design-tokens-v2 tasks 2.2 and 2.3, design.md D5).
 *
 * The real `styles.css` is loaded into the document and the root font size is set to 20px,
 * as a browser does when its user raises the default from 16px. Every role is authored in
 * rem, so every computed size and line height scales by 20 / 16 = 1.25: Body 13 / 20px
 * renders at 16.25 / 25px and a Caption 11 / 16px at 13.75 / 20px. A role reverted to px
 * keeps its 16px-root value, which fails here.
 *
 * happy-dom resolves rem against the root's font size in `getComputedStyle` (it does no
 * layout, but sizes and line heights are computed values, not layout).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

/** Each role at the default 16px root: [class, size px, line height px, weight]. */
const ROLES: readonly (readonly [string, number, number, string])[] = [
  ['t-display', 26, 32, '600'],
  ['t-title', 15, 20, '600'],
  ['t-section', 13, 20, '600'],
  ['t-body', 13, 20, '400'],
  ['t-dense', 12, 16, '400'],
  ['t-label', 12, 16, '500'],
  ['t-caption', 11, 16, '400'],
  ['t-overline', 11, 16, '500'],
];

let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
});

afterEach(() => {
  sheet.remove();
  document.documentElement.style.fontSize = '';
  document.body.innerHTML = '';
});

function probe(cls: string): CSSStyleDeclaration {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = 'Text';
  document.body.appendChild(el);
  return getComputedStyle(el);
}

describe('text scales with the root font size (D5: sizes in rem)', () => {
  it('renders Body at 16.25 / 25px and a Caption at 13.75 / 20px under a 20px root', () => {
    document.documentElement.style.fontSize = '20px';
    const body = getComputedStyle(document.body);
    expect(body.fontSize, 'body text size').toBe('16.25px');
    expect(body.lineHeight, 'body text line height').toBe('25px');
    const caption = probe('t-caption');
    expect(caption.fontSize, 'caption size').toBe('13.75px');
    expect(caption.lineHeight, 'caption line height').toBe('20px');
  });

  it('scales every role by the same 1.25 factor, so none is fixed in px', () => {
    document.documentElement.style.fontSize = '20px';
    for (const [cls, size, lh, weight] of ROLES) {
      const s = probe(cls);
      expect(s.fontSize, `.${cls} size`).toBe(`${size * 1.25}px`);
      expect(s.lineHeight, `.${cls} line height`).toBe(`${lh * 1.25}px`);
      expect(s.fontWeight, `.${cls} weight`).toBe(weight);
    }
  });

  it('renders each role at its locked size on the default 16px root', () => {
    for (const [cls, size, lh] of ROLES) {
      const s = probe(cls);
      expect(s.fontSize, `.${cls} size`).toBe(`${size}px`);
      expect(s.lineHeight, `.${cls} line height`).toBe(`${lh}px`);
    }
    expect(getComputedStyle(document.body).fontSize, 'body text size').toBe('13px');
  });

  it('sets a role in Mono when paired with .mono, keeping the role size (role classes precede .mono)', () => {
    const s = probe('t-dense mono');
    expect(s.fontFamily).toMatch(/^['"]?Geist Mono/);
    expect(s.fontSize).toBe('12px');
    expect(s.lineHeight).toBe('16px');
  });
});

describe("the top bar's page title is the Title role (task 2.2)", () => {
  it('carries .t-title and renders 15px on a 20px line (18.75 / 25px under a 20px root)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = createAppStore(new FakeApiClient());
    const dispose = render(
      () => (
        <AppProvider store={store}>
          <App live={false} />
        </AppProvider>
      ),
      host,
    );
    try {
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
      const title = host.querySelector<HTMLElement>('[data-testid="page-title"]');
      expect(title, 'the top bar renders its page title').not.toBeNull();
      expect(title!.textContent?.trim()).toBe('Overview');
      expect(title!.classList.contains('t-title'), 'the page title takes .t-title').toBe(true);
      expect(title!.getAttribute('style') ?? '', 'no inline font overrides the role').not.toMatch(
        /font/,
      );
      expect(getComputedStyle(title!).fontSize).toBe('15px');
      expect(getComputedStyle(title!).lineHeight).toBe('20px');
      document.documentElement.style.fontSize = '20px';
      expect(getComputedStyle(title!).fontSize).toBe('18.75px');
      expect(getComputedStyle(title!).lineHeight).toBe('25px');
    } finally {
      dispose();
    }
  });
});
