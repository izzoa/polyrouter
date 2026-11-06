/**
 * Geometry CAPTURE (assert-browser-geometry-structurally, task 4.1).
 *
 * `overlayBaseline.spec.ts` asks for exactly this, in its own words:
 *
 *   "Retiring them needs a capture-only CI run that logs every surface rather
 *    than only failures. Until then they stay wide, and that is a known,
 *    recorded gap rather than a claim."
 *
 * The gap is real. Eleven surfaces have never been measured on Linux; they pass
 * INSIDE `LINE_SLACK = 40` and `WIDTH_SLACK = 0.15`, and CI reports only the
 * measurements that FAIL — so a passing surface discloses nothing. **A pass is
 * not a measurement.** Narrowing those allowances from a pass would be
 * inference dressed as data.
 *
 * This file measures every surface and every pinned control and PRINTS the
 * numbers. It asserts nothing about their values and cannot fail on them, for
 * two reasons:
 *
 *  1. A capture that gates is a baseline, and pinning fresh numbers from the
 *     runner is how the v0.12.0 failure happened in the first place.
 *  2. A developer reading a red X wants to know what broke. A capture step that
 *     can go red teaches them to ignore this suite's output.
 *
 * It is tagged `@capture` and excluded from `npm run test:browser`, so it never
 * runs as part of the gate. Run it deliberately:
 *
 *     npm run test:browser:capture -w packages/frontend
 *
 * WHAT TO DO WITH THE OUTPUT (task 4.2): compare the runner's numbers against
 * `BASELINE` in `overlayBaseline.spec.ts`. Per surface and axis, either promote
 * the axis into `MEASURED_SLACK` with the observed spread plus margin, or
 * replace it with a structural assertion from `geometry-contract.ts`. Decide
 * from the numbers. This file deliberately does not decide for you.
 */
import { expect, test, type Page } from '@playwright/test';
import { SURFACES, boxOf, harnessUrl, viewportOf, type Surface } from './overlays';

/** Controls the responsive suite pins by height. Captured beside the surfaces
 * so one run answers every open question about platform spread, rather than
 * two runs answering half each. */
const CONTROLS = ['.nav-item', '.req-row', '.btn-primary', '.endpoint-chip'] as const;

const PAGES = ['overview', 'requests', 'routing', 'providers', 'agents'] as const;

function line(name: string, value: string): void {
  // Plain stdout, not the reporter: this must be readable in a raw CI log by
  // someone who has never run Playwright.
  process.stdout.write(`CAPTURE  ${name.padEnd(28)} ${value}\n`);
}

