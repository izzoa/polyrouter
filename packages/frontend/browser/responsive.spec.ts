/** Responsive layout, measured in a real browser (group 8).
 *
 * The unit suites assert DECLARATIONS because happy-dom performs no layout. These assert
 * the actual rendered result: that no page overflows its root at any locked viewport, that
 * in-flow content stays inside its pane, that hit targets meet their floor, and that every
 * destination stays reachable at phone width.
 *
 * The fixture (`src/browserHarness.tsx`) mounts the real App against `FakeApiClient` with
 * adversarial content — a 26-character model id, a 50-character email — because short
 * placeholder data would make every overflow assertion pass for the wrong reason.
 */
import { expect, test, type Page } from '@playwright/test';

/** The locked verification matrix (STYLESEED.md § Responsive). Dimensions, not widths:
 * a short viewport is what proves the account menu stays reachable. */
const MATRIX = [
  { name: '320x568', width: 320, height: 568 }, // WCAG 2.2 reflow reference width
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1025x768', width: 1025, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
] as const;

const PAGES = [
  'overview',
  'requests',
  'costs',
  'agents',
  'providers',
  'routing',
  'limits',
  'settings',
  'users',
  'setup',
] as const;

async function open(page: Page, hash = '', query = ''): Promise<void> {
  await page.goto(`/browser-harness.html${query}${hash}`);
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

/** Switch the Routing page's rail to a section (section-routing-rail). Its cards MOUNT
 * AND UNMOUNT with the section, so a test asserting on a Tuning or Rules card must
 * switch first — otherwise it fails as a `waitForSelector` TIMEOUT on an element that
 * is simply not in the DOM, which reads like flake and is not. */
async function openRoutingSection(page: Page, label: string): Promise<void> {
  const seg = page
    .locator('[data-testid="routing-sections"] .rs-seg')
    .filter({ hasText: new RegExp(`^${label}$`) });
  await seg.waitFor({ state: 'visible' });
  await seg.click();
  await expect(seg, `Routing section "${label}" did not become active`).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

/** Every distinct rendered state of a page that the all-page sweeps must measure.
 * Only `routing` has more than one: sectioning its rail (section-routing-rail) means
 * the initially-rendered DOM is Auto ALONE — no Auto-performance range control, no
 * calibration or learning actions, no header-rules inputs. A sweep that measures only
 * what `goto` paints would silently shrink to Auto and stop guarding the rest, which
 * is exactly the failure the comfort-target sweep exists to prevent (see :197).
 * Yields a label per state, with the page already switched to it. */
async function* pageStates(page: Page, name: string): AsyncGenerator<string> {
  await page.goto(`/browser-harness.html#/${name}`);
  await page.waitForSelector('html[data-harness-ready="true"]');
  const sections: string[] = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="routing-sections"] .rs-seg')].map((b) =>
      (b.textContent ?? '').trim(),
    ),
  );
  if (sections.length === 0) {
    // Not a silent fallback on `routing`: if the rail's testid is renamed the sweeps
    // would quietly go back to measuring Auto alone and still report green — the exact
    // vacuous pass this generator exists to prevent.
    expect(name, 'the Routing rail exposes no sections — the sweep would cover Auto only').not.toBe(
      'routing',
    );
    yield name;
    return;
  }
  for (const label of sections) {
    await openRoutingSection(page, label);
    yield `${name}/${label}`;
  }
}

