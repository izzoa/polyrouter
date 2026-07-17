import * as React from 'react';
import { RangeSelector } from '@polyrouter/design-kit';

/** The section header the control lives in on Overview and Costs. */
const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 16,
  width: 460,
  padding: '13px 16px',
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
};
const title: React.CSSProperties = {
  font: "500 13px 'Geist', sans-serif",
  color: 'var(--text)',
  whiteSpace: 'nowrap',
};

/** Canonical: the Overview section header — title on the left, the range control
 * on the right. Clicking a segment updates the selection live. */
export const InSectionHeader = () => (
  <div style={header}>
    <span style={title}>Overview · 24h</span>
    <RangeSelector range="24h" />
  </div>
);

/** 24h selected — the dashboard default window. */
export const Day = () => <RangeSelector range="24h" />;

/** 7d selected. */
export const Week = () => <RangeSelector range="7d" />;

/** 30d selected. */
export const Month = () => <RangeSelector range="30d" />;
