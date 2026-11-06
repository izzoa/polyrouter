import { expect } from 'vitest';

/** What Overview shows that background quiet must leave alone (adopt-figure-states task 3.7;
 * dashboard-core "Background quiet is not a failure"): the readout strip's figures and the
 * recent request rows. */
export interface OverviewShown {
  figures: string[];
  rows: string[];
}

/** Reads the Overview's readout figures and recent request rows as rendered. */
export function overviewShown(host: HTMLElement): OverviewShown {
  return {
    figures: [...host.querySelectorAll('[data-readout-strip] .readout-figure')].map(
      (e) => e.textContent ?? '',
    ),
    rows: [...host.querySelectorAll('.req-row')].map((e) => e.textContent ?? ''),
  };
}

/** A hidden tab, an idle poll or a missing stream is not a failed read: no failure notice
 * renders, no `… couldn’t be loaded` body (the rendered U+2019), no figure or row is removed,
 * and no skeleton takes a figure's place. */
export function expectBackgroundQuiet(
  host: HTMLElement,
  before: OverviewShown,
  when: string,
): void {
  const titles = [...host.querySelectorAll('.notice-title')].map((e) => e.textContent);
  expect(titles, `${when}: a failure notice`).not.toContain('Couldn’t load');
  expect(host.textContent, `${when}: a failure body`).not.toContain('couldn’t be loaded');
  expect(host.querySelector('[data-readout-strip] .fig-skel'), `${when}: a skeleton`).toBeNull();
  const now = overviewShown(host);
  expect(before.figures.length, `${when}: nothing was shown to keep`).toBe(4);
  expect(
    before.figures.every((f) => f !== ''),
    `${when}: a figure was blank before`,
  ).toBe(true);
  expect(before.rows.length, `${when}: no request row was shown to keep`).toBeGreaterThan(0);
  expect(now.figures, `${when}: the figures changed`).toEqual(before.figures);
  expect(now.rows, `${when}: the request rows changed`).toEqual(before.rows);
}
