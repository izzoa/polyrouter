import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BudgetRow, Principal } from '@polyrouter/shared/server';
import { NotificationProducers } from '../producers/notification-producers';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { BudgetCache } from './budget-cache';
import { SpendCounter } from './spend-counter';
import { periodInfo, toMicros, type BudgetWindow } from './period';
import { BUDGETS_CONFIG, type BudgetsConfig } from './budgets.config';

const MARKER_GRACE_MS = 60_000;
/** An enforcement fault is a whole-instance condition — throttle the warn (the
 * metric is always incremented) so a sustained outage doesn't flood the log. */
const FAULT_WARN_WINDOW_MS = 30_000;

/** Thrown by `checkBlocked` under fail-closed when enforcement can't be trusted
 * (a Redis fault, a cold-cache DB failure, or a stale/absent reconcile heartbeat).
 * The proxy maps it to `503 budget_enforcement_unavailable`. */
export class BudgetEnforcementUnavailableError extends Error {
  constructor() {
    super('budget enforcement unavailable');
    this.name = 'BudgetEnforcementUnavailableError';
  }
}

/** A block budget that is at/over threshold for the current period. */
export interface BudgetHit {
  readonly budget: BudgetRow;
  readonly spentMicros: number;
  readonly periodId: string;
  readonly resetAt: Date;
}

function ownerOf(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : principal.orgId;
}

function parseCsv(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Block enforcement + block-notify (#16). `checkBlocked` reads the owner's cached
 * budgets, verifies the reconcile heartbeat is fresh, then reads the applicable
 * block counters and returns the first over-threshold `BudgetHit`. It is a
 * bounded read (dedicated fail-fast connection) with a named fail mode — never
 * hangs, never silently reads a stopped scheduler's counters as under-budget.
 * `notifyBlocked` is fire-and-forget (deduped once per period).
 */
@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);
  private readonly failOpen: boolean;
  private readonly staleMs: number;
  private lastFaultWarnAt = 0;

  constructor(
    private readonly cache: BudgetCache,
    private readonly counter: SpendCounter,
    private readonly producers: NotificationProducers,
    private readonly metrics: ProxyMetrics,
    @Inject(BUDGETS_CONFIG) cfg: BudgetsConfig,
  ) {
    this.failOpen = cfg.failOpen;
    this.staleMs = cfg.staleMs;
  }

  /** A budget check faulted → engage the named fail mode, but make it visible
   * (E6.1): always meter it, warn (throttled, class-only — never the message). */
  private recordFault(err: unknown): void {
    const mode = this.failOpen ? 'open' : 'closed';
    this.metrics.recordBudgetFault(mode);
    const now = Date.now();
    if (now - this.lastFaultWarnAt < FAULT_WARN_WINDOW_MS) return;
    this.lastFaultWarnAt = now;
    const cls = err instanceof Error ? err.constructor.name : 'unknown';
    const outcome = this.failOpen ? 'request allowed' : 'request rejected (503)';
    this.logger.warn(`budget enforcement fault (fail-${mode}); ${outcome} — ${cls}`);
  }

  /** True iff budget `b` governs a request for `agentId`. */
  applies(b: BudgetRow, agentId: string | null): boolean {
    if (b.scope === 'global') return true;
    return b.scope === 'agent' && agentId !== null && agentId === b.agentId;
  }

  /** The current-period counter key + reset for budget `b`. */
  private keyFor(
    owner: string,
    b: BudgetRow,
    at: Date,
  ): { key: string; periodId: string; resetAt: Date } {
    const window = b.window as BudgetWindow;
    const { periodId, endMs } = periodInfo(window, at);
    const scopeId = b.scope === 'agent' ? (b.agentId ?? 'global') : 'global';
    return {
      key: this.counter.key(owner, b.scope, scopeId, window, periodId),
      periodId,
      resetAt: new Date(endMs),
    };
  }

  async checkBlocked(principal: Principal, agentId: string | null): Promise<BudgetHit | null> {
    const owner = ownerOf(principal);
    try {
      const all = await this.cache.get(principal);
      const matched = all.filter(
        (b) => b.enabled && b.action === 'block' && this.applies(b, agentId),
      );
      if (matched.length === 0) return null;

      const now = Date.now();
      // A stopped/failing scheduler leaves counters stale/absent; reading them as
      // 0 would silently allow everything, so treat staleness as unavailable.
      const age = await this.counter.heartbeatAgeMs(now);
      if (age > this.staleMs) throw new BudgetEnforcementUnavailableError();

      const at = new Date(now);
      const infos = matched.map((b) => ({ b, ...this.keyFor(owner, b, at) }));
      const distinctKeys = [...new Set(infos.map((i) => i.key))];
      const values = await this.counter.read(distinctKeys);
      const byKey = new Map<string, number>();
      distinctKeys.forEach((k, i) => byKey.set(k, values[i] ?? 0));

      for (const info of infos) {
        const spent = byKey.get(info.key) ?? 0;
        if (spent >= toMicros(info.b.amount)) {
          return {
            budget: info.b,
            spentMicros: spent,
            periodId: info.periodId,
            resetAt: info.resetAt,
          };
        }
      }
      return null;
    } catch (err) {
      this.recordFault(err); // E6.1 — meter + throttled warn (behavior unchanged)
      if (this.failOpen) return null; // availability: allow on a fault (default)
      throw new BudgetEnforcementUnavailableError(); // fail-closed → 503
    }
  }

  /** Emit `budget_block` the first time a block engages this period (deduped by a
   * Redis marker). Fire-and-forget — never blocks the request/enforcement. */
  notifyBlocked(principal: Principal, hit: BudgetHit): void {
    void this.emitBlock(principal, hit);
  }

  private async emitBlock(principal: Principal, hit: BudgetHit): Promise<void> {
    try {
      const markKey = `budget-blocked:${hit.budget.id}:${hit.periodId}`;
      const ttlMs = Math.max(1, hit.resetAt.getTime() - Date.now()) + MARKER_GRACE_MS;
      if (!(await this.counter.markBlockOnce(markKey, ttlMs))) return;
      this.producers.budgetBlock({
        ownerUserId: ownerOf(principal),
        ...(hit.budget.agentId !== null ? { agentId: hit.budget.agentId } : {}),
        budgetId: hit.budget.id,
        periodId: hit.periodId,
        name: hit.budget.name,
        spent: hit.spentMicros,
        threshold: toMicros(hit.budget.amount),
        channelIds: parseCsv(hit.budget.notifyChannelIds),
      });
    } catch {
      /* swallow — enforcement already happened; the emit is best-effort */
    }
  }
}
