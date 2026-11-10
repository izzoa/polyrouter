/** The page itself never scrolls (fix: a wheel over the topbar scrolled the app off a blank
 * page).
 *
 * The shell is one window-high box that scrolls nothing; the sidebar and `<main>` scroll
 * inside it. The request tables carry `.sr-only` text in their token cells — absolutely
 * positioned, with no positioned ancestor — so each box belonged to the initial containing
 * block: the shell's `overflow: clip` did not clip it and `<main>` did not scroll it, and it
 * stretched the DOCUMENT to where the row sat (Overview ~1100px, Requests ~1900px in a 640px
 * window). A wheel over anything that is not itself a scroll container (the topbar) then
 * scrolled the document, lifting the whole app and leaving the bottom of the window blank.
 *
 * Measured on every page, at a short desktop window and at phone width, by the document's
 * own scroll height and by the wheel that exposed it.
 */
import { expect, test } from '@playwright/test';

const PAGES = [
  'overview',
  'requests',
  'batches',
  'costs',
  'agents',
  'providers',
  'routing',
  'limits',
  'settings',
  'users',
] as const;

const VIEWPORTS = [
  { width: 1288, height: 640 },
  { width: 390, height: 844 },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`the page does not scroll at ${String(vp.width)}x${String(vp.height)}`, () => {
    test.use({ viewport: vp });

    for (const page of PAGES) {
      test(`${page}: the document is one window high and a wheel over the topbar moves nothing`, async ({
        page: p,
      }) => {
        await p.goto(`/browser-harness.html?usage=1#/${page}`);
        await p.waitForSelector('html[data-harness-ready="true"]');
        await p.waitForTimeout(250);

        const doc = await p.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
        }));
        expect(doc.scrollHeight, `${page}: the document's scroll height`).toBeLessThanOrEqual(
          doc.innerHeight,
        );

        const topbar = await p.evaluate(() => {
          const r = document.querySelector('main')!.previousElementSibling!.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await p.mouse.move(topbar.x, topbar.y);
        await p.mouse.wheel(0, 600);
        await p.waitForTimeout(200);
        expect(await p.evaluate(() => window.scrollY), `${page}: the window's scroll`).toBe(0);
      });
    }
  });
}
