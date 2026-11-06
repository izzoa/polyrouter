/** Record tables share one row, head and cell treatment (adopt-design-tokens-v2 task 9.2;
 * dashboard-core "Record tables share one row, head and group-boundary treatment", scenarios
 * "Figures never truncate while identifiers do" and "The head row uses the overline role";
 * DESIGN.md Layout "Tables" and Long content).
 *
 * Requests, Batches, Agents and Users are each opened in the browser harness, whose fixture
 * carries adversarial content on purpose (a 26-character model id, a long provider label, a
 * 29-character agent name, a 50-character email), at the NARROWEST viewport — swept in 4px
 * steps — whose table container is still wider than the table's `table-fit-*` threshold. That
 * is the table at its tightest while it is still a grid, so a figure that could be cut, or an
 * identifier that could wrap, is cut or wraps there first.
 *
 * The thresholds are read from `styles.css` (the `@container` literals), never restated here,
 * so the sweep follows them when task 14.1 re-measures them.
 *
 * In every row:
 *   - a FIGURE cell (cost, tokens, latency, counts) shows in full (`scrollWidth ≤ clientWidth`)
 *     and is right-aligned;
 *   - an IDENTIFIER cell (model id, provider, tier, agent name, key, email) is cut on one line
 *     — `overflow: hidden`, `text-overflow: ellipsis`, `white-space: nowrap` — and keeps its
 *     full text as content and as its `title`;
 *   - rows are at least 32px, the head row is 32px, and cell content sits 16px in from the row
 *     edge with 16px between columns.
 *
 * Cells are found by their field label (`.rs-cell-label`, which every record carries for its
 * stacked form), never by the classes that style them, so a cell that loses its class is still
 * read. EXACT for the fixed sizes (a `min-height`, an explicit `height`, a padding and a gap
 * are declared values); the figure and identifier checks are structural.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8');

/** A table's `table-fit-*` threshold: the literal in its `@container` prelude. */
function threshold(query: string): number {
  const m = new RegExp(`@container ${query} \\(max-width: (\\d+)px\\)`).exec(css);
  if (!m?.[1]) throw new Error(`no @container ${query} threshold in styles.css`);
  return Number(m[1]);
}

interface Table {
  name: string;
  url: string;
  /** The query container (the table panel). */
  container: string;
  query: string;
  /** The row elements, and how a row's cells are found. */
  rows: string;
  cells: string;
  /** The head row. */
  head: string;
  figures: readonly string[];
  identifiers: readonly string[];
}

const TABLES: readonly Table[] = [
  {
    name: 'requests',
    url: '/browser-harness.html#/requests',
    container: '.rs-table-requests',
    query: 'rs-requests',
    rows: '.rs-table-requests .req-row',
    cells: ':scope > .rs-cell',
    head: '.rs-table-requests .table-head',
    figures: ['Tokens', 'Cost', 'Latency'],
    identifiers: ['Model', 'Provider', 'Tier'],
  },
  {
    name: 'batches',
    url: '/browser-harness.html#/batches',
    container: '.rs-table-batches',
    query: 'rs-batches',
    rows: '.rs-table-batches .rs-batch-row',
    cells: ':scope > .rs-cell',
    head: '.rs-table-batches .table-head',
    figures: ['Wall time', 'Cost'],
    identifiers: ['Model', 'Provider', 'Tier'],
  },
  {
    name: 'agents',
    url: '/browser-harness.html#/agents',
    container: '.rs-table-agents',
    query: 'rs-agents',
    rows: '.rs-table-agents .rs-agent-row',
    cells: ':scope > div',
    head: '.rs-table-agents .table-head',
    figures: ['Requests · 24h', 'Spend · 24h'],
    identifiers: ['Agent', 'Key'],
  },
  {
    name: 'users',
    url: '/browser-harness.html#/users',
    container: '.rs-table-users',
    query: 'rs-users',
    rows: '.rs-table-users tbody tr',
    cells: ':scope > td',
    head: '.rs-table-users thead tr',
    figures: [],
    identifiers: ['User', 'Email'],
  },
];

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

/** The query container's content-box width (what `@container` compares). Every container of
 * the table is read, and the narrowest decides (Users has two). */
