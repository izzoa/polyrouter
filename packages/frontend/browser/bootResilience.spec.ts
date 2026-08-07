/** The dashboard starts on a host whose locale tag `Intl` rejects, and never shows a blank
 *  page when it cannot start at all (fix-nonstandard-locale-boot-crash).
 *
 * The defect: uPlot runs `new Intl.NumberFormat(navigator.language)` at MODULE SCOPE
 * (`uplot@1.6.32 dist/uPlot.esm.js:442`). It is pulled in eagerly — index.tsx → App → Overview
 * → Chart → uplot — so a host reporting a non-canonical tag throws while the module graph is
 * being evaluated, before `render()` is ever reached. `#root` stays empty and the user sees
 * white, with the only evidence in a console nobody is watching.
 *
 * These run against the REAL `index.html`, not the harness. That is deliberate: the harness
 * has its own entry module, so a test that only covered it would not notice if the guard's
 * import were reordered in `index.tsx` — the file that actually ships. Without a backend the
 * app mounts its "couldn't reach the server" state, which is all this needs: a mounted app is
 * a non-empty `#root`.
 *
 * Tag behaviour is MEASURED, not assumed. `Intl` rejects `en-US@posix`, `C`, `en_US` and `""`
 * but ACCEPTS `POSIX`, `posix` and `en-US-POSIX` — testing with an accepted tag would pass
 * before the fix and prove nothing.
 */
import { expect, test, type Page } from '@playwright/test';

/** Tags this runtime actually rejects. Verified rather than guessed; see the file header. */
const REJECTED_TAGS = ['en-US@posix', 'C', 'en_US'] as const;

/** Overrides the reported locale before ANY page script runs.
 *
 * Not Playwright's context `locale` option: it passes `en-US@posix` and `C` through verbatim
 * but silently normalises `en_US` to `en-US`, which would reproduce nothing while appearing
 * to test something. */
async function reportLocale(page: Page, tag: string): Promise<void> {
  await page.addInitScript((t: string) => {
    Object.defineProperty(Navigator.prototype, 'language', {
      get: () => t,
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => [t],
      configurable: true,
    });
  }, tag);
}

const rootChildren = (page: Page): Promise<number> =>
  page.evaluate(() => document.getElementById('root')?.childElementCount ?? -1);

test.describe('a locale tag the runtime rejects does not stop the dashboard starting', () => {
  for (const tag of REJECTED_TAGS) {
    test(`mounts when navigator.language is ${tag}`, async ({ page }) => {
      await reportLocale(page, tag);
      await page.goto('/index.html');
      await page.waitForLoadState('load');

      // The mount is the assertion. NOT the absence of a console error: the pre-fix state is
      // an empty root, and an error-count assertion would pass for unrelated reasons.
      expect(
        await rootChildren(page),
        `#root is empty — the app never mounted under locale ${tag}`,
      ).toBeGreaterThan(0);
    });
  }

  test('leaves a usable locale untouched', async ({ page }) => {
    // The guard must be conditional. A host with a valid tag keeps its own locale, or every
    // user's formatting changes to fix a case almost none of them have.
    await page.goto('/index.html');
    await page.waitForLoadState('load');
    expect(await page.evaluate(() => navigator.language)).toBe('en-US');
    expect(await rootChildren(page)).toBeGreaterThan(0);
  });

  test('substitutes a locale the runtime resolved from this host', async ({ page }) => {
    await reportLocale(page, 'en-US@posix');
    await page.goto('/index.html');
    await page.waitForLoadState('load');
    const lang = await page.evaluate(() => navigator.language);
    // Valid by construction, and the same locale the app's own formatting already uses.
    expect(lang).not.toBe('en-US@posix');
    expect(await page.evaluate((l: string) => {
      try {
        new Intl.NumberFormat(l);
        return true;
      } catch {
        return false;
      }
    }, lang)).toBe(true);
  });

  test('formatting still works, and formats real values', async ({ page }) => {
    // Substitution must change only WHICH locale formats a value, never the value.
    await reportLocale(page, 'en-US@posix');
    await page.goto('/index.html');
    await page.waitForLoadState('load');
    const fmt = await page.evaluate(() => ({
      num: (1234.5).toLocaleString(),
      // Midday UTC, so no timezone can shift it across a year boundary. `new Date(0)` would
      // format as 1969 anywhere behind UTC — a property of the test machine, not the code.
      date: new Date('2026-06-15T12:00:00Z').toLocaleDateString(),
      intl: new Intl.NumberFormat(navigator.language).format(1234.5),
    }));
    expect(fmt.num).toContain('1');
    expect(fmt.date).toContain('2026');
    expect(fmt.intl).toContain('1');
  });
});

test.describe('a failure to start is surfaced, never a blank page', () => {
  test('shows a message when the app module cannot load', async ({ page }) => {
    // Deliberate module-graph failure, independent of the locale path: the guard must cover
    // the class, not the one instance of it that was found.
    await page.route('**/src/index.tsx*', (r) => r.abort());
    await page.goto('/index.html');
    await page.waitForLoadState('load');

    const text = await page.evaluate(() => document.body.innerText);
    expect(text.trim(), 'the user was shown a blank page').not.toBe('');
    expect(text).toMatch(/dashboard/i);
  });

  test('the surfaced failure discloses no raw error detail', async ({ page }) => {
    // A thrown value can carry anything that was in scope where it was raised, so it is
    // treated as untrusted for disclosure exactly as request/response bodies are.
    //
    // NOTE: this one cannot be red before the fix — a blank page trivially satisfies "does
    // not show the secret". It is meaningful only paired with the test above, which IS red:
    // together they say "show something, and let that something be sanitised". Read alone it
    // would be mistaken for coverage it does not provide until the guard exists.
    const consoleText: string[] = [];
    page.on('console', (m) => consoleText.push(m.text()));
    await page.addInitScript(() => {
      // A throw carrying a secret, from inside the module graph.
      const orig = document.createElement.bind(document);
      (document as unknown as { createElement: unknown }).createElement = (
        ...args: [string]
      ): HTMLElement => {
        if (args[0] === '__boom__') throw new Error('SECRET-PAYLOAD-abc123');
        return orig(...args);
      };
    });
    await page.route('**/src/index.tsx*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `throw new Error('SECRET-PAYLOAD-abc123');`,
      }),
    );
    await page.goto('/index.html');
    await page.waitForLoadState('load');

    const body = await page.evaluate(() => document.body.innerText);
    expect(body, 'the raw error text was rendered to the user').not.toContain(
      'SECRET-PAYLOAD-abc123',
    );
    expect(
      consoleText.join('\n'),
      'the guard echoed the raw error to the console',
    ).not.toContain('SECRET-PAYLOAD-abc123');
  });
});
