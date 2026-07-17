import type * as React from 'react';
import { mountPlain, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';
import type { HarnessId } from '../types';

export interface HarnessSelectProps extends CommonProps {
  /** Selected harness (agent platform). */
  value?: HarnessId;
  /** Change handler; omit for a static preview. */
  onChange?: (harness: HarnessId) => void;
  /** id for a paired <label for=…>. */
  id?: string;
}

/** The agent-platform picker (OpenAI SDK / Anthropic SDK / Vercel AI SDK /
 * LangChain / OpenClaw / cURL) — the dashboard's styled select. */
export function HarnessSelect(props: HarnessSelectProps): React.ReactElement {
  return useSolidMount(props, (el, p) =>
    mountPlain(el, solid['HarnessSelect']!, {
      value: 'openai_sdk',
      onChange: () => undefined,
      ...p,
    }),
  );
}