async function containerWidth(page: Page, sel: string): Promise<number> {
  return page.evaluate((s) => {
    const widths = [...document.querySelectorAll<HTMLElement>(s)].map((el) => {
      const cs = getComputedStyle(el);
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    });
    if (widths.length === 0) throw new Error(`no container ${s}`);
    return Math.min(...widths);
  }, sel);
}

/** Step the viewport down in 4px from 1440 to the narrowest one whose container is still
 * wider than the threshold, and leave the page there. */
async function tightestGrid(page: Page, t: Table): Promise<{ viewport: number; width: number }> {
  const limit = threshold(t.query);
  let viewport = 1440;
  await page.setViewportSize({ width: viewport, height: 900 });
  let width = await containerWidth(page, t.container);
  expect(width, `${t.name}: at 1440 the container is already at its threshold`).toBeGreaterThan(
    limit,
  );
  for (;;) {
    await page.setViewportSize({ width: viewport - 4, height: 900 });
    const next = await containerWidth(page, t.container);
    if (next <= limit) break;
    viewport -= 4;
    width = next;
  }
  await page.setViewportSize({ width: viewport, height: 900 });
  return { viewport, width };
}

interface CellRead {
  label: string;
  /** The value element (the cell itself when its only element child is the label). */
  scroll: number;
  client: number;
  textAlign: string;
  /** The identifier element: the longest leaf text under the value. */
  id: {
    text: string;
    title: string | null;
    overflow: string;
    textOverflow: string;
    whiteSpace: string;
    overflows: boolean;
  } | null;
}

interface RowRead {
  height: number;
  /** A grid row's own inline padding and column gap; a table row's cell paddings. */
  grid: { padL: number; padR: number; gap: number } | null;
  tds: [number, number][];
  cells: CellRead[];
}

async function readRows(page: Page, t: Table): Promise<RowRead[]> {
  return page.evaluate(
    ([rowSel, cellSel]) =>
      [...document.querySelectorAll<HTMLElement>(rowSel)]
        .filter((r) => r.getBoundingClientRect().height > 0)
        .map((row) => {
          const rr = row.getBoundingClientRect();
          const rcs = getComputedStyle(row);
          const cells = [...row.querySelectorAll<HTMLElement>(cellSel)];
          const valueOf = (cell: HTMLElement): HTMLElement => {
            const kids = [...cell.children].filter(
              (k) => !(k as HTMLElement).classList.contains('rs-cell-label'),
            ) as HTMLElement[];
            // A `display: contents` wrapper has no box: its value child is the grid item.
            if (getComputedStyle(cell).display === 'contents') return kids[0] ?? cell;
            return kids.length === 1 && kids[0]!.children.length > 0 ? kids[0]! : cell;
          };
          const leaf = (v: HTMLElement): HTMLElement | null => {
            const all = [v, ...v.querySelectorAll<HTMLElement>('*')].filter(
              (e) =>
                !e.classList.contains('rs-cell-label') &&
                e.children.length === 0 &&
                (e.textContent ?? '').trim() !== '',
            );
            all.sort((a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length);
            return all[0] ?? null;
          };
          const grid = rcs.display === 'grid';
          return {
            height: rr.height,
            grid: grid
              ? {
                  padL: parseFloat(rcs.paddingLeft),
                  padR: parseFloat(rcs.paddingRight),
                  gap: parseFloat(rcs.columnGap),
                }
              : null,
            tds: grid
              ? []
              : cells.map((c): [number, number] => {
                  const cs = getComputedStyle(c);
                  return [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight)];
                }),
            cells: cells.map((c) => {
              const v = valueOf(c);
              const id = leaf(v);
              const ics = id ? getComputedStyle(id) : null;
              return {
                label: c.querySelector('.rs-cell-label')?.textContent?.trim() ?? '',
                scroll: v.scrollWidth,
                client: v.clientWidth,
                textAlign: getComputedStyle(v).textAlign,
                id:
                  id && ics
                    ? {
                        text: (id.textContent ?? '').trim(),
                        title: id.getAttribute('title'),
                        overflow: ics.overflowX,
                        textOverflow: ics.textOverflow,
                        whiteSpace: ics.whiteSpace,
                        overflows: id.scrollWidth > id.clientWidth,
                      }
                    : null,
              };
            }),
          };
        }),
    [t.rows, t.cells] as [string, string],
  );
}