for (const vp of MATRIX) {
  test.describe(`viewport ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('no page overflows the document horizontally', async ({ page }) => {
      await open(page);
      for (const name of PAGES) {
        for await (const state of pageStates(page, name)) {
          const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          expect(
            overflow.scrollWidth,
            `${state} overflows at ${vp.name} (${String(overflow.scrollWidth)} > ${String(overflow.clientWidth)})`,
          ).toBeLessThanOrEqual(overflow.clientWidth + 1);
        }
      }
    });

    test('in-flow content stays inside its pane, on every page', async ({ page }) => {
      for (const name of PAGES) {
        for await (const state of pageStates(page, name)) {
          const escapes = await page.evaluate(() => {
            const pane = document.querySelector('[data-pane="content"]');
            if (!pane) return ['no content pane'];
            const bounds = pane.getBoundingClientRect();
            const out: string[] = [];
            for (const el of pane.querySelectorAll('*')) {
              const s = getComputedStyle(el);
              if (s.position === 'fixed' || s.position === 'absolute') continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0) continue;
              if (r.right > bounds.right + 1) {
                const cls = el.className.toString().trim();
                const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
                out.push(
                  `${el.tagName}${cls ? '.' + cls.split(/\s+/).join('.') : ''}` +
                    ` over=${String(Math.round(r.right - bounds.right))}px text="${text}"`,
                );
              }
            }
            return out.slice(0, 5);
          });
          expect(escapes, `content escaping its pane on ${state} at ${vp.name}`).toEqual([]);
        }
      }
    });
  });
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('every destination is reachable in one of the two rail states', async ({ page }) => {
    await open(page);
    const toggle = page.locator('.rs-nav-toggle');
    await expect(toggle).toBeVisible();

    // `toBeVisible()` is not enough, and this is not hypothetical: the toggle once
    // rendered at x=47..71 inside a rail ending at 56 — a non-empty box, so "visible",
    // but clipped and untappable, which made the expanded nav (and with it the account
    // menu) unreachable. Containment is the property that actually matters.
    const fits = await page.evaluate(() => {
      const t = document.querySelector('.rs-nav-toggle')?.getBoundingClientRect();
      const r = document.querySelector('[data-pane="sidebar"]')?.getBoundingClientRect();
      if (!t || !r) return null;
      return { toggleRight: Math.round(t.right), railRight: Math.round(r.right) };
    });
    expect(fits).not.toBeNull();
    expect(
      fits?.toggleRight,
      'the rail toggle renders outside the rail and cannot be tapped',
    ).toBeLessThanOrEqual((fits?.railRight ?? 0) + 1);

    await toggle.click();
    const items = page.locator('#sidebar-nav .nav-item');
    const names = await items.allTextContents();
    for (const expected of ['Overview', 'Requests', 'Costs', 'Agents', 'Settings', 'Users']) {
      expect(names.join(' '), `${expected} unreachable at phone width`).toContain(expected);
    }
    // The account menu and setup guide live in the expanded state — the shell contract
    // requires them to stay reachable somewhere.
    await expect(page.locator('.rs-sidebar-footer')).toBeVisible();
  });

  test('the rail reclaims the viewport when collapsed', async ({ page }) => {
    await open(page);
    const width = await page
      .locator('[data-pane="sidebar"]')
      .evaluate((el) => el.getBoundingClientRect().width);
    // 208px would be 53% of a 390px screen; the locked rail is 56px.
    expect(width).toBeLessThanOrEqual(60);
  });

  test('the requests table renders as stacked records, not a 9-column grid', async ({ page }) => {
    await open(page, '#/requests');
    const shape = await page.evaluate(() => {
      const row = document.querySelector('.req-row');
      const head = document.querySelector('.table-head');
      const label = document.querySelector('.rs-cell-label');
      return {
        row: row ? getComputedStyle(row).display : null,
        head: head ? getComputedStyle(head).display : null,
        label: label ? getComputedStyle(label).display : null,
      };
    });
    expect(shape.row).toBe('block');
    expect(shape.head).toBe('none');
    expect(shape.label).not.toBe('none');
  });

  test('every rendered control meets the comfort target, on every page', async ({ page }) => {
    // Identified SEMANTICALLY, not by a class list. The earlier version checked six
    // hand-picked classes on one page and passed while bare `<button>`/`<select>` controls
    // with inline padding shipped at 22-28px — a class list can only ever cover controls
    // somebody remembered to class.
    for (const name of PAGES) {
      for await (const state of pageStates(page, name)) {
        const small = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [role="menuitem"]',
          )) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue; // not rendered in this state
            // Locked exceptions (STYLESEED.md): the switch keeps its 30x17 visual and meets
            // the floor through an expanded hit area, asserted separately below; checkboxes
            // and radios would be stretched rather than given a bigger tap area.
            if (el.classList.contains('toggle')) continue;
            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
              continue;
            if (r.height < 44) {
              out.push(
                `${el.tagName}.${el.className.toString().split(/\s+/)[0] ?? ''}` +
                  ` ${String(Math.round(r.width))}x${String(Math.round(r.height))}`,
              );
            }
          }
          return out;
        });
        expect(small, `controls under the comfort target on ${state}`).toEqual([]);
      }
    }
  });

  test('icon-only controls meet the floor in BOTH axes', async ({ page }) => {
    // A minimum target is two-dimensional. These have no text to widen them — the rail
    // toggle shipped at 24x44 before this was checked.
    await open(page, '#/routing');
    const narrow = await page.evaluate(() => {
      const out: string[] = [];
      for (const sel of ['.rs-nav-toggle', '.icon-x', '.drag-handle', '.drawer-close']) {
        for (const el of document.querySelectorAll<HTMLElement>(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.width < 44) out.push(`${sel} w=${String(Math.round(r.width))}`);
        }
      }
      return out;
    });
    expect(narrow, 'icon-only controls under the inline-axis floor').toEqual([]);
  });

  test('the switch meets the floor by hit area, not by its box', async ({ page }) => {
    // Its 30x17 visual is locked design. Conformance therefore has to be established by
    // hit-testing — measuring the rectangle would report a false failure.
    await open(page, '#/routing');
    const hit = await page.evaluate(() => {
      const t = document.querySelector('.toggle');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      const owns = (dx: number, dy: number): boolean => {
        const el = document.elementFromPoint(r.left + r.width / 2 + dx, r.top + r.height / 2 + dy);
        return el === t || t.contains(el as Node);
      };
      return { above: owns(0, -18), below: owns(0, 18), right: owns(20, 0) };
    });
    expect(hit).not.toBeNull();
    expect(hit?.above, 'switch hit area does not extend above its box').toBe(true);
    expect(hit?.below, 'switch hit area does not extend below its box').toBe(true);
    expect(hit?.right, 'switch hit area does not extend beside its box').toBe(true);
  });

  test('expanding the nav then leaving narrow width does not strand the dashboard', async ({
    page,
  }) => {
    // The production lock-up: above 768px the toggle is display:none, so an expanded nav
    // that survives a resize leaves a full-screen scrim over inert content with nothing
    // able to dismiss it. Rotating a phone to landscape is enough to reach it.
    await open(page);
    await page.locator('.rs-nav-toggle').click();
    await expect(page.locator('.rs-nav-scrim')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(150);

    await expect(page.locator('.rs-nav-scrim')).toHaveCount(0);
    const inert = await page.evaluate(() =>
      document.querySelector('[data-pane="content"]')?.hasAttribute('inert'),
    );
    expect(inert, 'the content pane is still inert after leaving narrow width').toBe(false);
  });
});

test.describe('coarse pointer above the narrow threshold', () => {
  // A 1024px tablet is touch-first but nowhere near `narrow` — the branch that exists
  // solely for this case would otherwise never be exercised.
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

  test('controls still meet the comfort target', async ({ page }) => {
    await open(page, '#/agents');
    const heights = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.btn-ghost')]
        .map((el) => el.getBoundingClientRect().height)
        .filter((h) => h > 0),
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
  });
});

test.describe('non-admin at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('cannot reach the admin-only Users area', async ({ page }) => {
    await open(page, '', '?role=member');
    await page.locator('.rs-nav-toggle').click();
    const names = await page.locator('#sidebar-nav .nav-item').allTextContents();
    expect(names.join(' ')).not.toContain('Users');
  });
});

test.describe('desktop width, fine pointer', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('every control meets the 24px floor at desktop width', async ({ page }) => {
    // Added with narrow-geometry-tolerances, and it closes a PRE-EXISTING gap rather than
    // only replacing what left the parity set.
    //
    // STYLESEED.md locks `target-base` at 24px in BOTH axes as the "minimum hit target at
    // EVERY width (WCAG 2.5.8 AA)" — but every comprehensive floor assertion above runs
    // inside `phone width` at 390x844, and the only other one runs at 1024x768 with
    // `hasTouch` against `.btn-ghost` alone. At 1440x900 with a fine pointer, nothing
    // enforced the floor at all. `.endpoint-chip`'s entry in the v0.11.0 parity set was
    // incidentally its only height assertion here, so removing it without this would have
    // deleted coverage.
    //
    // 24, not the 44px comfort target: 44 is `target-comfort`, which the lock scopes to
    // below `narrow` and to coarse pointers. Desktop with a mouse is held to the base floor.
    for (const name of PAGES) {
      await page.goto(`/browser-harness.html#/${name}`);
      await page.waitForSelector('html[data-harness-ready="true"]');
      const small = await page.evaluate(() => {
        const out: string[] = [];
        // Semantic, matching the phone-width test — a class list only ever covers controls
        // somebody remembered to class.
        for (const el of document.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [role="menuitem"]',
        )) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // not rendered in this state
          // The same locked exceptions the phone-width assertion carries.
          if (el.classList.contains('toggle')) continue;
          if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
            continue;
          if (r.height < 24 || r.width < 24) {
            out.push(
              `${el.tagName}.${el.className.toString().split(/\s+/)[0] ?? ''}` +
                ` ${String(Math.round(r.width))}x${String(Math.round(r.height))}`,
            );
          }
        }
        return out;
      });
      expect(small, `controls under the 24px base floor on ${name} at desktop width`).toEqual([]);
    }
  });
});

