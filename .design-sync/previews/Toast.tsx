import * as React from 'react';
import { Toast } from '@polyrouter/design-kit';

/** The toast is `position: fixed` (bottom-center of the app). A `transform` on
 * this stage makes it the fixed toast's containing block, so the chip floats at
 * the bottom of this card instead of anchoring to the page viewport. */
const stage: React.CSSProperties = {
  position: 'relative',
  transform: 'translateZ(0)',
  width: 400,
  height: 150,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  overflow: 'hidden',
};

/** Primary: the confirmation shown after copying the router endpoint (role=status)
 * — a small dark chip floating bottom-center, as in the app. */
export const EndpointCopied = () => (
  <div style={stage}>
    <Toast message="Endpoint copied" />
  </div>
);

/** After copying a freshly minted agent key. */
export const KeyCopied = () => (
  <div style={stage}>
    <Toast message="Key copied" />
  </div>
);
