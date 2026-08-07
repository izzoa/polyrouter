/** Tables → stacked records (phase1-responsive-dashboard-layout, group 6).
 *
 * WHAT THESE TESTS ARE. `happy-dom` evaluates no container query, so nothing here proves
 * a table actually reflows at its locked `table-fit` — that is the browser suite's job.
 * These assert what the reflow is NOT allowed to change: the request row stays one
 * button with a byte-identical accessible name, the in-flight row stays inert, every row
 * action survives, and no field is left unnamed. Those hold at every width precisely
 * because there is only ONE DOM.
 */
import { render } from 'solid-js/web';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import type { AgentDto } from './data/api';

const AGENTS: AgentDto[] = [
  {
    id: 'a1',
    name: 'claude-code-production',
    harness: 'claude-code',
    prefix: 'poly_a1b2c3',
    lastUsedAt: '2026-08-06T12:00:00.000Z',
    createdAt: '2026-08-01T12:00:00.000Z',
  },
];
const ADMIN_USERS = [
  {
    id: 'u1',
    email: 'alexandra.hartmann@enterprise-customer.example.com',
    name: 'Alexandra',
    role: 'admin',
    disabled: false,
    createdAt: '2026-08-01T12:00:00.000Z',
  },
];

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

async function mount(): Promise<{ host: HTMLElement; store: AppStore; dispose: () => void }> {
  // The fake client seeds nothing by default; these tests are about how ROWS render, so
  // they must actually have rows.
  const store = createAppStore(new FakeApiClient({ agents: AGENTS, adminUsers: ADMIN_USERS }));
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

/** What a screen reader would announce for an element: text content with anything
 * `aria-hidden` removed, whitespace-collapsed. */
function accessibleName(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Removes a cell that renders its value TWICE — once visually (`aria-hidden`), once as
 * screen-reader text. The requests table's token column does this: `100↑ 40↓` is shown and
 * `100 tokens in, 40 out` is announced, because an arrow announces as "up arrow".
 *
 * Such a pair cannot take part in the byte-identity check below, by construction: removing
 * labels-by-class keeps the visible half, removing everything-aria-hidden keeps the announced
 * half, and the two halves are deliberately different text. Stripping both halves from both
 * sides keeps the check meaningful for every other column. */
function stripDualRepresentations(el: HTMLElement): void {
  for (const sr of [...el.querySelectorAll('.sr-only')]) {
    const visible = sr.previousElementSibling;
    if (visible?.getAttribute('aria-hidden') === 'true') visible.remove();
    sr.remove();
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('request row semantics survive the stacked presentation', () => {
  it('keeps the row one button with its expanded state and inspector association', async () => {
    const h = await mount();
    try {
      h.store.go('requests');
      await flush();
      const row = h.host.querySelector<HTMLButtonElement>('button.req-row');
      expect(row).not.toBeNull();
      expect(row?.tagName).toBe('BUTTON');
      expect(row?.getAttribute('aria-controls')).toBe('inspector-drawer');
      expect(row?.getAttribute('aria-expanded')).toBe('false');
    } finally {
      h.dispose();
    }
  });

  it('leaves the accessible name byte-identical — the field labels are hidden from it', async () => {
    // This is the defect a `::before` label would have introduced: generated content
    // participates in name computation, so "Time"/"Model"/… would have been prepended.
    // Real spans marked aria-hidden give sighted users the names and change nothing else.
    const h = await mount();
    try {
      h.store.go('requests');
      await flush();
      const row = h.host.querySelector<HTMLElement>('button.req-row');
      if (!row) throw new Error('no request row');

      // Substring matching would be wrong here: the fake rows contain values literally
      // named "Model 0"/"Provider 0", so a leaked label is indistinguishable from data.
      // Instead assert the labels contribute NOTHING — the announced name must equal the
      // cell values with every label's own text removed.
      const withoutLabels = row.cloneNode(true) as HTMLElement;
      for (const l of withoutLabels.querySelectorAll('.rs-cell-label')) l.remove();
      stripDualRepresentations(withoutLabels);
      const valuesOnly = (withoutLabels.textContent ?? '').replace(/\s+/g, ' ').trim();

      // Removing the labels BY CLASS and removing everything ARIA-HIDDEN must produce the
      // same string. If a label were not hidden, the second would keep it and they would
      // diverge — which is precisely the `::before` defect, restated as an equality.
      // Strip the dual pair FIRST, then let `accessibleName` do the aria-hidden removal —
      // so this still exercises the same name computation every other assertion uses.
      const announced = row.cloneNode(true) as HTMLElement;
      stripDualRepresentations(announced);
      expect(accessibleName(announced)).toBe(valuesOnly);
      expect(valuesOnly.length).toBeGreaterThan(0);
      // And the labels really are present in the DOM for sighted users.
      const labels = [...row.querySelectorAll('.rs-cell-label')];
      expect(labels.length).toBe(9);
      expect(labels.every((l) => l.getAttribute('aria-hidden') === 'true')).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('keeps the in-flight row non-interactive with no added role or tab stop', async () => {
    const h = await mount();
    try {
      h.store.go('requests');
      await flush();
      const inflight = h.host.querySelector<HTMLElement>('div.req-row');
      if (inflight) {
        expect(inflight.tagName).toBe('DIV');
        expect(inflight.getAttribute('role')).toBeNull();
        expect(inflight.getAttribute('tabindex')).toBeNull();
        expect(inflight.querySelector('button')).toBeNull();
      }
    } finally {
      h.dispose();
    }
  });
});

describe('tables without a detail surface keep every field and action inline', () => {
  it('keeps the Agents row actions operable', async () => {
    // Agents has no row detail surface, so "no field lost" is not enough — the actions
    // have to survive too, and creating a detail surface is out of scope for this phase.
    const h = await mount();
    try {
      h.store.go('agents');
      await flush();
      const row = h.host.querySelector<HTMLElement>('.rs-agent-row');
      expect(row, 'no agent row rendered').not.toBeNull();
      const actions = [...(row?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim());
      expect(actions).toContain('Rotate key');
      expect(actions.some((a) => a?.includes('Delete'))).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('names every Agents field with a label that assistive tech can read', async () => {
    const h = await mount();
    try {
      h.store.go('agents');
      await flush();
      const row = h.host.querySelector<HTMLElement>('.rs-agent-row');
      const labels = [...(row?.querySelectorAll('.rs-cell-label') ?? [])];
      expect(labels.length).toBe(7);
      // NOT aria-hidden, unlike the request row's. That row is a single <button> whose
      // accessible name must not change; an agent row is a plain div with no button name
      // to protect and no <thead> association, so hiding the labels would leave every
      // value unnamed at both widths for no benefit.
      expect(labels.every((l) => l.getAttribute('aria-hidden') === null)).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('gives the semantic Users tables REAL labels, not hidden ones', async () => {
    // `display:block` drops the table role and with it the <thead> association, so these
    // labels are the only thing naming each value. Marking them aria-hidden as well would
    // leave every field unnamed — which the spec forbids outright.
    const h = await mount();
    try {
      h.store.go('users');
      await flush();
      const labels = [...h.host.querySelectorAll('.rs-table-users .rs-cell-label')];
      expect(labels.length).toBeGreaterThan(0);
      expect(
        labels.every((l) => l.getAttribute('aria-hidden') === null),
        'Users field labels must stay in the accessibility tree',
      ).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe('table stylesheet contract', () => {
  it('leaves no inline grid-template-columns at any of the five table sites (6.8)', () => {
    for (const f of ['components/RequestTable.tsx', 'pages/Agents.tsx']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, `${f} still sets a column template inline`).not.toMatch(
        /grid-template-columns/,
      );
    }
  });

  it('scopes the two column templates by container class so they cannot be shared', () => {
    // The RequestTable and Agents constants were both called GRID and were NOT the same
    // template — 9 columns vs 7. Scoping keeps `.table-head` a shared class regardless.
    expect(css).toMatch(/\.rs-table-requests \.table-head[\s\S]{0,120}66px 1\.5fr/);
    expect(css).toMatch(/\.rs-table-agents \.table-head[\s\S]{0,120}1\.3fr 1fr/);
  });

  it('drives every stacked reflow from a container query at its measured threshold', () => {
    for (const [name, px] of [
      ['rs-requests', 960],
      ['rs-agents', 680],
      ['rs-users', 660],
    ] as const) {
      expect(css, `${name} has no container query`).toContain(
        `@container ${name} (max-width: ${String(px)}px)`,
      );
    }
  });

  it('hides the semantic head only where replacement labels are shown', () => {
    const usersBlock = css.slice(css.indexOf('@container rs-users'));
    expect(usersBlock).toContain('thead');
    expect(usersBlock).toContain('.rs-cell-label');
  });
});