test.describe('desktop parity against the released v0.11.0 baseline (task 8.8)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** Measured by building v0.11.0 in a git worktree, serving it beside this build, and
   * diffing landmark geometry and control heights across all nine pages at 1440x900.
   * Provenance and the full diff are in the change's `measurements.md`.
   *
   * The comparison is pinned as NUMBERS rather than run against the tag on every CI run:
   * a worktree build per run is slow, and the tag is a fixed point — re-deriving it would
   * produce the same values or mean someone rewrote history. */
  const BASELINE = {
    // Landmark geometry that must NOT move. [x, y, width, height]
    sidebar: [0, 0, 208, 900],
    // Controls already at or above the 24px floor. These values were read from BOTH
    // builds and are identical — measured in the real app, not from a control probe in
    // isolation, since a class renders at a different height depending on its content.
    //
    // `.endpoint-chip` LEFT this set in narrow-geometry-tolerances. It was 28 here and is 27
    // now, because it contained `⧉` — a character no bundled font provides, drawn from a
    // platform symbol face — and replace-fallback-symbol-glyphs deliberately swapped it for an
    // SVG icon. 28 is NOT stale: it is a correct record of what v0.11.0 rendered, which is the
    // whole point of this set. Rewriting it to 27 would destroy that fact while leaving the
    // v0.11.0 provenance above it, and would assert nothing anyway — ±2 passes at either value.
    // A control we intentionally changed simply does not belong in a list of controls asserted
    // NOT to have changed. Its minimum size is covered by "every control meets the 24px floor
    // at desktop width" below, which was added with this removal because nothing else asserted
    // it above the narrow threshold.
    unchangedControls: {
      '.nav-item': 31,
      '.req-row': 35,
    },
  } as const;

  test('the sidebar and the untouched controls are byte-identical to v0.11.0', async ({ page }) => {
    await open(page, '#/requests');
    const now = await page.evaluate(() => {
      const box = (sel: string): number[] | null => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      };
      const h = (sel: string): number | null => {
        const e = document.querySelector(sel);
        return e ? Math.round(e.getBoundingClientRect().height) : null;
      };
      return {
        sidebar: box('[data-pane="sidebar"]'),
        controls: {
          '.nav-item': h('.nav-item'),
          '.btn-primary': h('.btn-primary'),
          '.endpoint-chip': h('.endpoint-chip'),
          '.req-row': h('.req-row'),
        } as Record<string, number | null>,
      };
    });

    // The sidebar's box is font-invariant — fixed width, full viewport height — so it stays
    // an exact assertion.
    expect(now.sidebar, 'the sidebar moved at desktop width').toEqual([...BASELINE.sidebar]);
    for (const [sel, expected] of Object.entries(BASELINE.unchangedControls)) {
      if (now.controls[sel] === null) continue; // not present on this page
      // ±2. The earlier note here said the app "bundles no `@font-face`" so each platform
      // falls back differently — that is false: Geist is vendored and loaded (see
      // `overlayBaseline.spec.ts`'s header for the full correction). The ±2 was sized against
      // forced face swaps, which do not occur.
      //
      // It is kept anyway, and honestly: `.nav-item` and `.req-row` measure 31 and 35 on
      // macOS, Ubuntu 22.04 and Ubuntu 24.04 alike, but CI has never disclosed their values —
      // it reports only assertions that FAIL, and these pass. A pass is not a measurement, so
      // narrowing this would be inference. Retiring it needs a capture-only CI run.
      expect(
        Math.abs(now.controls[sel]! - expected),
        `${sel} changed height at desktop (${expected} → ${now.controls[sel]})`,
      ).toBeLessThanOrEqual(2);
    }
  });

  test('.req-row did not grow — the cell wrapper must contribute no box at desktop', async ({
    page,
  }) => {
    // Regression guard for a defect this baseline actually caught: wrapping each cell to
    // carry its stacked-view label added a layout box, taking every request row from 35px
    // to 51px. `display: contents` removes the wrapper's box at desktop; if that is ever
    // dropped, this fails.
    await open(page, '#/requests');
    const display = await page.evaluate(() => {
      const cell = document.querySelector('.rs-cell');
      return cell ? getComputedStyle(cell).display : null;
    });
    expect(display).toBe('contents');
  });
});

