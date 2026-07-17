import * as React from 'react';
import { Topbar } from '@polyrouter/design-kit';

/** Clip the full-width bar into a window-top frame. */
const frame: React.CSSProperties = {
  width: 900,
  border: '1px solid var(--border)',
  borderRadius: 10,
  overflow: 'hidden',
};

/** Canonical: the Overview top bar — title + subtitle on the left, the pulsing
 * Live chip and the copyable /v1 endpoint chip on the right. */
export const Overview = () => (
  <div style={frame}>
    <Topbar page="overview" />
  </div>
);

/** Requests page — "every routed call, with its why". */
export const Requests = () => (
  <div style={frame}>
    <Topbar page="requests" />
  </div>
);

/** Costs page — "where the money goes". */
export const Costs = () => (
  <div style={frame}>
    <Topbar page="costs" />
  </div>
);

/** Routing page — "tiers, fallbacks & auto layers". */
export const Routing = () => (
  <div style={frame}>
    <Topbar page="routing" />
  </div>
);

/** Dark: the same bar under the dashboard's dark token set. */
export const Dark = () => (
  <div style={{ ...frame, border: 'none' }} data-theme="dark">
    <Topbar page="overview" theme="dark" />
  </div>
);
