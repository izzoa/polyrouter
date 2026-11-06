/** Entry fields, measured (adopt-design-tokens-v2 task 8.1; dashboard-core "Entry controls
 * show help, invalid, read-only and disabled states", scenario "Typing on a phone does not
 * zoom the page"; DESIGN.md Inputs / Fields).
 *
 * Input text is 16px in the comfort context — below the narrow threshold and under a coarse
 * pointer — because a mobile browser zooms the page when a focused field's text is smaller,
 * and 13px (the Body role) at desktop. The comfort rule names the field ELEMENTS as well as
 * the classes, and no field carries an inline `font` any more, so a field's own class (the
 * Mono identifier fields at 12px, the 24px small select) cannot outrank it; the sweep below
 * reads every visible field on every page and in every overlay to hold that.
 *
 * EXACT: a computed `font-size` is a declared value, not text layout, so no face moves it.
 */
import { expect, test, type Page } from '@playwright/test';
import { SURFACES, harnessUrl } from './overlays';

const FIELDS =
  'input:not([type="checkbox"]):not([type="radio"]), select, textarea, [role="combobox"]';

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForSelector('html[data-harness-ready="true"]');
  await page.waitForSelector('[data-pane="sidebar"]');
}

/** The focused invite-email field's computed text size. */
async function focusedInviteSize(page: Page): Promise<string> {
  await open(page, '/browser-harness.html#/users');
  const email = page.locator('#f-ua-email');
  await email.scrollIntoViewIfNeeded();
  await email.focus();
  return email.evaluate((el) => {
    if (document.activeElement !== el) throw new Error('the invite email did not take focus');
    return getComputedStyle(el).fontSize;
  });
}

/** Every visible field in `scope` whose text is not `size`, named by its id or label. */
async function offSize(page: Page, scope: string | null, size: string): Promise<string[]> {
  return page.evaluate(
    ([sel, root, want]) => {
      const host = root === null ? document : document.querySelector(root);
      if (host === null) return [`scope ${root ?? ''} is not rendered`];
      return [...host.querySelectorAll<HTMLElement>(sel)]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => {
          const name =
            el.id !== ''
              ? `#${el.id}`
              : (el.getAttribute('aria-label') ?? `${el.tagName.toLowerCase()}.${el.className}`);
          return [name, getComputedStyle(el).fontSize] as const;
        })
        .filter(([, got]) => got !== want)
        .map(([name, got]) => `${name} is ${got}`);
    },
    [FIELDS, scope, size] as [string, string | null, string],
  );
}

/** Pages (and page states) that render fields, with how many the sweep must find. */
const PAGES: readonly { url: string; label: string }[] = [
  { url: '/browser-harness.html#/requests', label: 'requests (the agent filter)' },
  { url: '/browser-harness.html#/users', label: 'users (the invite email)' },
  { url: '/browser-harness.html#/settings', label: 'settings (body capture selects)' },
  { url: '/browser-harness.html#/setup', label: 'setup (agent step)' },
  { url: '/browser-harness.html?targets=1#/routing', label: 'routing (tiers & headers, targets)' },
];

test.describe('input text is 13px at desktop (1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a focused text input computes 13px', async ({ page }) => {
    expect(await focusedInviteSize(page)).toBe('13px');
  });
});

for (const ctx of [
  { name: 'below narrow (390x844)', use: { viewport: { width: 390, height: 844 } } },
  {
    name: 'under a coarse pointer (1440x900)',
    use: { viewport: { width: 1440, height: 900 }, hasTouch: true },
  },
] as const) {
  test.describe(`input text is 16px in the comfort context: ${ctx.name}`, () => {
    test.use(ctx.use);

    test('a focused text input computes 16px', async ({ page }) => {
      expect(await focusedInviteSize(page)).toBe('16px');
    });

    test('every visible field on every page and in every overlay computes 16px', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      let seen = 0;
      for (const p of PAGES) {
        await open(page, p.url);
        const count = await page.locator(FIELDS).count();
        seen += count;
        expect(await offSize(page, null, '16px'), `fields under 16px on ${p.label}`).toEqual([]);
      }
      for (const s of SURFACES) {
        if (s.narrowOnly === true && ctx.name.startsWith('under')) continue;
        await open(page, harnessUrl(s));
        await s.open(page);
        await page.waitForTimeout(250);
        seen += await page.locator(`${s.sel} :is(${FIELDS})`).count();
        expect(await offSize(page, s.sel, '16px'), `fields under 16px in ${s.name}`).toEqual([]);
      }
      // Not vacuous: the modals alone render well over a dozen fields.
      expect(seen, 'fields swept').toBeGreaterThan(20);
    });
  });
}

/** A field's message grows under it without moving its row's action off the fields' line, and
 * the invalid edge is drawn in Signal Red (task 8.2; DESIGN.md Inputs / Fields). */
test.describe('an invalid field keeps its row on one line (1440x900, task 8.2)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const row of [
    {
      name: 'the header-rule form',
      url: '/browser-harness.html#/routing',
      sel: '[data-testid="header-rule-form"]',
      action: 'Add',
      fields: ['#f-rf-value', '#f-rf-target'],
    },
    {
      name: 'the add-tier row',
      url: '/browser-harness.html#/routing',
      sel: '[data-testid="add-tier-row"]',
      action: 'Add tier',
      fields: ['#f-tf-key'],
    },
    {
      name: 'the invite form',
      url: '/browser-harness.html#/users',
      sel: 'form:has(#f-ua-email)',
      action: 'Invite',
      fields: ['#f-ua-email'],
    },
  ]) {
    test(`${row.name}: the action stays on the fields' line under a message`, async ({ page }) => {
      await open(page, row.url);
      const scope = page.locator(row.sel);
      for (const f of row.fields) {
        if ((await page.locator(f).evaluate((el) => el.tagName)) !== 'SELECT') {
          await page.locator(f).fill('');
        }
      }
      await scope.getByRole('button', { name: row.action, exact: true }).click();
      for (const f of row.fields) {
        await expect(page.locator(f)).toHaveAttribute('aria-invalid', 'true');
      }
      // Past any edge transition, so the computed edge is the settled one.
      await page.waitForTimeout(400);
      const read = await page.evaluate(
        ([sel, fields, action]) => {
          const root = document.querySelector(sel)!;
          const button = [...root.querySelectorAll('button')].find((b) =>
            (b.getAttribute('aria-label') ?? b.textContent ?? '').includes(action),
          )!;
          const probe = document.createElement('i');
          probe.style.color = 'var(--red)';
          document.body.append(probe);
          const red = getComputedStyle(probe).color;
          probe.remove();
          return {
            button: button.getBoundingClientRect().top,
            fields: fields.map((f) => {
              const el = document.querySelector<HTMLElement>(f)!;
              return {
                top: el.getBoundingClientRect().top,
                edge: getComputedStyle(el).borderTopColor,
              };
            }),
            red,
            notes: root.querySelectorAll('.field-error').length,
          };
        },
        [row.sel, row.fields, row.action] as [string, string[], string],
      );
      expect(read.notes, 'the messages rendered').toBe(row.fields.length);
      for (const f of read.fields) {
        expect(
          Math.abs(f.top - read.button),
          `${row.name}: tops ${String(f.top)} vs ${String(read.button)}`,
        ).toBeLessThan(0.5);
        expect(f.edge, `${row.name}: the invalid edge`).toBe(read.red);
      }
    });
  }
});
