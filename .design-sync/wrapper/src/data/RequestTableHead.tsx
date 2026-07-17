import type * as React from 'react';
import { mountPlain, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';

export type RequestTableHeadProps = CommonProps;

/** Column header row for the request log (Time / Model / Provider / Tier /
 * Decided by / Tokens / Cost / Latency / Status). Pair with RequestRows. */
export function RequestTableHead(props: RequestTableHeadProps): React.ReactElement {
  return useSolidMount(props, (el, p) => mountPlain(el, solid['RequestTableHead']!, p));
}
