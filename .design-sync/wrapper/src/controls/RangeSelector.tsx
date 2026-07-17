import type * as React from 'react';
import { mountWithApp, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';

export interface RangeSelectorProps extends CommonProps {
  /** Initially selected range. Clicking segments updates it live (self-contained state). */
  range?: '24h' | '7d' | '30d';
}

/** The `24h / 7d / 30d` segmented control shared by Overview and Costs.
 * Self-contained: selection state lives in this block and updates on click. */
export function RangeSelector(props: RangeSelectorProps): React.ReactElement {
  return useSolidMount(props, (el, p) => {
    const { range, ...rest } = p;
    return mountWithApp(el, solid['RangeSelector']!, rest, {
      seed: { range: range ?? '24h' },
    });
  });
}
