import type { JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { Page } from '../types';

/**
 * Per-page identity glyphs (add-nav-page-icons). ONE registry, keyed by the whole
 * `Page` union so an omission is a compile error, consumed by BOTH the Sidebar
 * rail and the Topbar header — the same glyph for a page can never drift between
 * the two surfaces. Icons are decorative inline SVG (lucide geometry, stroke 1.5,
 * `currentColor`) — no icon-library dependency, nothing fetched at runtime. The
 * svg inherits its color from the parent (rail: the nav button's text2→accent-deep
 * `currentColor`; header: a quiet `--text3`), so it adds no hue of its own.
 */

const Overview = (): JSX.Element => (
  <>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
  </>
);

const Requests = (): JSX.Element => (
  <>
    <path d="M8 3 4 7l4 4" />
    <path d="M4 7h16" />
    <path d="m16 21 4-4-4-4" />
    <path d="M20 17H4" />
  </>
);

const Costs = (): JSX.Element => (
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
    <path d="M12 18V6" />
  </>
);

const Agents = (): JSX.Element => (
  <>
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
  </>
);

const Providers = (): JSX.Element => (
  <>
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </>
);

const Routing = (): JSX.Element => (
  <>
    <circle cx="6" cy="19" r="3" />
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    <circle cx="18" cy="5" r="3" />
  </>
);

const Limits = (): JSX.Element => (
  <>
    <path d="m12 14 4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </>
);

const Settings = (): JSX.Element => (
  <>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>
);

const Users = (): JSX.Element => (
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </>
);

const Setup = (): JSX.Element => (
  <>
    <circle cx="12" cy="12" r="10" />
    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
  </>
);

/** The sole source of truth. `satisfies Record<Page, …>` makes a missing page a
 * compile error (exhaustiveness), while keeping the concrete keys for tests. */
export const PAGE_ICONS = {
  overview: Overview,
  requests: Requests,
  costs: Costs,
  agents: Agents,
  providers: Providers,
  routing: Routing,
  limits: Limits,
  settings: Settings,
  users: Users,
  setup: Setup,
} satisfies Record<Page, () => JSX.Element>;

/** The page's identity glyph. Decorative (`aria-hidden`); color comes from the
 * parent's `currentColor`. `data-page-icon` is a stable test hook for asserting
 * the rail and header show the same glyph for a page. */
export function PageIcon(props: { page: Page; size?: number }): JSX.Element {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      style="flex:none"
      data-page-icon={props.page}
      aria-hidden="true"
    >
      <Dynamic component={PAGE_ICONS[props.page]} />
    </svg>
  );
}