/** Every defect in one table at its current width, each named by table, row and cell. */
function defects(t: Table, rows: readonly RowRead[], head: number[]): string[] {
  const out: string[] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;
  for (const h of head) {
    if (!near(h, 32)) out.push(`${t.name}: the head row is ${String(h)}px, not 32px`);
  }
  rows.forEach((r, i) => {
    const at = `${t.name} row ${String(i + 1)}`;
    if (r.height < 32 - 0.05) out.push(`${at} is ${String(r.height)}px, under 32px`);
    // 16px in from each edge, 16px between columns: a grid row's own padding and gap, or a
    // table row's cell paddings (8px either side of an inner boundary).
    if (r.grid !== null) {
      const { padL, padR, gap } = r.grid;
      if (padL !== 16 || padR !== 16 || gap !== 16)
        out.push(
          `${at}: padding ${String(padL)} / ${String(padR)}px and gap ${String(gap)}px, not 16`,
        );
    } else {
      const first = r.tds[0];
      const last = r.tds.at(-1);
      if (first?.[0] !== 16)
        out.push(`${at}: the first cell is ${String(first?.[0])}px in, not 16`);
      if (last?.[1] !== 16) out.push(`${at}: the last cell is ${String(last?.[1])}px in, not 16`);
      for (let k = 1; k < r.tds.length; k += 1) {
        const between = r.tds[k - 1]![1] + r.tds[k]![0];
        if (between !== 16)
          out.push(
            `${at}: ${String(between)}px between cells ${String(k)} and ${String(k + 1)}, not 16`,
          );
      }
    }
    for (const c of r.cells) {
      const cell = `${at} ${c.label}`;
      if (t.figures.includes(c.label)) {
        if (c.scroll > c.client)
          out.push(`${cell}: the figure is cut (${String(c.scroll)} > ${String(c.client)})`);
        if (c.textAlign !== 'right' && c.textAlign !== 'end')
          out.push(`${cell}: the figure is ${c.textAlign}-aligned, not right`);
      }
      if (t.identifiers.includes(c.label) && c.id !== null && c.id.text !== '—') {
        if (c.id.title !== c.id.text)
          out.push(
            `${cell}: title ${JSON.stringify(c.id.title)} is not the full text ${JSON.stringify(c.id.text)}`,
          );
        if (c.id.text.endsWith('…') && c.id.title === null)
          out.push(`${cell}: the text itself was shortened`);
        if (
          c.id.overflow !== 'hidden' ||
          c.id.textOverflow !== 'ellipsis' ||
          c.id.whiteSpace !== 'nowrap'
        )
          out.push(
            `${cell}: an identifier is not cut on one line (overflow ${c.id.overflow}, text-overflow ${c.id.textOverflow}, white-space ${c.id.whiteSpace})`,
          );
      }
    }
  });
  return out;
}

test.describe('record tables share one row, head and cell treatment (task 9.2)', () => {
  for (const t of TABLES) {
    test(`${t.name}: at its tightest grid width`, async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, t.url);
      const { viewport, width } = await tightestGrid(page, t);
      test.info().annotations.push({
        type: 'tightest grid',
        description: `${t.name}: viewport ${String(viewport)}px, container ${String(width)}px > ${String(threshold(t.query))}px`,
      });
      // Still a grid here, so the cells are the grid's (the stacked form hides the head).
      await expect(page.locator(t.head).first()).toBeVisible();
      const rows = await readRows(page, t);
      expect(rows.length, `${t.name}: rows rendered`).toBeGreaterThan(0);
      const head = await page
        .locator(t.head)
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      expect(defects(t, rows, head)).toEqual([]);

      // Not vacuous: every named figure and identifier cell was read, and the fixture's long
      // identifiers really are cut at this width.
      const labels = new Set(rows.flatMap((r) => r.cells.map((c) => c.label)));
      for (const l of [...t.figures, ...t.identifiers]) {
        expect(labels.has(l), `${t.name}: no "${l}" cell was read`).toBe(true);
      }
      const cut = rows.flatMap((r) => r.cells).filter((c) => c.id?.overflows === true);
      expect(cut.length, `${t.name}: no identifier is long enough to be cut here`).toBeGreaterThan(
        0,
      );
    });
  }
});
