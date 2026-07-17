import type * as React from 'react';
import { demoRequestRows, mountWithApp, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';
import type { RequestRowData } from '../types';

export interface InspectorProps extends CommonProps {
  /** Rows the inspector can resolve the selection from (default: demo corpus). */
  rows?: RequestRowData[];
  /** id of the row to inspect (default: the first demo row). */
  selectedId?: string;
}

/** The routing-decision inspector drawer over one request-log row: agent →
 * router → provider chips, verbatim decision layer + routing reason, the
 * immutable usage/price snapshots, and timing. Renders as a right-side drawer
 * with a dimmed backdrop (fixed-position overlay). */
export function Inspector(props: InspectorProps): React.ReactElement {
  return useSolidMount(props, (el, p) => {
    const rows = (Array.isArray(p['rows']) ? p['rows'] : demoRequestRows(6)) as { id?: unknown }[];
    const selId =
      typeof p['selectedId'] === 'string'
        ? p['selectedId']
        : typeof rows[0]?.id === 'string'
          ? rows[0].id
          : null;
    return mountWithApp(el, solid['Inspector']!, {}, { seed: { requestList: rows, selId } });
  });
}
