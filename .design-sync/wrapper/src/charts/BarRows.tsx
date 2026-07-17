import type * as React from 'react';
import { demoSpend, mountPlain, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';
import type { SpendBarDatum } from '../types';

export interface BarRowsProps extends CommonProps {
  /** Rows to render, sorted by the caller. Defaults to a demo spend breakdown. */
  data?: SpendBarDatum[];
}

/** Horizontal spend bars (Overview/Costs breakdowns): label + amount over an
 * accent bar; free rows render green with a muted bar sized by would-have-cost. */
export function BarRows(props: BarRowsProps): React.ReactElement {
  return useSolidMount(props, (el, p) =>
    mountPlain(el, solid['BarRows']!, { data: demoSpend, ...p }),
  );
}
