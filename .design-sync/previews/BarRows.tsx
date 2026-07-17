import * as React from 'react';
import { BarRows, demoSpend } from '@polyrouter/design-kit';

const panel: React.CSSProperties = {
  width: 380,
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
  marginBottom: 12,
};

export const SpendByModel = () => (
  <div style={panel}>
    <div style={label}>Spend by model · 24h</div>
    <BarRows data={demoSpend} />
  </div>
);

export const SpendByAgent = () => (
  <div style={panel}>
    <div style={label}>Spend by agent · 30d</div>
    <BarRows
      data={[
        { n: 'openclaw', v: 41.03 },
        { n: 'ci-summarizer', v: 19.66 },
        { n: 'support-bot', v: 5.5 },
      ]}
    />
  </div>
);

/** Free local models render green with a muted would-have-cost bar. */
export const WithFreeRows = () => (
  <div style={panel}>
    <div style={label}>Spend by provider · 24h</div>
    <BarRows
      data={[
        { n: 'Anthropic', v: 37.52 },
        { n: 'OpenAI', v: 28.67 },
        { n: 'Ollama (local)', v: 0, fv: 12.3, free: true },
      ]}
    />
  </div>
);