test.describe('overlay paint order follows the layer registry', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('z-index is derived from the registry, not hand-assigned', async ({ page }) => {
    // Only a real browser can check this. The element carrying z-index is usually NOT the
    // registered dialog root — the modal's is its PARENT backdrop, the drawer's a SIBLING —
    // and an ancestor stacking context can trap a child's z-index entirely.
    await open(page, '#/requests');
    await page.locator('button.req-row').first().click();
    await expect(page.locator('.drawer')).toBeVisible();

    const z = await page.evaluate(() => {
      const of = (s: string): number | null => {
        const el = document.querySelector(s);
        return el ? Number(getComputedStyle(el).zIndex) : null;
      };
      return { backdrop: of('.overlay'), surface: of('.drawer') };
    });
    // One open layer → the first slot of the band, backdrop then surface.
    expect(z.backdrop).toBe(40);
    expect(z.surface).toBe(41);
    expect(z.surface! - z.backdrop!, 'a layer is a backdrop AND a surface').toBe(1);
  });

  test('an open drawer isolates the page beneath it, including the nav', async ({ page }) => {
    // Consequence of deriving paint order rather than hand-assigning it: the drawer is a
    // modal layer, so its backdrop covers the sidebar and the rail toggle cannot be
    // clicked through it. That is correct isolation — and it means the expanded nav and an
    // open drawer can no longer be reached together through the UI at all, which bears on
    // the phase-2 coexistence question recorded in the change's design.
    await open(page, '#/requests');
    await page.locator('button.req-row').first().click();
    await expect(page.locator('.drawer')).toBeVisible();

    const covered = await page.evaluate(() => {
      const t = document.querySelector('.rs-nav-toggle');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && !t.contains(hit) && hit !== t;
    });
    expect(covered, 'the drawer backdrop does not cover the sidebar').toBe(true);
  });

  test('a popover opened inside a dialog paints above it', async ({ page }) => {
    // Task 4.3's other half. The combobox lives inside the Routing tier editor; its panel
    // used to carry a hardcoded z-index 55 chosen to sit above modals. It now derives from
    // the registry, so this asserts the DERIVATION produces the same outcome — by
    // hit-testing, because an ancestor stacking context can trap a child's z-index and a
    // declaration check would not notice.
    test.setTimeout(30_000);
    await open(page, '#/routing');
    const input = page.locator('.mp-input').first();
    if ((await input.count()) === 0) test.skip(true, 'no tier editor on this fixture');
    await input.click();
    const panel = page.locator('.mp-panel').first();
    await expect(panel).toBeVisible();

    const result = await page.evaluate(() => {
      const p = document.querySelector('.mp-panel');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.left + r.width / 2),
        Math.round(r.top + 10),
      );
      return {
        panelOnTop: hit !== null && (p.contains(hit) || hit === p),
        z: Number(getComputedStyle(p).zIndex),
      };
    });
    expect(result, 'picker panel missing').not.toBeNull();
    expect(result?.panelOnTop, 'the popover is not hit-testing on top').toBe(true);
    // Derived, not the old hardcoded 55.
    expect(result?.z).toBeLessThan(60);
  });

  test('no layer can overtake the toast', async ({ page }) => {
    // The band is bounded on purpose: the toast is not a dismissible layer and must stay
    // above everything, so a dynamically-ordered layer must never reach it.
    await open(page);
    await page.locator('.rs-nav-toggle').click();
    await page.waitForTimeout(200);
    const zs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.overlay, .drawer, .modal-backdrop')]
        .map((el) => Number(getComputedStyle(el).zIndex))
        .filter((n) => Number.isFinite(n)),
    );
    for (const z of zs) expect(z, 'a layer reached the toast band').toBeLessThan(60);
  });
});

