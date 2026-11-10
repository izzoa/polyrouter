/**
 * The readout strip's structure (redesign-readout-strip tasks 1.1, 1.2; dashboard-analytics
 * "Overview and Costs state their headline figures in one readout strip"): the focal cell, then
 * every other figure as one row of a rows column (label, figure, qualification), no column at
 * all with no rows, the figure slots kept through loading and failure (D5), and the focal
 * cell's optional secondary line (D2). The real stylesheet is loaded so sizes and colours are
 * computed values, not class names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FigureSkeleton } from './FigureSkeleton';
import { ReadoutStrip, type ReadoutCell, type ReadoutFocalCell } from './ReadoutStrip';

const CSS = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');

const FOCAL: ReadoutFocalCell = {
  id: 'spend',
  label: 'Spend · 24h',
  figure: '$0.00',
  sub: '1 request with estimated usage',
};
const ROWS: ReadoutCell[] = [
  { id: 'requests', label: 'Requests', figure: '41', sub: 'all on subscription plans' },
  { id: 'tokens', label: 'Tokens', figure: '2.6M', sub: '408.6k↑ 23.5k↓ · 2.1M cached' },
  { id: 'success', label: 'Success rate', figure: '97.6%', sub: 'fallback 0.0% · escalated 0.0%' },
];

let sheet: HTMLStyleElement;
let host: HTMLElement;
let dispose: () => void = () => undefined;
beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = CSS;
  document.head.appendChild(sheet);
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  dispose();
  host.remove();
  sheet.remove();
});

function mount(focal: ReadoutFocalCell, cells: readonly ReadoutCell[]): HTMLElement {
  dispose = render((): JSX.Element => <ReadoutStrip focal={focal} cells={cells} />, host);
  return host.querySelector<HTMLElement>('[data-readout-strip]')!;
}

const classesOf = (e: Element): string[] =>
  [...e.children].map((c) => [...c.classList].find((k) => k.startsWith('readout-')) ?? '');

describe('the readout strip lays its figures out as a focal cell and rows (task 1.1)', () => {
  it('three rows render label, figure and qualification in order, in one rows column beside the focal cell', () => {
    const panel = mount(FOCAL, ROWS);
    expect(classesOf(panel), 'the focal cell, then one rows column').toEqual([
      'readout-cell',
      'readout-rows',
    ]);
    const focal = panel.children[0]!;
    expect(focal.getAttribute('data-readout')).toBe('spend');
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-readout-rows] > [data-readout]')];
    expect(rows.map((r) => r.getAttribute('data-readout'))).toEqual([
      'requests',
      'tokens',
      'success',
    ]);
    for (const r of rows) {
      expect(r.classList.contains('readout-row')).toBe(true);
      expect(
        classesOf(r),
        `${r.dataset['readout'] ?? ''} reads label, figure, qualification`,
      ).toEqual(['readout-label', 'readout-figure', 'readout-sub']);
    }
    expect(rows.map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ['Requests', '41', 'all on subscription plans'],
      ['Tokens', '2.6M', '408.6k↑ 23.5k↓ · 2.1M cached'],
      ['Success rate', '97.6%', 'fallback 0.0% · escalated 0.0%'],
    ]);
    // The type roles: the focal figure is the one Display figure, each row's figure a Title.
    const size = (e: Element): string => getComputedStyle(e).fontSize;
    expect(size(focal.querySelector('.readout-figure')!)).toBe('26px');
    expect(rows.map((r) => size(r.querySelector('.readout-figure')!))).toEqual([
      '15px',
      '15px',
      '15px',
    ]);
    // The rows column is one grid; each row a subgrid of its three tracks (D1).
    expect(getComputedStyle(rows[0]!).gridTemplateColumns).toBe('subgrid');
    // No accent fill and no icon chip.
    expect(panel.querySelector('svg, [data-page-icon]')).toBeNull();
    expect(panel.outerHTML).not.toMatch(/--accent/);
  });

  it('zero rows render the focal cell alone: no rows column and no rule', () => {
    const panel = mount(FOCAL, []);
    expect(classesOf(panel)).toEqual(['readout-cell']);
    expect(panel.querySelector('[data-readout-rows], .readout-row')).toBeNull();
    expect(panel.querySelectorAll('[data-readout]')).toHaveLength(1);
  });

  it('a row without a qualification keeps its slot, empty', () => {
    const panel = mount(FOCAL, [{ id: 'requests', label: 'Requests', figure: '41' }]);
    const row = panel.querySelector<HTMLElement>('[data-readout="requests"]')!;
    expect(classesOf(row)).toEqual(['readout-label', 'readout-figure', 'readout-sub']);
    expect(row.querySelector('.readout-sub')?.textContent).toBe('');
  });

  it('loading keeps every figure slot, each holding its skeleton; failed keeps the slots, empty (D5)', () => {
    const loading = mount(
      { ...FOCAL, figure: <FigureSkeleton what="spend" size="display" />, sub: '' },
      [
        {
          id: 'requests',
          label: 'Requests',
          figure: <FigureSkeleton what="requests" size="title" />,
        },
        { id: 'tokens', label: 'Tokens', figure: <FigureSkeleton what="tokens" size="title" /> },
      ],
    );
    expect(loading.querySelectorAll('.readout-figure .fig-skel')).toHaveLength(3);
    expect(loading.querySelectorAll('.readout-row')).toHaveLength(2);
    expect(loading.querySelector('.readout-secondary')).toBeNull();
    dispose();

    const failed = mount({ ...FOCAL, figure: '', sub: '' }, [
      { id: 'requests', label: 'Requests', figure: '' },
    ]);
    expect(failed.querySelectorAll('.readout-figure')).toHaveLength(2);
    expect([...failed.querySelectorAll('.readout-figure')].map((f) => f.textContent)).toEqual([
      '',
      '',
    ]);
    expect(failed.querySelector('.fig-skel')).toBeNull();
  });
});

describe('the focal cell states an optional secondary line (task 1.2)', () => {
  it('present when passed: under the figure line, before the qualification, at Body size in Ink 2', () => {
    const panel = mount(
      {
        ...FOCAL,
        secondary: '$3.12 served on subscription, at API rates · excluded from spend',
      },
      ROWS,
    );
    const focal = panel.querySelector<HTMLElement>('[data-readout="spend"]')!;
    expect(classesOf(focal)).toEqual([
      'readout-label',
      'readout-line',
      'readout-secondary',
      'readout-sub',
    ]);
    const secondary = focal.querySelector<HTMLElement>('.readout-secondary')!;
    expect(secondary.textContent).toBe(
      '$3.12 served on subscription, at API rates · excluded from spend',
    );
    const cs = getComputedStyle(secondary);
    expect(cs.fontSize).toBe('13px');
    // Ink 2, resolved: the token's own value, not the Ink 3 of the qualification below.
    const ink = (name: string): string =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    expect(cs.color).toBe(ink('--text2'));
    expect(cs.color).not.toBe(ink('--text3'));
    expect(cs.fontVariantNumeric).toBe('tabular-nums');
    // Not a second Display figure.
    expect(secondary.closest('.readout-figure')).toBeNull();
  });

  it('absent otherwise, with no empty element', () => {
    const panel = mount(FOCAL, ROWS);
    expect(panel.querySelector('.readout-secondary')).toBeNull();
    expect(classesOf(panel.querySelector('[data-readout="spend"]')!)).toEqual([
      'readout-label',
      'readout-line',
      'readout-sub',
    ]);
  });
});
