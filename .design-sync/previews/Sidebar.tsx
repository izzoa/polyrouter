import * as React from 'react';
import { Sidebar } from '@polyrouter/design-kit';

// The sidebar is a fixed 208px rail; hug it so the (dark) app background sits
// flush behind the panel and the footer ends at its natural bottom edge.
const rail: React.CSSProperties = { width: 208 };

/** The dashboard's left navigation on a running instance: Overview active,
 * the providers badge (3 connected) and the setup guide two-thirds done, above
 * the theme toggle and instance footer. */
export const Nav = () => (
  <div style={rail}>
    <Sidebar page="overview" providersCount={3} />
  </div>
);

/** A lower nav item active (Routing) — the accent pill tracks the current page. */
export const RoutingActive = () => (
  <div style={rail}>
    <Sidebar page="routing" providersCount={3} />
  </div>
);

/** Dark token set: same shell on the Costs page with the setup guide complete
 * ("3 of 3 done") — panel, border, accent and footer colors in dark. */
export const Dark = () => (
  <div style={rail}>
    <Sidebar theme="dark" page="costs" providersCount={3} setupStep={3} />
  </div>
);

/** A fresh install: no providers yet (badge hidden) and the setup guide at
 * step one — "1 of 3 · connect an agent". */
export const FreshInstall = () => (
  <div style={rail}>
    <Sidebar page="overview" providersCount={0} setupStep={1} />
  </div>
);
