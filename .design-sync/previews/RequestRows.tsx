import * as React from 'react';
import { RequestTableHead, RequestRows, demoRequestRows } from '@polyrouter/design-kit';

const panel: React.CSSProperties = {
  width: 900,
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  overflow: 'hidden',
};

/** Canonical: eight recent routed calls under the column header — decision-layer
 * chips (accent "explicit", amber "cascade ↗"), token counts, snapshot cost,
 * latency and a colored status dot per row. */
export const RequestLog = () => (
  <div style={panel}>
    <RequestTableHead />
    <RequestRows rows={demoRequestRows(8)} />
  </div>
);

/** The non-happy paths the log has to surface: a cascade escalation (amber ↗), a
 * fallback-served call and a hard error. */
export const NeedsAttention = () => {
  const rows = demoRequestRows(30)
    .filter((r) => r.escalated || r.status !== 'success')
    .slice(0, 6);
  return (
    <div style={panel}>
      <RequestTableHead />
      <RequestRows rows={rows} />
    </div>
  );
};

/** A quiet local-only stretch: llama-3.3-70b served by Ollama at $0 — the free
 * rows the cost column has to render distinctly. */
export const LocalFree = () => {
  const rows = demoRequestRows(30)
    .filter((r) => r.modelId === 'm-llama')
    .slice(0, 5);
  return (
    <div style={panel}>
      <RequestTableHead />
      <RequestRows rows={rows} />
    </div>
  );
};