/** The Auto-performance Workload-mix rows (fix-workload-mix-phone-overflow).
 *
 * The whole-page "in-flow content stays inside its pane" assertion above catches the
 * shipped 320px overflow on the DEFAULT fixture; these tests add the parts an
 * element-box page sweep cannot: they assert the actual text GLYPHS (via Range rects,
 * not only element boxes) stay inside the pane, that no required figure is clipped or
 * ellipsised to fit, and that every honesty state the view-model can emit — routed
 * counts, `— unpriced`, free `$0`, priced, `N unpriced`, and attempt-only `0%` — is
 * present at phone width. The default fixture carries only some of those states, so the
 * `?workload=boundary` / `?workload=attempt-only` variants supply the rest. A companion
 * block pins that desktop rendering does NOT reflow. */

/** Geometry + visibility state of everything under `selector`, measured against the
 * content pane. Reports content that ESCAPES the pane (element boxes AND text-node Range
 * rects, so glyphs spilling a container whose own box fits are caught), content that is
 * CLIPPED (overflow hidden/clip or text-overflow ellipsis), and content that is HIDDEN
 * while still carrying text (display:none / visibility:hidden|collapse, or a non-empty
 * text node with a zero-area range). The hidden check matters because a required figure
 * removed from layout still lives in `textContent`: without it a "satisfy the box check
 * by hiding the value" fix would pass, which the workload-mix honesty contract forbids. */