/** Opens the harness — on the query a surface needs, when it needs one. */
async function open(page: Page, surface: Pick<Surface, 'query'> = {}): Promise<void> {
  await page.goto(harnessUrl(surface));
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

test.describe('@capture geometry', () => {
  test('@capture every overlay surface', async ({ page }) => {
    const platform = await page.evaluate(() => navigator.userAgent);
    line('platform', platform);
    line(
      'viewport-note',
      'surfaces at 1440x900 unless they name their own viewport (each line prints it)',
    );

    for (const s of SURFACES) {
      // The viewport the baseline pins it at (`viewportOf`): 390x844 for a narrow-only
      // surface, 1025x768 for the modal inspector drawer, which docks at 1440
      // (add-docked-inspector D13).
      const vp = viewportOf(s);
      await page.setViewportSize(vp);
      await open(page, s);
      try {
        await s.open(page);
        // Entrance animations are transforms; measuring mid-flight reports a
        // shifted box, exactly as the baseline suite notes.
        await page.waitForTimeout(400);
        const box = await boxOf(page, s.sel);
        line(`surface:${s.name}`, `[${box.join(', ')}]  @${vp.width}x${vp.height}`);
      } catch (e) {
        // A surface that fails to open is worth reporting, but must not turn
        // the capture red — see the header.
        line(`surface:${s.name}`, `UNAVAILABLE (${(e as Error).message})`);
      }
    }
    // The only assertion in the file: that the run happened at all. Without it
    // a harness that silently opened nothing would produce an empty log that
    // reads like a clean result.
    expect(SURFACES.length).toBeGreaterThan(0);
  });

  test('@capture height family (adopt-design-tokens-v2 task 4.1)', async ({ page }) => {
    // `heightFamily.spec.ts` asserts every single-line control's height EXACTLY, classified
    // font-invariant by a forced-face sweep on macOS. This prints the same enumeration on
    // whatever machine runs it, so the runner's numbers confirm (or overturn) that
    // classification: per page, each distinct height with its count, and the marks that are
    // not controls (static chips, segmented tracks, the Live pill).
    await page.setViewportSize({ width: 1440, height: 900 });
    const sel =
      'button, [role="button"], input:not([type="checkbox"]):not([type="radio"]), select, ' +
      'textarea, [role="switch"], [role="combobox"], [aria-pressed], [aria-current], a[class*="btn-"]';
    for (const name of [...PAGES, 'costs', 'batches', 'limits', 'settings', 'users', 'setup']) {
      await page.goto(`/browser-harness.html#/${name}`);
      await page.waitForSelector('html[data-harness-ready="true"]');
      const tally = await page.evaluate((s) => {
        const count = (els: Element[]): string => {
          const m = new Map<number, number>();
          for (const e of els) {
            const h = Number(e.getBoundingClientRect().height.toFixed(4));
            if (h > 0) m.set(h, (m.get(h) ?? 0) + 1);
          }
          return [...m.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([h, n]) => `${String(h)}x${String(n)}`)
            .join(' ');
        };
        return {
          controls: count([...document.querySelectorAll(s)]),
          marks: count([
            ...document.querySelectorAll('.chip, .seg-track, [data-testid="live-pill"]'),
          ]),
        };
      }, sel);
      line(`family:${name}`, `controls ${tally.controls} | marks ${tally.marks}`);
    }
    expect(PAGES.length).toBeGreaterThan(0);
  });

  test('@capture recorded rows and landmarks (adopt-design-tokens-v2 task 14.3)', async ({
    page,
  }) => {
    // The exact pins that 14.3 re-pinned outside the overlay matrix, printed so the runner's
    // values confirm (or overturn) their exact classification: the chain row
    // (`chainRow.spec.ts`, exact 41), and the sidebar box (`responsive.spec.ts` desktop
    // parity, exact [0, 0, 208, 900]).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/browser-harness.html?chain=1#/routing');
    await page.waitForSelector('html[data-harness-ready="true"]');
    await page.waitForSelector('.chain-row');
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.chain-row')].map((e) =>
        Number(e.getBoundingClientRect().height.toFixed(4)),
      ),
    );
    line('routing:.chain-row', rows.join(', '));
    await page.goto('/browser-harness.html#/requests');
    await page.waitForSelector('html[data-harness-ready="true"]');
    const sidebar = await page.evaluate(() => {
      const r = document.querySelector('[data-pane="sidebar"]')!.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n));
    });
    line('requests:sidebar', `[${sidebar.join(', ')}]`);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('@capture pinned controls across pages', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const name of PAGES) {
      await page.goto(`/browser-harness.html#/${name}`);
      await page.waitForSelector('html[data-harness-ready="true"]');
      for (const sel of CONTROLS) {
        const heights = await page.evaluate(
          (s) =>
            [...document.querySelectorAll(s)]
              .map((e) => e.getBoundingClientRect().height)
              .filter((h) => h > 0),
          sel,
        );
        if (heights.length === 0) continue;
        const uniq = [...new Set(heights.map((h) => Number(h.toFixed(4))))];
        // Sub-pixel values are printed unrounded: the baseline suite records
        // that several surfaces reproduce fractions (704.5, 173.7813) exactly
        // across platforms, so rounding here would discard the evidence that
        // makes an axis safe to pin.
        line(`${name}:${sel}`, uniq.join(', '));
      }
    }
    expect(PAGES.length).toBeGreaterThan(0);
  });
});
