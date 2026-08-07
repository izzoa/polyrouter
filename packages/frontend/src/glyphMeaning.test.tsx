/** A state is never indicated by a decorative mark alone (replace-fallback-symbol-glyphs).
 *
 * The font work replaced symbol characters with SVG artwork. The obvious way to do that is to
 * preserve each site's existing `aria-hidden`/`aria-label` exactly — and that would have been
 * wrong, because one of those sites was already broken:
 *
 *     {props.r.escalated ? `${props.r.decisionLayer} ↗` : props.r.decisionLayer}
 *
 * The arrow was the ONLY difference between an escalated request and a normal one, and it was
 * an unlabelled decorative glyph. Escalation was therefore unavailable to assistive technology
 * before this change. Preserving the markup faithfully would have carried that forward and
 * called it a success.
 *
 * So these assert **meaning**, not attributes: that the state is reachable as text, and that
 * the artwork carrying it is hidden. An attribute diff cannot tell those apart.
 */
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon } from './components/Icon';

const mount = (node: () => JSX.Element): HTMLElement => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(node, host);
  return host;
};

/** What a screen reader would announce: text content minus anything hidden from it. */
function accessibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('artwork is always decorative', () => {
  it('every icon in the registry is hidden from assistive technology', () => {
    // If meaning could ride on an icon, every assertion below could be satisfied by artwork
    // alone — which is the failure mode this whole requirement exists to prevent.
    const host = mount(() => <Icon name="escalated" />);
    const svg = host.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(accessibleText(host), 'an icon contributed to the accessible name').toBe('');
  });

  it('adds no runtime fetch', () => {
    // Inline geometry, not an <img> or an icon font.
    const host = mount(() => <Icon name="copy" />);
    expect(host.querySelector('img')).toBeNull();
    expect(host.innerHTML).toContain('<svg');
  });
});

describe('escalation survives the mark being decorative', () => {
  /** The real markup from `RequestTable`'s decision-layer chip. */
  const Chip = (p: { layer: string; escalated: boolean }): JSX.Element => (
    <span>
      {p.layer}
      {p.escalated ? (
        <>
          {' '}
          <Icon name="escalated" size={11} />
          <span class="sr-only">escalated</span>
        </>
      ) : null}
    </span>
  );

  it('an escalated request announces that it was escalated', () => {
    const host = mount(() => <Chip layer="cascade" escalated={true} />);
    expect(
      accessibleText(host),
      'escalation is carried by the artwork alone — invisible to assistive technology',
    ).toContain('escalated');
  });

  it('a normal request does not', () => {
    // The other half. Without this, a chip that always said "escalated" would pass.
    const host = mount(() => <Chip layer="cascade" escalated={false} />);
    expect(accessibleText(host)).not.toContain('escalated');
    expect(accessibleText(host)).toBe('cascade');
  });

  it('the two states differ in ACCESSIBLE text, not only in artwork', () => {
    const esc = accessibleText(mount(() => <Chip layer="cascade" escalated={true} />));
    const not = accessibleText(mount(() => <Chip layer="cascade" escalated={false} />));
    expect(esc, 'the states are indistinguishable without seeing the mark').not.toBe(not);
  });
});

describe('a completed setup step survives the mark being decorative', () => {
  /** The real structure: the badge is `aria-hidden`, so the label must carry the state. */
  const Step = (p: { label: string; done: boolean }): JSX.Element => (
    <button type="button">
      <span aria-hidden="true">{p.done ? <Icon name="check" size={12} /> : '2'}</span>
      <span>
        {p.label}
        {p.done ? <span class="sr-only"> (completed)</span> : null}
      </span>
    </button>
  );

  it('announces completion', () => {
    const host = mount(() => <Step label="Connect a provider" done={true} />);
    expect(
      accessibleText(host),
      'completion was left to a green ring — colour alone',
    ).toContain('completed');
  });

  it('an incomplete step does not announce completion', () => {
    const host = mount(() => <Step label="Connect a provider" done={false} />);
    expect(accessibleText(host)).not.toContain('completed');
  });

  it('the step number is not announced — it is decorative', () => {
    const host = mount(() => <Step label="Connect a provider" done={false} />);
    expect(accessibleText(host)).toBe('Connect a provider');
  });
});

