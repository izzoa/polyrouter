/** Overlays at narrow width, measured in a real browser (phase2-responsive-overlays,
 * group 9).
 *
 * Phase 1 could not make these assertions. Its containment check is document overflow, and
 * a `position: fixed` surface overhangs the viewport without adding any — measured: with
 * the 440px drawer hanging 50px off the left of a 390px viewport, `scrollWidth` and
 * `clientWidth` are both exactly 390. So the page check passed while a third of the drawer
 * was unreachable. These assert the surfaces themselves.
 */
import { expect, test, type Page } from '@playwright/test';
import { SURFACES, boxOf } from './overlays';

const NARROW = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
] as const;

async function open(page: Page): Promise<void> {
  await page.goto('/browser-harness.html');
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

for (const vp of NARROW) {
  test.describe(`overlays fit ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    for (const s of SURFACES) {
      test(`${s.name} is inside the viewport`, async ({ page }) => {
        test.setTimeout(25_000);
        await open(page);
        await s.open(page);
        await page.waitForTimeout(400);
        // Computed from the UNROUNDED rect: rounding x and width separately turns a
        // surface whose edge lands on 844.5 into one reported at 845, which is a rounding
        // artefact rather than an overflow. Half a pixel of tolerance for the same reason.
        const over = await page.evaluate(
          ([sel, vw, vh]) => {
            const el = document.querySelector(sel as string);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const T = 0.5;
            return {
              left: r.left < -T,
              right: r.right > (vw as number) + T,
              top: r.top < -T,
              bottom: r.bottom > (vh as number) + T,
              rect: [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10),
            };
          },
          [s.sel, vp.width, vp.height] as [string, number, number],
        );
        expect(over, `${s.name} not on screen`).not.toBeNull();
        const { rect, ...edges } = over ?? {};
        expect(edges, `${s.name} at ${JSON.stringify(rect)}`).toEqual({
          left: false,
          right: false,
          top: false,
          bottom: false,
        });
      });
    }

    test('the tallest sheet keeps all its content reachable', async ({ page }) => {
      // `newProvider` is the tallest form in the app: 878px at 320 wide, against a 568px
      // screen. Before this change its actions were 310px past the bottom of a FIXED
      // backdrop, so no scroll anywhere could reach them.
      //
      // Reachable, NOT "scrollable": as a full-width sheet the same form reflows shorter
      // and at 390x844 it simply fits, so demanding a scrollbar would fail for the right
      // reason at one size and the wrong reason at the other.
      await open(page);
      const s = SURFACES.find((x) => x.name === 'modal:newProvider');
      await s?.open(page);
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const c = document.querySelector('.modal-card');
        if (!c) return null;
        const overflows = c.scrollHeight > c.clientHeight + 1;
        return {
          overflows,
          // Overflow is only acceptable if the element can actually scroll it away.
          scrollable: getComputedStyle(c).overflowY === 'auto' || !overflows,
        };
      });
      expect(r?.scrollable, 'content overflows the sheet with no way to scroll it').toBe(true);
    });

    test('a sheet can be scrolled to its actions', async ({ page }) => {
      await open(page);
      const s = SURFACES.find((x) => x.name === 'modal:newProvider');
      await s?.open(page);
      await page.waitForTimeout(300);
      const reached = await page.evaluate(() => {
        const c = document.querySelector('.modal-card');
        if (!c) return null;
        c.scrollTop = c.scrollHeight;
        const last = c.lastElementChild?.getBoundingClientRect();
        const card = c.getBoundingClientRect();
        // The final row must land inside the sheet once scrolled to the end.
        return last ? last.bottom <= card.bottom + 1 && last.top >= card.top - 1 : null;
      });
      expect(reached, 'the last row was not reachable by scrolling the sheet').toBe(true);
    });
  });
}

test.describe('overlay controls meet the comfort floor', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // Phase 1's sweep walks PAGES, so it never rendered an overlay — the same blind spot
  // that let two unregistered dialogs ship. Its floor is applied by element rather than by
  // class, which should already reach inside a sheet; "should" is why this measures.
  for (const s of SURFACES) {
    test(`${s.name}`, async ({ page }) => {
      test.setTimeout(25_000);
      await open(page);
      await s.open(page);
      await page.waitForTimeout(300);
      const small = await page.evaluate((sel) => {
        const root = document.querySelector(sel as string);
        if (!root) return null;
        const FLOOR = 44;
        const out: { tag: string; cls: string; h: number; w: number }[] = [];
        for (const el of root.querySelectorAll<HTMLElement>(
          'button, select, textarea, input, a[href], [role="button"], [tabindex]:not([tabindex="-1"])',
        )) {
          // Exclusions carried over from phase 1's locked design: the switch keeps its
          // 30x17 visual and meets the floor through an expanded ::before hit area, and
          // checkbox/radio would be stretched rather than their tap area.
          if (el.classList.contains('toggle')) continue;
          const type = el.getAttribute('type');
          if (type === 'checkbox' || type === 'radio') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // not rendered
          if (r.height < FLOOR - 0.5) {
            out.push({ tag: el.tagName, cls: el.className, h: Math.round(r.height), w: Math.round(r.width) });
          }
        }
        return out;
      }, s.sel);
      expect(small, `${s.name}: controls below the 44px comfort floor`).toEqual([]);
    });
  }
});

test.describe('the on-screen keyboard', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /** Installs a fake `visualViewport` BEFORE the app mounts, so the real publisher reads
   * it and the real CSS consumes what it publishes — the whole chain, not a stub of it.
   * A real keyboard cannot be opened from a headless browser. */
  async function withKeyboard(page: Page, keyboardPx: number): Promise<void> {
    await page.addInitScript((kbd: number) => {
      const listeners = new Set<() => void>();
      const fake = {
        get width() { return window.innerWidth; },
        get height() { return window.innerHeight - (window as unknown as { __kbd: number }).__kbd; },
        offsetLeft: 0,
        offsetTop: 0,
        scale: 1,
        addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
      };
      (window as unknown as { __kbd: number }).__kbd = 0;
      (window as unknown as { __setKbd: (n: number) => void }).__setKbd = (n) => {
        (window as unknown as { __kbd: number }).__kbd = n;
        listeners.forEach((f) => { f(); });
      };
      (window as unknown as { __kbdTarget: number }).__kbdTarget = kbd;
      Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    }, keyboardPx);
  }

  test('a sheet lifts clear of the keyboard instead of sitting behind it', async ({ page }) => {
    await withKeyboard(page, 300);
    await open(page);
    const s = SURFACES.find((x) => x.name === 'modal:newAgent');
    await s?.open(page);
    await page.waitForTimeout(200);
    const before = await boxOf(page, '.modal-card');

    await page.evaluate(() => { (window as unknown as { __setKbd: (n: number) => void }).__setKbd(300); });
    await page.waitForTimeout(200);
    const after = await boxOf(page, '.modal-card');

    const lift = before[1] + before[3] - (after[1] + after[3]);
    expect(lift, 'the sheet did not rise by the keyboard height').toBe(300);
    // And it must still be fully on screen after lifting.
    expect(after[1]).toBeGreaterThanOrEqual(0);
  });

  test('the focused field stays visible above the keyboard', async ({ page }) => {
    await withKeyboard(page, 300);
    await open(page);
    const s = SURFACES.find((x) => x.name === 'modal:newAgent');
    await s?.open(page);
    await page.locator('.modal-card input').first().focus();
    await page.evaluate(() => { (window as unknown as { __setKbd: (n: number) => void }).__setKbd(300); });
    await page.waitForTimeout(250);
    const visible = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const vv = window.visualViewport;
      return vv ? r.bottom <= vv.offsetTop + vv.height && r.top >= vv.offsetTop : null;
    });
    expect(visible, 'the focused field was left underneath the keyboard').toBe(true);
  });

  test('the picker panel is not placed in the keyboard region — including when the keyboard arrives AFTER it opens', async ({ page }) => {
    // `measure()` runs once, on open. A keyboard raised afterwards is the ordinary case,
    // since the panel opens on focus and the keyboard follows it.
    await withKeyboard(page, 320);
    await open(page);
    const s = SURFACES.find((x) => x.name === 'picker');
    await s?.open(page);
    await page.waitForTimeout(200);
    await page.evaluate(() => { (window as unknown as { __setKbd: (n: number) => void }).__setKbd(320); });
    await page.waitForTimeout(250);
    const clear = await page.evaluate(() => {
      const p = document.querySelector('.mp-panel');
      const vv = window.visualViewport;
      if (!p || !vv) return null;
      return p.getBoundingClientRect().bottom <= vv.offsetTop + vv.height + 1;
    });
    expect(clear, 'the picker stayed in the region the keyboard occupies').toBe(true);
  });
});

test.describe('safe-area insets', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a device reporting no inset gains no dead space', async ({ page }) => {
    await open(page);
    const s = SURFACES.find((x) => x.name === 'modal:newAgent');
    await s?.open(page);
    await page.waitForTimeout(200);
    const pad = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.modal-card') as Element).paddingBottom,
    );
    expect(pad, 'headless reports no inset, so the padding must be the design value alone').toBe('20px');
  });

  test('a POSITIVE inset moves content clear of it', async ({ page }) => {
    // The decisive one. Headless Chrome always reports a zero inset, so the test above is
    // satisfied by an implementation that ignores insets entirely — which is why
    // `env()` is read once into `--safe-area-bottom` and substituted here.
    await open(page);
    const s = SURFACES.find((x) => x.name === 'modal:newAgent');
    await s?.open(page);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--safe-area-bottom', '34px');
    });
    await page.waitForTimeout(200);
    const pad = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.modal-card') as Element).paddingBottom,
    );
    // calc(20px + 34px) — additive, so the design's breathing room survives the inset
    // rather than being absorbed by it as `max()` would have done.
    expect(pad).toBe('54px');
  });

  test('the toast clears the inset too', async ({ page }) => {
    await open(page);
    const s = SURFACES.find((x) => x.name === 'toast');
    await s?.open(page);
    const before = (await boxOf(page, '.toast'))[1];
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--safe-area-bottom', '34px');
    });
    await page.waitForTimeout(200);
    const after = (await boxOf(page, '.toast'))[1];
    expect(before - after, 'the toast ignored the safe area').toBe(34);
  });
});

test.describe('pinch-zoom is not mistaken for a keyboard', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the published inset stays zero at every zoom level', async ({ page }) => {
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    const seen: Record<string, string> = {};
    // Continuous levels, not just integers: users pinch to arbitrary scales.
    for (const f of [1, 1.37, 1.5, 2.25, 2.5]) {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: f });
      await page.waitForTimeout(120);
      seen[String(f)] = await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--vv-occluded-bottom'),
      );
    }
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    // Without the `* scale` correction these read 422px and 563px at 2x and 3x — a sheet
    // would leap two-thirds up the screen for a user who merely pinched to read a value.
    expect(seen).toEqual({ '1': '0px', '1.37': '0px', '1.5': '0px', '2.25': '0px', '2.5': '0px' });
  });

  test('a sheet does not move when the user zooms or pans', async ({ page }) => {
    await open(page);
    const s = SURFACES.find((x) => x.name === 'modal:newAgent');
    await s?.open(page);
    await page.waitForTimeout(300);
    const before = await boxOf(page, '.modal-card');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 });
    await page.waitForTimeout(200);
    const after = await boxOf(page, '.modal-card');
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    expect(after, 'zooming moved the sheet').toEqual(before);
  });
});
