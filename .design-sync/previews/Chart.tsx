import * as React from 'react';
import { Chart, demoChartData } from '@polyrouter/design-kit';

const panel: React.CSSProperties = {
  width: 560,
  padding: 18,
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
};
const label: React.CSSProperties = {
  font: "500 11px 'Geist', sans-serif",
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--text3)',
  marginBottom: 10,
};

export const Requests24h = () => (
  <div style={panel}>
    <div style={label}>Requests · 24h</div>
    <Chart data={demoChartData()} height={150} />
  </div>
);

export const TallCompletions = () => (
  <div style={panel}>
    <div style={label}>Completions · 24h</div>
    <Chart data={demoChartData()} label="completions" height={220} />
  </div>
);

/** Sparse series — a quiet self-hosted instance. */
export const QuietInstance = () => {
  const [xs] = demoChartData();
  const quiet = xs.map((_, i) => (i % 7 === 0 ? 3 : i % 3 === 0 ? 1 : 0));
  return (
    <div style={{ ...panel, width: 420 }}>
      <div style={label}>Requests · 24h</div>
      <Chart data={[xs, quiet]} height={120} />
    </div>
  );
};
