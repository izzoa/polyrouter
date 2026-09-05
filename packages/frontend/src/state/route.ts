/**
 * Page↔fragment translation (add-dashboard-hash-routing). Pure — no store, no
 * `location`, no `history` — so every grammar decision is unit-testable and the
 * store owns only the transitions.
 *
 * Grammar: exactly `#/<page>`, case-sensitive against the `Page` union, with no
 * suffix, query, or percent-decoded alias. Anything else is UNKNOWN — never
 * guessed — because guessing would let `#/Costs` or `#/costs?x=1` resolve to a
 * page the operator did not name, and a wrong guess is worse than the default.
 */
import type { Page } from '../types';

/** Every routable page. The `Page` union is the source of truth; this array is
 * its runtime shadow, and `MISSING_PAGE` below pins them together so adding a
 * page to the union without adding it here fails the build.
 *
 * `satisfies readonly Page[]` alone does NOT do that — it only checks that every
 * ELEMENT is a `Page`, so a subset satisfies it happily. It read as exhaustive
 * and was not: `batches` was added to the union and silently became unroutable,
 * which is what add-batch-inference found. */
export const PAGES = [
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
  'setup',
] as const satisfies readonly Page[];

/** The real exhaustiveness check: any `Page` absent from `PAGES` leaves a
 * non-`never` residue here and fails the build. Type-only — it emits nothing. */
type MissingPage = Exclude<Page, (typeof PAGES)[number]>;
const _exhaustive: MissingPage extends never ? true : MissingPage = true;
void _exhaustive;

/** The page rendered when no valid fragment names one. */
export const DEFAULT_PAGE: Page = 'overview';

/** `#/<page>` → the page, or null when the fragment names none.
 * Deliberately does NOT decode: `#/%63osts` is unknown, not `costs`. */
export function pageFromHash(hash: string): Page | null {
  if (!hash.startsWith('#/')) return null;
  const raw = hash.slice(2);
  return (PAGES as readonly string[]).includes(raw) ? (raw as Page) : null;
}

/** The canonical fragment for a page — the exact form emitted everywhere,
 * including the deep links `add-branded-notifications` builds. */
export function hashForPage(page: Page): string {
  return `#/${page}`;
}
