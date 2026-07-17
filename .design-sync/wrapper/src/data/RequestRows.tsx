import type * as React from 'react';
import { demoRequestRows, mountWithApp, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';
import type { RequestRowData } from '../types';

export interface RequestRowsProps extends CommonProps {
  /** Request-log rows, newest first. Defaults to 8 demo rows. */
  rows?: RequestRowData[];
}

/** Request-log rows: time, model, provider, tier, decision-layer chip, token
 * counts, cost, latency and status dot. Clicking a row highlights it (the real
 * selection behavior). Put a RequestTableHead above and wrap both in a panel. */
export function RequestRows(props: RequestRowsProps): React.ReactElement {
  return useSolidMount(props, (el, p) => {
    const rows = Array.isArray(p['rows']) ? p['rows'] : demoRequestRows(8);
    return mountWithApp(el, solid['RequestRows']!, { rows }, { seed: { requestList: rows } });
  });
}
