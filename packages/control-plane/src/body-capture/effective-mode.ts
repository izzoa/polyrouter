import type { BodyCaptureMode, BodyCaptureOverride } from '@polyrouter/shared/server';

export interface CaptureDecisionInput {
  readonly mode: BodyCaptureMode;
  readonly override: BodyCaptureOverride | null;
  readonly status: 'success' | 'error' | 'fallback' | 'cancelled';
  readonly escalated: boolean;
}

/**
 * THE effective capture decision (spec: 'Global off is a master kill'):
 *   global off        → never (overrides INERT — the master switch is the
 *                       consent boundary and the green badge's truth)
 *   agent 'never'     → never
 *   agent 'always'    → every outcome (cancelled included, flagged partial)
 *   global 'all'      → every outcome
 *   global errors_only→ only a terminal error or an escalated request
 *                       (fallback = served; cancelled = client walked away)
 */
export function shouldPersistBodies(i: CaptureDecisionInput): boolean {
  if (i.mode === 'off') return false;
  if (i.override === 'never') return false;
  if (i.override === 'always') return true;
  if (i.mode === 'all') return true;
  return i.status === 'error' || i.escalated;
}
