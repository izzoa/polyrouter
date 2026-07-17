/** Shared prop vocabulary for the design-kit adapters — self-contained mirrors
 * of the dashboard's data shapes (kept flat so the emitted .d.ts is the whole
 * contract; no deep imports into app internals). */

export type PageId =
  | 'overview'
  | 'requests'
  | 'costs'
  | 'agents'
  | 'providers'
  | 'routing'
  | 'limits'
  | 'settings'
  | 'setup';

export type HarnessId =
  | 'openai_sdk'
  | 'anthropic_sdk'
  | 'vercel_ai_sdk'
  | 'langchain'
  | 'openclaw'
  | 'curl';

/** One horizontal spend bar (BarRows). `free` rows show `fv` as would-have-cost. */
export interface SpendBarDatum {
  /** Row label (model/provider/agent name). */
  n: string;
  /** Spend in dollars. */
  v: number;
  /** Would-have-cost for free rows (drives the bar length when `free`). */
  fv?: number;
  /** Render as a free (green, muted-bar) row. */
  free?: boolean;
}

/** One request-log row — mirrors the dashboard's RequestRow (metadata only). */
export interface RequestRowData {
  id: string;
  /** ISO timestamp. */
  createdAt: string;
  agentId: string;
  providerId: string;
  modelId: string;
  tierAssigned: string | null;
  /** Routing layer that decided: explicit | header | default | structural | cascade. */
  decisionLayer: string;
  /** Verbatim routing reason (transparency payload). */
  routingReason: string;
  /** success | fallback | error | cancelled. */
  status: string;
  escalated: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Immutable unit-price snapshots ($ per 1M tokens) taken at request time. */
  inputPriceSnapshot: number | null;
  outputPriceSnapshot: number | null;
  cacheReadPriceSnapshot: number | null;
  cacheWritePriceSnapshot: number | null;
  /** Served cost in dollars; null = unpriced. */
  cost: number | null;
  /** Cost of failed pre-fallback attempts, in micro-dollars. */
  attemptCostMicros: number;
  durationMs: number;
  /** Provider omitted usage — output was estimated (rendered with ~). */
  usageEstimated: boolean;
  qualitySignal: number | null;
  modelLabel: string | null;
  providerLabel: string | null;
  agentLabel: string | null;
}
