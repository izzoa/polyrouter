/**
 * Figures are tabular Geist; Geist Mono is for identifiers (adopt-design-tokens-v2 task 9.1;
 * dashboard-core "Figures are set in tabular Geist and Mono is reserved for identifiers",
 * scenarios "A table row's figures are Geist tabular" and "An identifier stays Mono";
 * DESIGN.md The Machine-String Rule).
 *
 * The real App renders the Requests page on a fake client with the real stylesheet loaded,
 * and each row's cells are read by their field label (`.rs-cell-label`), not by position: the
 * cost, tokens, latency and time cells must compute to the Geist family with
 * `font-variant-numeric: tabular-nums`, and the model cell to Geist Mono. The live batch-job
 * and in-flight rows share the table, so their figure cells are held the same way.
 *
 * happy-dom resolves `font-family` and `font-variant-numeric` from the stylesheet in
 * `getComputedStyle`; neither is layout.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createAppStore } from './state/appState';
import { AppProvider } from './state/context';
import { buildRequestRows, DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let dispose: (() => void) | undefined;
let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  sheet.remove();
  document.body.innerHTML = '';
});

async function requestsPage(): Promise<HTMLElement> {
  globalThis.history.replaceState(null, '', '/#/requests');
  const fake = new FakeApiClient({ session: DEFAULT_SESSION, requestRows: buildRequestRows(3) });
  const store = createAppStore(fake);
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
  store.go('requests');
  await flush();
  return host;
}

/** A row's value element for one field: the element after the cell's label. */
function cellValue(row: Element, label: string): HTMLElement {
  const cell = [...row.querySelectorAll('.rs-cell')].find(
    (c) => c.querySelector('.rs-cell-label')?.textContent === label,
  );
  const value = cell?.querySelector<HTMLElement>(':scope > :not(.rs-cell-label)');
  if (!value) throw new Error(`no ${label} cell`);
  return value;
}

const family = (el: Element): string => getComputedStyle(el).fontFamily.replace(/["']/g, '');

describe("a request row's figures are tabular Geist, its identifiers Mono (task 9.1)", () => {
  it('cost, tokens, latency and time compute to Geist with tabular-nums; the model to Geist Mono', async () => {
    const host = await requestsPage();
    const rows = [...host.querySelectorAll('button.req-row')];
    expect(rows.length, 'request rows rendered').toBeGreaterThan(0);
    for (const row of rows) {
      for (const label of ['Cost', 'Tokens', 'Latency', 'Time']) {
        const v = cellValue(row, label);
        expect(family(v), `${label}: the family`).toMatch(/^Geist,/);
        expect(getComputedStyle(v).fontVariantNumeric, `${label}: tabular figures`).toBe(
          'tabular-nums',
        );
      }
      const model = cellValue(row, 'Model');
      expect(family(model), 'Model: an identifier').toMatch(/^Geist Mono,/);
    }
  });

  it('self-check: the probe tells the two faces apart', () => {
    const mono = document.createElement('span');
    mono.className = 'mono';
    const figure = document.createElement('span');
    figure.className = 'figure';
    document.body.append(mono, figure);
    expect(family(mono)).toMatch(/^Geist Mono,/);
    expect(family(figure)).toMatch(/^Geist,/);
    expect(getComputedStyle(figure).fontVariantNumeric).toBe('tabular-nums');
    expect(getComputedStyle(mono).fontVariantNumeric).not.toBe('tabular-nums');
  });
});

describe('figures elsewhere are tabular Geist (task 9.1)', () => {
  it('the stylesheet sets figure roles in Geist with tabular-nums, never Mono', () => {
    const rule = (sel: string): string => {
      const at = css.indexOf(`\n${sel} {`);
      if (at < 0) throw new Error(`no rule ${sel}`);
      return css.slice(at, css.indexOf('}', at));
    };
    for (const sel of [
      '.figure',
      '.readout-figure',
      '.nav-count',
      '.mp-price',
      '.ar-num',
      '.ar-figshare',
      '.ar-figcount',
      '.budget-percentage',
      '.budget-progress',
      '.kv-box--figures',
      '.input--figure',
    ]) {
      const body = rule(sel);
      expect(body, `${sel}: tabular figures`).toMatch(/font-variant-numeric:\s*tabular-nums/);
      expect(body, `${sel}: never Mono`).not.toMatch(/Geist Mono/);
    }
  });
});

describe('the inspector header and the cost-integrity sentence keep Mono for identifiers only', () => {
  it("the inspector's created time is a tabular Geist figure, beside its Mono id", async () => {
    const host = await requestsPage();
    host.querySelector<HTMLElement>('button.req-row')?.click();
    await flush();
    const id = host.querySelector('[data-testid="inspector-id"]');
    const time = host.querySelector('[data-testid="inspector-time"]');
    expect(id, 'the inspector header shows the request id').not.toBeNull();
    expect(time, 'the inspector header shows the created time').not.toBeNull();
    expect(family(id!), 'the id is an identifier').toMatch(/^Geist Mono,/);
    expect(family(time!), 'the time is a figure').toMatch(/^Geist,/);
    expect(getComputedStyle(time!).fontVariantNumeric).toBe('tabular-nums');
    // The line itself is not Mono, so the separator and anything added to it are not either.
    expect(family(time!.parentElement!)).not.toMatch(/Geist Mono/);
  });

  it("Costs' cost-integrity sentence is prose: no part of it is set in Mono", async () => {
    globalThis.history.replaceState(null, '', '/#/costs');
    const store = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
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
    store.go('costs');
    await flush();
    const sentence = [...host.querySelectorAll('.t-dense')].find((e) =>
      (e.textContent ?? '').includes('price snapshot'),
    );
    expect(sentence, 'the cost-integrity sentence is rendered').toBeDefined();
    for (const el of [sentence!, ...sentence!.querySelectorAll('*')])
      expect(family(el), `"${(el.textContent ?? '').slice(0, 30)}"`).not.toMatch(/Geist Mono/);
  });
});