async function paneOverflow(
  page: Page,
  selector: string,
): Promise<{ count: number; escapes: string[]; clipped: string[]; hidden: string[] }> {
  return page.evaluate((sel) => {
    const pane = document.querySelector('[data-pane="content"]');
    if (!pane) return { count: 0, escapes: ['no content pane'], clipped: [], hidden: [] };
    const bound = pane.getBoundingClientRect();
    const roots = [...document.querySelectorAll(sel)];
    const escapes: string[] = [];
    const clipped: string[] = [];
    const hidden: string[] = [];
    const over = (right: number): boolean => right > bound.right + 1;
    const short = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 30);
    for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const s = getComputedStyle(el);
        if (s.position === 'fixed' || s.position === 'absolute') continue;
        const text = (el.textContent ?? '').trim();
        // Hidden-but-present: removed from layout yet still in textContent.
        if (
          text.length > 0 &&
          (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse')
        ) {
          hidden.push(
            `${el.tagName} display=${s.display} visibility=${s.visibility} "${short(el.textContent ?? '')}"`,
          );
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width > 0 && over(r.right)) {
          escapes.push(
            `${el.tagName} over=${String(Math.round(r.right - bound.right))}px "${short(el.textContent ?? '')}"`,
          );
        }
        const hides = s.overflowX === 'hidden' || s.overflowX === 'clip';
        if ((hides || s.textOverflow === 'ellipsis') && text.length > 0) {
          clipped.push(
            `${el.tagName} overflowX=${s.overflowX} textOverflow=${s.textOverflow} "${short(el.textContent ?? '')}"`,
          );
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.textContent ?? '').trim();
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        // A non-empty text node with a zero-area range is collapsed / hidden.
        if (r.width === 0 && r.height === 0) {
          hidden.push(`TEXT zero-area "${short(n.textContent ?? '')}"`);
          continue;
        }
        if (over(r.right)) {
          escapes.push(
            `TEXT over=${String(Math.round(r.right - bound.right))}px "${short(n.textContent ?? '')}"`,
          );
        }
      }
    }
    return {
      count: roots.length,
      escapes: escapes.slice(0, 10),
      clipped: clipped.slice(0, 10),
      hidden: hidden.slice(0, 10),
    };
  }, selector);
}

