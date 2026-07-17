import type * as React from 'react';
import { mountWithApp, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';
import type { PageId } from '../types';

export interface TopbarProps extends CommonProps {
  /** Which page's title/subtitle to show (default "overview"). */
  page?: PageId;
}

/** The dashboard's top bar: page title + one-line subtitle on the left, the
 * pulsing "Live" chip and the copyable `/v1` endpoint chip on the right. */
export function Topbar(props: TopbarProps): React.ReactElement {
  return useSolidMount(props, (el, p) => {
    const { page, ...rest } = p;
    return mountWithApp(el, solid['Topbar']!, rest, { seed: { page: page ?? 'overview' } });
  });
}
