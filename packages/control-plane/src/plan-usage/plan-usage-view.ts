import type {
  PlanUsageBilling,
  PlanUsageSnapshot,
  PlanUsageSource,
  PlanUsageSpan,
} from '@polyrouter/data-plane';

/** The wire view of one usage window. Numbers, enums and ISO-8601 instants only (invariant 8):
 * no header or body text, credential or account data ever reaches it. */
export interface SafePlanUsageWindow {
  key: string;
  group: 'account' | 'model';
  span: PlanUsageSpan | null;
  minutes: number | null;
  scope: string | null;
  usedPercent: number | null;
  resetAt: string | null;
  observedAt: string;
  source: PlanUsageSource;
}

export interface SafePlanUsage {
  windows: SafePlanUsageWindow[];
  billing: { state: PlanUsageBilling; observedAt: string } | null;
}

/** `{ availableAt }`, with `availableAt` null meaning a refresh is allowed now. */
export interface SafePlanUsageRefresh {
  availableAt: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The stored snapshot as the dashboard sees it: instants become ISO-8601 strings (every other
 * instant on the wire is one). A snapshot with nothing to show reads as null. */
export function toSafePlanUsage(
  snapshot: PlanUsageSnapshot | null | undefined,
): SafePlanUsage | null {
  if (snapshot === null || snapshot === undefined) return null;
  if (snapshot.windows.length === 0 && snapshot.billing === null) return null;
  return {
    windows: snapshot.windows.map((w) => ({
      key: w.key,
      group: w.group,
      span: w.span,
      minutes: w.minutes,
      scope: w.scope,
      usedPercent: w.usedPercent,
      resetAt: w.resetMs === null ? null : iso(w.resetMs),
      observedAt: iso(w.observedAt),
      source: w.source,
    })),
    billing:
      snapshot.billing === null
        ? null
        : { state: snapshot.billing.state, observedAt: iso(snapshot.billing.observedAt) },
  };
}