/** The normalized text of every workload-mix row, in DOM order, for row-specific
 * assertions (a state must be present ON ITS OWN row, not merely somewhere on the page). */
async function workloadRowTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="workload-row"]')].map((r) =>
      (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );
}

const ROW = '[data-testid="workload-row"]';

test.describe('Workload-mix rows at phone width', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('the default fixture rows stay inside the pane, whole and unclipped', async ({ page }) => {
    await open(page, '#/routing');
    await openRoutingSection(page, 'Tuning'); // the mix lives in Auto performance
    await page.waitForSelector(ROW);
    const geom = await paneOverflow(page, ROW);
    const texts = await workloadRowTexts(page);
    // The default fixture is none / code / structured (see DEFAULT_AUTO_PERF): the
    // long none label, and `code` carrying the "$1.3100 · 1 unpriced" qualifier.
    expect(geom.count).toBe(3);
    const noneRow = texts.find((t) => t.includes('no specialist workload'));
    const codeRow = texts.find((t) => t.startsWith('code'));
    expect(noneRow, 'the long none-label row is present').toBeTruthy();
    expect(codeRow ?? '', 'the code row keeps its partial-unpriced qualifier').toContain(
      '1 unpriced',
    );
    expect(geom.hidden, 'no required workload figure may be hidden').toEqual([]);
    expect(geom.clipped, 'no required workload figure may be clipped or ellipsised').toEqual([]);
    expect(geom.escapes, 'workload rows escape the pane at 320px').toEqual([]);
  });

  test('every pricing / routing state stays inside the pane', async ({ page }) => {
    await open(page, '#/routing', '?workload=boundary');
    await openRoutingSection(page, 'Tuning');
    await page.waitForSelector(ROW);
    const geom = await paneOverflow(page, ROW);
    const texts = await workloadRowTexts(page);
    expect(geom.count).toBe(5);
    const codeRow = texts.find((t) => t.startsWith('code')) ?? '';
    const visionRow = texts.find((t) => t.startsWith('vision')) ?? '';
    const structuredRow = texts.find((t) => t.startsWith('structured')) ?? '';
    const noneRow = texts.find((t) => t.includes('no specialist workload')) ?? '';
    const writingRow = texts.find((t) => t.startsWith('writing')) ?? '';
    // Each honesty state is present ON ITS OWN row — not merely somewhere on the page.
    expect(codeRow, 'routed count on the code row').toContain('7 routed');
    expect(codeRow, 'ordinary priced spend on the code row').toContain('$12.3400');
    expect(visionRow, 'null spend renders a dash on the vision row').toContain('—');
    expect(visionRow, 'null spend renders "unpriced" on the vision row').toContain('unpriced');
    expect(structuredRow, 'partial-pricing qualifier on the structured row').toContain(
      '1 unpriced',
    );
    expect(noneRow, 'free spend renders $0 on the none row').toContain('$0.0000');
    expect(noneRow, 'a free $0 carries NO unpriced qualifier').not.toContain('unpriced');
    expect(writingRow, 'a request-zero attempt-only class shows a 0% share').toContain('0%');
    expect(geom.hidden, 'no required workload figure may be hidden').toEqual([]);
    expect(geom.clipped, 'no required workload figure may be clipped or ellipsised').toEqual([]);
    expect(geom.escapes, 'a workload state escapes the pane at 320px').toEqual([]);
  });

  test('the attempt-only state renders its row and note inside the pane', async ({ page }) => {
    await open(page, '#/routing', '?workload=attempt-only');
    await openRoutingSection(page, 'Tuning');
    await page.waitForSelector('[data-testid="workload-mix"]');
    const note = await page.locator('[data-testid="workload-mix-attempt-only"]').textContent();
    expect(note, 'the attempt-only disclosure must render, not the empty affordance').toContain(
      'attempt spend but no classified parent requests',
    );
    const rowGeom = await paneOverflow(page, ROW);
    const noteGeom = await paneOverflow(page, '[data-testid="workload-mix-attempt-only"]');
    const texts = await workloadRowTexts(page);
    expect(rowGeom.count).toBe(1);
    expect(texts[0] ?? '', 'the attempt-only row shows a 0% share').toContain('0%');
    expect(rowGeom.hidden, 'the attempt-only row hides a figure').toEqual([]);
    expect(rowGeom.clipped, 'the attempt-only row clips a figure').toEqual([]);
    expect(rowGeom.escapes, 'the attempt-only row escapes the pane at 320px').toEqual([]);
    expect(
      noteGeom.hidden.concat(noteGeom.escapes),
      'the attempt-only note escapes the pane',
    ).toEqual([]);
  });
});