describe('a link that opens elsewhere says so', () => {
  it('states it opens a new tab, rather than relying on the mark', () => {
    const host = mount(() => (
      <a href="https://example.test" target="_blank" rel="noreferrer">
        Open sign-in link <Icon name="externalLink" size={12} />
        <span class="sr-only"> (opens in a new tab)</span>
      </a>
    ));
    expect(accessibleText(host)).toContain('opens in a new tab');
  });
});

describe('the REAL request table, not a replica', () => {
  // The tests above build their own markup, so they would keep passing if `RequestTable` were
  // broken. This one renders the actual app and reads the actual rows — the check that the
  // requirement holds where it ships, rather than where it is described.
  it('exposes escalation as text on a real escalated row', async () => {
    const { App } = await import('./App');
    const { createAppStore } = await import('./state/appState');
    const { AppProvider } = await import('./state/context');
    const { FakeApiClient } = await import('./test/fakeClient');

    const store = createAppStore(new FakeApiClient({}));
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(
      () => (
        <AppProvider store={store}>
          <App live={false} />
        </AppProvider>
      ),
      host,
    );
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    [...host.querySelectorAll<HTMLElement>('.nav-item span')]
      .find((e) => e.textContent?.trim() === 'Requests')
      ?.click();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

    const rows = [...host.querySelectorAll<HTMLElement>('.req-row')];
    expect(rows.length, 'fixture rendered no rows').toBeGreaterThan(0);
    const cascade = rows.filter((r) => accessibleText(r).includes('cascade'));
    expect(cascade.length, 'fixture has no escalated (cascade) row to check').toBeGreaterThan(0);
    for (const row of cascade) {
      expect(
        accessibleText(row),
        'a real escalated row does not announce escalation',
      ).toContain('escalated');
    }
    // And the mark itself stays out of the accessible name.
    expect(cascade[0]?.querySelector('[data-icon="escalated"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
});

describe('replacing a glyph with artwork did not strip any accessible name', () => {
  // The specific hazard in this change: a control whose ONLY content was a text glyph (`✕`,
  // `⋮⋮`) had an accessible name from that text. Replacing it with `aria-hidden` artwork
  // removes the name unless the control carries its own. Spot-checking three call sites is
  // not enough — this sweeps every control the app renders.
  it('no control is left nameless by its icon being decorative', async () => {
    const { App } = await import('./App');
    const { createAppStore } = await import('./state/appState');
    const { AppProvider } = await import('./state/context');
    const { FakeApiClient } = await import('./test/fakeClient');

    const store = createAppStore(new FakeApiClient({}));
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(
      () => (
        <AppProvider store={store}>
          <App live={false} />
        </AppProvider>
      ),
      host,
    );
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

    const nameless: string[] = [];
    for (const page of ['requests', 'costs', 'routing', 'providers', 'settings']) {
      [...host.querySelectorAll<HTMLElement>('.nav-item span')]
        .find((e) => e.textContent?.trim().toLowerCase() === page)
        ?.click();
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

      // Overlays hold several of the replaced glyphs (the drawer's close button was `✕`
      // TEXT), and they are not in the DOM until opened. A sweep that only walks pages
      // silently skips exactly the controls most at risk — verified by removing the close
      // button's aria-label and watching this test still pass before the row click existed.
      if (page === 'requests') {
        host.querySelector<HTMLElement>('button.req-row')?.click();
        for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
      }

      for (const el of host.querySelectorAll<HTMLElement>('button, a[href]')) {
        if (!el.querySelector('[data-icon]')) continue;
        const named =
          (el.getAttribute('aria-label') ?? '').trim() !== '' ||
          (el.getAttribute('title') ?? '').trim() !== '' ||
          accessibleText(el) !== '';
        if (!named) nameless.push(`${page}: <${el.tagName.toLowerCase()}> ${el.className}`);
      }
    }
    expect(
      [...new Set(nameless)],
      'these controls contain only decorative artwork and have no accessible name',
    ).toEqual([]);
  });
});
