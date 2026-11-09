/**
 * One Selected state on every current-item mark (adopt-design-tokens-v2 task 6.1; design.md D8;
 * dashboard-core "Every current-item mark uses one Selected state").
 *
 * Two halves, because happy-dom performs no cascade:
 *
 * - **The stylesheet.** Each surface's selected rule draws the one treatment — the wash, a
 *   deep-indigo label at 500 and a 1px deep-indigo edge (a border, or an inset outline on the
 *   request row) — and its rest rule already carries an edge of that width, so selecting moves
 *   nothing. Read from the shipped `styles.css`.
 * - **The markup.** On screen, each surface exposes its state in ARIA and carries the class the
 *   rule hangs on, with no inline fill or accent that would outrank or bypass it. Mounted from
 *   the real App on the fake client.
 *
 * That the selection really moves nothing is measured in the browser (`heightFamily.spec.ts`,
 * "selecting moves nothing").
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import { labelText } from './test/labelText';

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every leaf rule's declarations whose selector list holds exactly `selector`. */
function bodies(selector: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = (m[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (list.includes(selector)) out.push(m[2] ?? '');
  }
  return out;
}
function decl(selector: string, property: string): string | null {
  const values = bodies(selector).flatMap((b) =>
    [...b.matchAll(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`, 'g'))].map((m) =>
      (m[1] as string).replace(/\s+/g, ' ').trim(),
    ),
  );
  return values.at(-1) ?? null;
}

interface Surface {
  name: string;
  /** The selected rule. */
  selected: string;
  /** Where the deep-indigo label lives, when it is not the selected element itself. */
  label?: string | null;
  /** The label's own rest rule, where it carries the label's weight. */
  labelRest?: string;
  /** The rest rule, whose edge the Selected state recolours. */
  rest: string;
  restEdge: string;
  edge: 'border' | 'outline';
}

const SURFACES: readonly Surface[] = [
  {
    name: 'nav item',
    selected: ".nav-item[aria-current='page']",
    rest: '.nav-item',
    restEdge: '1px solid transparent',
    edge: 'border',
  },
  {
    name: 'segmented option',
    selected: ".rs-seg[aria-pressed='true']",
    rest: '.rs-seg',
    restEdge: '1px solid transparent',
    edge: 'border',
  },
  {
    name: 'filter chip',
    selected: ".filter-chip[aria-pressed='true']",
    rest: '.filter-chip',
    // The edge is a filter chip's affordance (task 8.3, design.md D2), so it rests in Control Edge.
    restEdge: '1px solid var(--border-control)',
    edge: 'border',
  },
  {
    name: 'mode toggle (a pressed ghost button)',
    selected: ".btn-ghost[aria-pressed='true']",
    rest: '.btn-ghost',
    restEdge: '1px solid var(--border)',
    edge: 'border',
  },
  {
    name: 'provider-kind card',
    selected: ".kind-card[aria-pressed='true']",
    label: ".kind-card[aria-pressed='true'] .kind-card-name",
    labelRest: '.kind-card-name',
    rest: '.kind-card',
    restEdge: '1px solid var(--border)',
    edge: 'border',
  },
  {
    name: 'current setup step (its marker)',
    selected: "[aria-current='step'] > .step-marker:not(.step-marker--done)",
    rest: '.step-marker',
    restEdge: '1px solid var(--border)',
    edge: 'border',
  },
  {
    name: 'open request row',
    selected: ".req-row[aria-expanded='true']",
    // A row's cells keep their Ink / Ink 2 / Ink 3 text on the wash; only the edge marks it.
    label: null,
    rest: '.req-row',
    restEdge: '',
    edge: 'outline',
  },
];

describe('the stylesheet draws one Selected treatment on every surface (D8)', () => {
  for (const s of SURFACES) {
    it(`${s.name}: the wash, a deep-indigo label at 500 and a 1px deep-indigo edge`, () => {
      expect(bodies(s.selected).length, `${s.selected} is in styles.css`).toBeGreaterThan(0);
      expect(decl(s.selected, 'background'), `${s.selected} fill`).toBe('var(--accent-bg)');
      if (s.edge === 'border') {
        expect(decl(s.selected, 'border-color'), `${s.selected} edge`).toBe('var(--accent-deep)');
      } else {
        // Inset on a row: drawn inside the row's own box, so its geometry does not change.
        expect(decl(s.selected, 'outline'), `${s.selected} edge`).toBe(
          '1px solid var(--accent-deep)',
        );
        expect(decl(s.selected, 'outline-offset'), `${s.selected} edge is inset`).toBe('-1px');
      }
      if (s.label !== null) {
        const label = s.label ?? s.selected;
        expect(decl(label, 'color'), `${label} label`).toBe('var(--accent-deep)');
        // The weight is the label's own where it is set apart from the control; a nav item and
        // a segment move from 400 to 500, so they state it on the selected rule.
        const weight =
          decl(label, 'font-weight') ??
          decl(s.selected, 'font-weight') ??
          (s.labelRest === undefined ? null : decl(s.labelRest, 'font-weight'));
        const restWeight = /\b([1-9]00)\b/.exec(decl(s.rest, 'font') ?? '')?.[1];
        expect(weight ?? restWeight ?? '', `${label} weight`).toBe('500');
      }
    });

    if (s.edge === 'border') {
      it(`${s.name}: the rest rule already carries a 1px edge, so selecting moves nothing`, () => {
        expect(decl(s.rest, 'border'), `${s.rest} rest edge`).toBe(s.restEdge);
      });
    }
  }

  it('a selected segment holds its selected-weight width whether or not it is selected', () => {
    // `.rs-seg::after` lays out an invisible, zero-height copy of the label at 500.
    expect(decl('.rs-seg::after', 'content')).toBe("attr(data-label) / ''");
    expect(decl('.rs-seg::after', 'font-weight')).toBe('500');
    expect(decl('.rs-seg::after', 'height')).toBe('0');
    expect(decl('.rs-seg::after', 'visibility')).toBe('hidden');
  });

  it('no selected surface keeps a raw-accent edge or a chip-tone fill', () => {
    for (const s of SURFACES) {
      for (const body of bodies(s.selected)) {
        expect(body, s.selected).not.toMatch(/var\(--accent\)/);
        expect(body, s.selected).not.toMatch(/var\(--chip\)/);
      }
    }
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Mounted {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
}

async function mount(client = new FakeApiClient()): Promise<Mounted> {
  const store = createAppStore(client);
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

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

const all = <E extends Element = HTMLElement>(root: ParentNode, sel: string): E[] => [
  ...root.querySelectorAll<E>(sel),
];

/** No inline fill, edge or accent that would outrank or bypass the class rule. */
function noInlineSelection(el: Element, what: string): void {
  const style = el.getAttribute('style') ?? '';
  expect(style, `${what} draws nothing inline`).not.toMatch(/background|border|accent/);
}

/** One selected member in `group`, and it is the one named. */
function exactlyOneSelected(
  group: readonly HTMLElement[],
  attr: 'aria-pressed' | 'aria-current' | 'aria-expanded',
  on: string,
  want: string,
): HTMLElement {
  const selected = group.filter((b) => b.getAttribute(attr) === on);
  expect(
    selected.map((b) => labelText(b)),
    `exactly one ${attr}=${on}`,
  ).toEqual([want]);
  return selected[0] as HTMLElement;
}

describe('each surface exposes its selection in markup, on the class the rule draws (D8)', () => {
  it('nav items: the current page is `.nav-item` with aria-current="page", and it moves', async () => {
    const h = await mount();
    try {
      const nav = (): HTMLElement[] => all(h.host, 'nav button');
      for (const b of nav()) expect(b.classList.contains('nav-item'), labelText(b)).toBe(true);
      exactlyOneSelected(nav(), 'aria-current', 'page', 'Overview');
      h.store.go('requests');
      await flush();
      const current = exactlyOneSelected(nav(), 'aria-current', 'page', 'Requests');
      noInlineSelection(current, 'the current nav item');
    } finally {
      h.dispose();
    }
  });

  it('segmented options: the range, the metric and the Routing sections are `.rs-seg`, aria-pressed', async () => {
    const h = await mount();
    try {
      // Overview's range: the track holding 24h / 7d / 30d (the breakdown's metric switch is
      // another track on the same page).
      const range = (): HTMLElement[] =>
        all<HTMLElement>(h.host, '.seg-track')
          .filter((t) => all(t, '.rs-seg').some((b) => labelText(b) === '24h'))
          .flatMap((t) => all<HTMLElement>(t, '.rs-seg'));
      expect(range().map((b) => labelText(b))).toEqual(['24h', '7d', '30d']);
      exactlyOneSelected(range(), 'aria-pressed', 'true', '24h');
      const thirty = range().find((b) => labelText(b) === '30d') as HTMLElement;
      thirty.click();
      await flush();
      exactlyOneSelected(range(), 'aria-pressed', 'true', '30d');
      for (const b of range()) {
        expect(b.getAttribute('aria-pressed'), labelText(b)).toMatch(/^(true|false)$/);
        // `.rs-seg::after` reads the label from here to hold the selected weight's width.
        expect(b.dataset['label'], `${labelText(b)} carries data-label`).toBe(labelText(b));
        noInlineSelection(b, `the ${labelText(b)} option`);
      }

      // Costs' metric switch.
      h.store.go('costs');
      await flush();
      const segs = all<HTMLElement>(h.host, '.seg-track .rs-seg');
      const metric = segs.filter((b) => !['24h', '7d', '30d'].includes(labelText(b)));
      expect(metric.length, 'the Costs metric switch rendered').toBeGreaterThan(1);
      expect(metric.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
      for (const b of metric) expect(b.dataset['label']).toBe(labelText(b));

      // Routing's sections.
      h.store.go('routing');
      await flush();
      const tabs = all<HTMLElement>(h.host, '[data-testid="routing-sections"] .rs-seg');
      exactlyOneSelected(tabs, 'aria-pressed', 'true', 'Tiers & headers');
    } finally {
      h.dispose();
    }
  });

  it('segmented options in the budget modal: Alert / Block and the basis, `.rs-seg`, aria-pressed', async () => {
    const h = await mount();
    try {
      h.store.go('limits');
      await flush();
      h.store.openBudget();
      await flush();
      const group = (name: string): HTMLElement[] =>
        all(h.host, `[role="group"][aria-label="${name}"] .rs-seg`);
      const alert = exactlyOneSelected(group('At the threshold'), 'aria-pressed', 'true', 'Alert');
      const block = group('At the threshold').find((b) => labelText(b) === 'Block') as HTMLElement;
      // The chosen action takes the one Selected state: no red variant of it (flags.md F4).
      expect(block.className).toBe('rs-seg rs-seg--fill');
      block.click();
      await flush();
      exactlyOneSelected(group('At the threshold'), 'aria-pressed', 'true', 'Block');
      expect(alert.getAttribute('aria-pressed')).toBe('false');
      exactlyOneSelected(group('What this budget counts'), 'aria-pressed', 'true', 'Money spent');
      for (const b of [...group('At the threshold'), ...group('What this budget counts')])
        expect(b.dataset['label'], labelText(b)).toBe(labelText(b));
    } finally {
      h.dispose();
    }
  });

  it('filter chips: the active routing filter and mode are `.filter-chip`, aria-pressed', async () => {
    const h = await mount();
    try {
      h.store.go('requests');
      await flush();
      const chips = all<HTMLElement>(h.host, '[data-testid="requests-filter-row"] .filter-chip');
      expect(chips.length, 'the filter row rendered its chips').toBeGreaterThan(3);
      const pressed = chips.filter((b) => b.getAttribute('aria-pressed') === 'true');
      // One routing filter and one mode are always active.
      expect(pressed.map((b) => labelText(b))).toEqual(['All', 'All']);
      for (const b of chips) noInlineSelection(b, `the ${labelText(b)} chip`);
    } finally {
      h.dispose();
    }
  });

  it('the registration mode: the chosen mode is a `.btn-ghost` with aria-pressed and no inline fill', async () => {
    const h = await mount();
    try {
      h.store.go('users');
      await flush();
      const group = all<HTMLElement>(
        h.host,
        '[role="group"][aria-label="Registration mode"] button',
      );
      const chosen = exactlyOneSelected(group, 'aria-pressed', 'true', 'Open sign-up');
      expect(chosen.classList.contains('btn-ghost')).toBe(true);
      for (const b of group) noInlineSelection(b, `the ${labelText(b)} mode`);
    } finally {
      h.dispose();
    }
  });

  it('provider-kind cards in the provider modal and the Setup guide: `.kind-card`, aria-pressed, a `.kind-card-name`', async () => {
    const h = await mount();
    try {
      h.store.go('providers');
      await flush();
      h.store.openModal('newProvider');
      await flush();
      // The provider kinds; the subscription preset cards share the class but are actions.
      const cards = (): HTMLElement[] => all(h.host, '.modal-card button.kind-card[aria-pressed]');
      expect(cards().length, 'the modal offers kinds').toBeGreaterThan(1);
      const first = cards().filter((b) => b.getAttribute('aria-pressed') === 'true');
      expect(first).toHaveLength(1);
      // Subscription opens the plan picker instead of staying on the kind grid
      // (redesign-subscription-picker), so the selection is exercised on another kind.
      const other = cards().find(
        (b) =>
          b.getAttribute('aria-pressed') === 'false' &&
          !(b.textContent ?? '').startsWith('Subscription'),
      ) as HTMLElement;
      other.click();
      await flush();
      expect(other.getAttribute('aria-pressed')).toBe('true');
      expect(cards().filter((b) => b.getAttribute('aria-pressed') === 'true')).toEqual([other]);
      for (const c of cards()) {
        expect(
          c.querySelector('.kind-card-name'),
          'the name the label rule colours',
        ).not.toBeNull();
        noInlineSelection(c, 'a kind card');
        expect(c.querySelector('.kind-card-name')?.getAttribute('style') ?? '').not.toMatch(
          /color/,
        );
      }
      h.store.closeModal();
      await flush();

      h.store.go('setup');
      await flush();
      h.store.obGo(2);
      await flush();
      const setupCards = all<HTMLElement>(h.host, 'button.kind-card');
      expect(setupCards.length, 'the Setup guide offers kinds').toBeGreaterThan(1);
      expect(setupCards.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
      for (const c of setupCards) {
        expect(c.querySelector('.kind-card-name')).not.toBeNull();
        expect(c.querySelector('.kind-card-name')?.getAttribute('style') ?? '').not.toMatch(
          /color/,
        );
      }
    } finally {
      h.dispose();
    }
  });

  it('the Setup guide: the current step is aria-current="step", drawn on its `.step-marker`', async () => {
    const h = await mount();
    try {
      h.store.go('setup');
      await flush();
      const steps = (): HTMLElement[] =>
        all<HTMLElement>(h.host, 'button').filter((b) => b.querySelector(':scope > .step-marker'));
      expect(steps()).toHaveLength(3);
      const current = steps().filter((b) => b.getAttribute('aria-current') === 'step');
      expect(current).toHaveLength(1);
      const marker = current[0]?.querySelector<HTMLElement>(':scope > .step-marker');
      expect(marker?.classList.contains('step-marker--done')).toBe(false);
      expect(marker?.textContent).toBe('1');
      for (const s of steps()) noInlineSelection(s.querySelector('.step-marker')!, 'a step marker');
      h.store.obGo(3);
      await flush();
      const moved = steps().filter((b) => b.getAttribute('aria-current') === 'step');
      expect(moved.map((b) => b.querySelector('.step-marker')?.textContent)).toEqual(['3']);
    } finally {
      h.dispose();
    }
  });

  it('the open request row: `.req-row` with aria-expanded="true", and no inline fill', async () => {
    const h = await mount();
    try {
      h.store.go('requests');
      await flush();
      const rows = (): HTMLElement[] => all(h.host, '.rs-table-requests button.req-row');
      expect(rows().length).toBeGreaterThan(1);
      for (const r of rows()) {
        expect(r.getAttribute('aria-expanded')).toBe('false');
        noInlineSelection(r, 'a closed row');
      }
      rows()[1]!.click();
      await flush();
      const open = rows().filter((r) => r.getAttribute('aria-expanded') === 'true');
      expect(open).toEqual([rows()[1]]);
      noInlineSelection(open[0]!, 'the open row');
    } finally {
      h.dispose();
    }
  });
});
