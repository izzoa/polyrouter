import * as React from 'react';
import { Inspector, demoRequestRows } from '@polyrouter/design-kit';

/** Cascade escalation: amber "escalated ↗", quality signal, and the immutable
 * price snapshots — the router's full "why" for one request. */
export const CascadeEscalation = () => (
  <Inspector rows={demoRequestRows(12)} selectedId="req-996" height={620} />
);

/** A plain successful explicit-routing request. */
export const ExplicitSuccess = () => (
  <Inspector rows={demoRequestRows(12)} selectedId="req-1000" height={620} />
);

/** A fallback-served request (attempt cost recorded for the failed try). */
export const FallbackServed = () => (
  <Inspector rows={demoRequestRows(12)} selectedId="req-997" height={620} />
);
