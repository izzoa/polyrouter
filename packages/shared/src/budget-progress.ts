/** Metadata-only recorded budget progress. Money is integer micro-dollars. */
export interface BudgetProgressConfig {
  id: string;
  name: string;
  scope: string;
  agentId: string | null;
  window: string;
  action: string;
  meteringBasis: string;
  amount: number;
  notifyChannelIds: string[];
  enabled: boolean;
  createdAt: string;
}

export interface AvailableBudgetProgress {
  id: string;
  availability: 'available';
  budget: BudgetProgressConfig;
  period: { id: string; start: string; end: string };
  bucketSeconds: number;
  amountMicros: number;
  spentMicros: number;
  remainingMicros: number;
  overspendMicros: number;
  usedPercent: number | null;
  pendingMicros: number;
  availableMicros: number | null;
  provenance: {
    meteredRows: number;
    unpricedRows: number;
    unknownSpendMicros: number;
    usageEstimated: boolean;
    priceEstimated: boolean;
  };
  points: { at: string; spentMicros: number }[];
}

export type BudgetProgressResult =
  AvailableBudgetProgress | { id: string; availability: 'not_found' };

export interface BudgetProgressResponse {
  asOf: string;
  results: BudgetProgressResult[];
}

export const BUDGET_PROGRESS_MAX_IDS = 20;
export const BUDGET_PROGRESS_MAX_ID_LENGTH = 128;

/** Shared input bound used before either an HTTP request or a database read. */
export function validBudgetProgressIds(ids: readonly string[]): boolean {
  return (
    ids.length > 0 &&
    ids.length <= BUDGET_PROGRESS_MAX_IDS &&
    new Set(ids).size === ids.length &&
    ids.every(
      (id) => id.length > 0 && id.length <= BUDGET_PROGRESS_MAX_ID_LENGTH && id === id.trim(),
    )
  );
}
