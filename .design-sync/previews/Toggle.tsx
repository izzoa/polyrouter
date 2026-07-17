import * as React from 'react';
import { Toggle } from '@polyrouter/design-kit';

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  width: 300,
  padding: '10px 14px',
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  font: "400 12.5px 'Geist', sans-serif",
  color: 'var(--text)',
};

export const OnOff = () => (
  <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
    <Toggle on label="Structural routing on" />
    <Toggle on={false} label="Cascade off" />
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
    <Toggle on size="sm" label="Small (rows, channels)" />
    <Toggle on size="md" label="Medium (settings)" />
  </div>
);

export const Locked = () => (
  <div style={row}>
    <span>
      Cascade routing
      <span style={{ color: 'var(--text3)', marginLeft: 8 }}>requires structural</span>
    </span>
    <Toggle on={false} locked label="Cascade routing (locked)" />
  </div>
);

/** Live: wired to React state — clicking flips it. */
export const Interactive = () => {
  const [on, setOn] = React.useState(true);
  return (
    <div style={row}>
      <span>Structural routing (L1)</span>
      <Toggle on={on} size="md" label="Structural routing" onToggle={() => setOn(!on)} />
    </div>
  );
};