for (const vp of [
  { name: '1025x768', width: 1025, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
] as const) {
  test.describe(`Workload-mix rows keep their one-line desktop layout @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    // Direct Routing-page parity: the existing v0.11.0 baseline suite only opens Requests,
    // so nothing else proves the fix stays narrow-only here. Holds before AND after the
    // `rs-wrap` addition, since that class contributes nothing above 768px.
    test('rows stay a single non-wrapping flex line with unchanged typography', async ({
      page,
    }) => {
      await open(page, '#/routing');
      await openRoutingSection(page, 'Tuning');
      await page.waitForSelector('[data-testid="workload-row"]');
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="workload-row"]')].map((row) => {
          const s = getComputedStyle(row);
          const kids = [...row.children];
          const rowH = row.getBoundingClientRect().height;
          const maxKidH = Math.max(...kids.map((k) => k.getBoundingClientRect().height));
          const first = kids[0];
          const second = kids[1];
          return {
            display: s.display,
            flexWrap: s.flexWrap,
            gap: s.gap,
            fontSize: s.fontSize,
            lineHeight: s.lineHeight,
            childCount: kids.length,
            // One flex line: the row is no taller than its tallest child. A wrapped
            // container would stack a second line and exceed it. (align-items:center
            // means child TOPS legitimately differ, so height — not top — is the test.)
            oneFlexLine: rowH <= maxKidH + 1,
            firstIsLabel: !!first && !first.classList.contains('mono'),
            secondIsMono: !!second && second.classList.contains('mono'),
          };
        }),
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.display).toBe('flex');
        expect(r.flexWrap, 'desktop workload rows must not reflow').toBe('nowrap');
        expect(r.gap).toBe('10px');
        expect(r.fontSize).toBe('11px');
        expect(r.lineHeight).toBe('18.7px');
        expect(r.childCount).toBe(4);
        expect(r.oneFlexLine, 'the row stays a single flex line at desktop').toBe(true);
        expect(r.firstIsLabel, 'the class label leads the row').toBe(true);
        expect(r.secondIsMono, 'the mono stat span follows the label').toBe(true);
      }
    });
  });
}
