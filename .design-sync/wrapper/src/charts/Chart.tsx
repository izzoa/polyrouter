import type * as React from 'react';
import { demoChartData, mountWithApp, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';

export interface ChartProps extends CommonProps {
  /** `[epochSeconds[], counts[]]` — uPlot's native shape. Defaults to a 24h demo series. */
  data?: [number[], number[]];
  /** Series label (default "requests"). */
  label?: string;
  /** Chart height in px (default 150). */
  height?: number;
}

/** Single-series requests-per-bucket line chart — the dashboard's real uPlot
 * wrapper, themed from the CSS tokens (accent line, quiet grid, Geist Mono axes). */
export function Chart(props: ChartProps): React.ReactElement {
  return useSolidMount(props, (el, p) =>
    mountWithApp(el, solid['Chart']!, { data: demoChartData(), ...p }, {}),
  );
}
