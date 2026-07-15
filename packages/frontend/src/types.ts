import type { HarnessType } from '@polyrouter/shared';

export type Page =
  | 'overview'
  | 'requests'
  | 'costs'
  | 'agents'
  | 'providers'
  | 'routing'
  | 'limits'
  | 'settings'
  | 'setup';

export type Theme = 'light' | 'dark';
export type Range = '24h' | '7d' | '30d';
export type RequestFilter = 'all' | 'explicit' | 'auto' | 'fallback' | 'escalated';
export type DecisionLayer = 'explicit' | 'header' | 'structural' | 'escalated';
export type RequestStatus = 'ok' | 'fallback';
export type ModelTag = 'sub' | 'local' | null;
/** The dashboard's harness type IS the canonical shared one (single source). */
export type Harness = HarnessType;
export type LimitWindow = 'day' | 'week' | 'month';
export type LimitAction = 'alert' | 'block';
export type ProviderKindId = 'api' | 'sub' | 'custom' | 'local';
export type ModalKind = 'newAgent' | 'keyReveal' | 'newProvider' | 'newLimit';
export type TraceState = 'hit' | 'ok' | 'pass' | 'skip' | 'warn' | 'err';

export interface TraceStep {
  k: string;
  title: string;
  s: TraceState;
  d: string;
}

export interface FeatureRow {
  k: string;
  v: string;
}

export interface RoutedRequest {
  id: string;
  ts: number;
  agent: string;
  model: string;
  provider: string;
  tag: ModelTag;
  tier: string;
  layer: DecisionLayer;
  status: RequestStatus;
  escalated: boolean;
  reason: string;
  steps: TraceStep[];
  feat: FeatureRow[] | null;
  tin: number;
  tout: number;
  /** Unit prices ($/1M) snapshotted when the request was served — rendering
   * never re-reads the mutable catalog (mirrors the cost-immutability rule). */
  inPrice: number;
  outPrice: number;
  cost: number;
  ms: number;
  ttfb: number;
  routeMs: 0 | 1;
  estimated: boolean;
}

/** One row of a spend/cost breakdown (BarRows). */
export interface SpendDatum {
  n: string;
  v: number;
  fv?: number;
  free?: boolean;
}

/** Monthly cost summary shown on the Costs page. */
export interface MonthCostSummary {
  spend: number;
  listPrice: number;
  estimatedFlagged: number;
  splitPct: { free: number; subscription: number; api: number };
}

/** Trend notes on the Overview stat cards. */
export interface OverviewNotes {
  spendVsList: string;
  requestsTrend: string;
}

export interface Stats {
  spend: number;
  reqs: number;
  tin: number;
  tout: number;
  fb: number;
  esc: number;
}

export interface Tier {
  key: string;
  desc: string;
  chain: string[];
}

export interface HeaderRule {
  id: number;
  value: string;
  target: string;
}

export type ProviderStatus = 'ok' | 'warn';

export interface Provider {
  id: string;
  name: string;
  kind: string;
  status: ProviderStatus;
  models: number;
  reqs: number;
  spend: string;
}

export interface Agent {
  id: string;
  name: string;
  harness: Harness;
  prefix: string;
  reqs: number;
  spend: string;
  last: string;
}

export interface Limit {
  id: number;
  scope: string;
  threshold: number;
  window: LimitWindow;
  action: LimitAction;
  current: number;
  note: string;
}

export type ChannelKind = 'smtp' | 'apprise';

export interface Channel {
  id: number;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  detail: string;
  last: string;
  lastOk: boolean | null;
  testing: boolean;
}

export interface OnboardingState {
  step: 1 | 2 | 3;
  name: string;
  harness: Harness;
  key: string;
  provPicked: ProviderKindId | null;
  done1: boolean;
  done2: boolean;
}
