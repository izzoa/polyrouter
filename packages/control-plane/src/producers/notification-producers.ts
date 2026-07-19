import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT, type Principal } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import { NotificationService } from '../notifications/notification.service';
import { PRODUCERS_CONFIG, type ProducersConfig } from './producers.config';

/** Atomic spike counter: INCR + set the window TTL only on the first increment
 * (one round-trip, so increment+expiry can't split). Returns the new count. */
const SPIKE_LUA = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n`;

function ownerOf(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : principal.orgId;
}

/** Integer micro-dollars → a display USD string (operator-facing, non-secret). */
function fmtMicros(micros: number): string {
  return `$${((Number.isFinite(micros) ? micros : 0) / 1_000_000).toFixed(2)}`;
}

/** A budget event's owner/scope + display figures (spend/threshold in µ$). */
export interface BudgetEventArgs {
  readonly ownerUserId: string;
  readonly agentId?: string;
  readonly budgetId: string;
  readonly periodId: string;
  readonly name: string;
  readonly spent: number;
  readonly threshold: number;
  /** Whether the period's metered spend includes any native_family-priced
   * component (add-native-price-fallback) — display provenance only. 'unknown'
   * when the best-effort lookup failed/timed out: rendered as provenance
   * unavailable, never as confirmed-exact. */
  readonly spendEstimated: boolean | 'unknown';
  readonly channelIds: string[];
}

/**
 * The #15b event producers that call #15a's non-blocking `emit`. Every method is
 * fire-and-forget and self-contained (own try/catch) so a producer or Redis
 * fault never surfaces to the proxy request path (invariant 11).
 */
@Injectable()
export class NotificationProducers {
  private readonly logger = new Logger('NotificationProducers');
  private readonly threshold: number;
  private readonly windowMs: number;

  constructor(
    private readonly notifications: NotificationService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PRODUCERS_CONFIG) cfg: ProducersConfig,
  ) {
    this.threshold = Math.max(1, Math.floor(cfg.failureThreshold));
    this.windowMs = Math.max(1000, Math.floor(cfg.failureWindowMs));
  }

  /** A provider's shared breaker just opened → alert its owner. Deduped per
   * `(owner, provider)` within `provider_down`'s window (no `lifecycleId`). */
  providerDown(providerId: string, providerName: string, ownerUserId: string): void {
    void this.notifications.emit({
      type: 'provider_down',
      scope: { ownerUserId, providerId },
      fields: { providerName },
    });
  }

  /** A scheduled reconcile found an `alert` budget at/over threshold → emit
   * `budget_alert` (deduped once per period by the scheduler's Redis marker;
   * `lifecycleId=periodId` keeps a new period un-suppressed). Fire-and-forget. */
  budgetAlert(a: BudgetEventArgs): void {
    this.emitBudget('budget_alert', a);
  }

  /** A `block` budget engaged (first block of the period) → emit `budget_block`.
   * Fire-and-forget; the caller dedups per period. */
  budgetBlock(a: BudgetEventArgs): void {
    this.emitBudget('budget_block', a);
  }

  private emitBudget(type: 'budget_alert' | 'budget_block', a: BudgetEventArgs): void {
    try {
      void this.notifications.emit({
        type,
        scope: {
          ownerUserId: a.ownerUserId,
          ...(a.agentId !== undefined ? { agentId: a.agentId } : {}),
          limitId: a.budgetId,
          lifecycleId: a.periodId,
        },
        fields: {
          limitName: a.name,
          spent: fmtMicros(a.spent),
          threshold: fmtMicros(a.threshold),
          ...(a.spendEstimated === true
            ? { spendEstimated: 'true' }
            : a.spendEstimated === 'unknown'
              ? { spendEstimated: 'unknown' }
              : {}),
        },
        ...(a.channelIds.length > 0 ? { channelIds: a.channelIds } : {}),
      });
    } catch (err) {
      this.logger.warn(`budget emit skipped: ${String((err as Error).message)}`);
    }
  }

  /** A request was recorded as an error → bump the owner's windowed Redis
   * counter; emit a spike alert exactly when it reaches the threshold. */
  async onRequestFailed(principal: Principal): Promise<void> {
    try {
      const owner = ownerOf(principal);
      const bucket = Math.floor(Date.now() / this.windowMs);
      const key = `spike:${owner}:${bucket}`;
      const n = Number(await this.redis.eval(SPIKE_LUA, 1, key, this.windowMs));
      if (n === this.threshold) {
        void this.notifications.emit({
          type: 'request_failures_spike',
          scope: { ownerUserId: owner, lifecycleId: String(bucket) },
          fields: { count: n },
        });
      }
    } catch (err) {
      // A Redis fault just skips the check; never surfaces to the caller.
      this.logger.warn(`spike check skipped: ${String((err as Error).message)}`);
    }
  }
}
