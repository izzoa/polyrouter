import * as React from 'react';
import { HarnessSelect } from '@polyrouter/design-kit';

type HarnessId =
  | 'openai_sdk'
  | 'anthropic_sdk'
  | 'vercel_ai_sdk'
  | 'langchain'
  | 'openclaw'
  | 'curl';

const field: React.CSSProperties = { width: 300 };
const label: React.CSSProperties = {
  display: 'block',
  font: "500 11.5px 'Geist', sans-serif",
  color: 'var(--text2)',
  marginBottom: 5,
};

/** Canonical: the "Agent platform" field from the connect-agent flow — the styled
 * select paired with its label. */
export const AgentPlatformField = () => (
  <div style={field}>
    <label style={label} htmlFor="harness-openai">
      Agent platform
    </label>
    <HarnessSelect id="harness-openai" value="openai_sdk" />
  </div>
);

/** Anthropic SDK selected. */
export const Anthropic = () => (
  <div style={field}>
    <HarnessSelect value="anthropic_sdk" />
  </div>
);

/** OpenClaw selected. */
export const OpenClaw = () => (
  <div style={field}>
    <HarnessSelect value="openclaw" />
  </div>
);

/** cURL / other selected. */
export const Curl = () => (
  <div style={field}>
    <HarnessSelect value="curl" />
  </div>
);

/** Live: controlled by React state — selecting an option updates it and the
 * echoed connection target below. */
export const Interactive = () => {
  const [value, setValue] = React.useState<HarnessId>('vercel_ai_sdk');
  return (
    <div style={field}>
      <label style={label} htmlFor="harness-live">
        Agent platform
      </label>
      <HarnessSelect id="harness-live" value={value} onChange={setValue} />
      <div
        style={{
          marginTop: 8,
          font: "400 11px 'Geist Mono', monospace",
          color: 'var(--text3)',
        }}
      >
        connect as: {value}
      </div>
    </div>
  );
};
