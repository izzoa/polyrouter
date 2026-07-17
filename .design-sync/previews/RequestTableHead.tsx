import * as React from 'react';
import { RequestTableHead, RequestRows, demoRequestRows } from '@polyrouter/design-kit';

const panel: React.CSSProperties = {
  width: 900,
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  overflow: 'hidden',
};

/** Canonical: the request-log column header on its own — Time / Model / Provider /
 * Tier / Decided by / Tokens / Cost / Latency / Status. */
export const Columns = () => (
  <div style={panel}>
    <RequestTableHead />
  </div>
);

/** In situ: the header sitting above real request rows (both share one grid, so
 * the columns line up). */
export const AboveRows = () => (
  <div style={panel}>
    <RequestTableHead />
    <RequestRows rows={demoRequestRows(6)} />
  </div>
);

/** Dark: header and rows under the dashboard's dark token set. */
export const Dark = () => (
  <div style={{ ...panel, border: 'none' }} data-theme="dark">
    <RequestTableHead theme="dark" />
    <RequestRows rows={demoRequestRows(6)} theme="dark" />
  </div>
);
