import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  type PersistencePort,
  type Principal,
  type SemanticLearningEventRowView,
} from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import { loadAuthConfig, resolveAuthSecrets } from '../auth/auth.config';
import { ROUTING_CONFIG, type RoutingConfig } from '../proxy/routing.config';
import { loadRoutingSnapshot } from '../proxy/routing-snapshot';
import { resolveLearningEvidenceRevision } from './learning-evidence';
import { deriveTenantHmacKey, tenantHmac } from './learning-format';
import { RedisLearningStore } from './learning-store';
import { SemanticClassifierService } from './semantic-classifier.service';

/** The per-tenant learning status the dashboard renders (add-semantic-learning
 * task 5.3). Scalars only — never a vector. */
export interface SemanticLearningStatus {
  /** The tenant's learning preference (default OFF). */
  enabled: boolean;
  /** Whether the instance can learn (the classifier is ready). */
  available: boolean;
  epoch: number;
  generation: number;
  /** Whether the CURRENT classification serves learned or bundled centroids. */
  source: 'learned' | 'bundled';
  /** Fresh (in-window) pending sample counts per label. */
  freshHigh: number;
  freshLow: number;
  /** ISO timestamp of the last successful apply, or null. */
  lastAppliedAt: string | null;
  /** Recent audit rows (apply / discard_revision / revert). */
  history: SemanticLearningEventRowView[];
}

/**
 * The learning status + revert API surface (add-semantic-learning task 5.3),
 * session-guarded and owner-scoped through the port. The toggle rides the
 * existing autoLayers PUT; this owns status (counts / source / generation /
 * last-applied) and the one-action revert. Revert is Postgres-FIRST (epoch bump
 * fences in-flight sweeps + inert reads), THEN a best-effort Redis delete.
 */
@Injectable()
export class SemanticLearningService implements OnApplicationShutdown {
  private readonly redis: Redis;
  private readonly store: RedisLearningStore;
  private readonly tenantKey: Buffer;

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(ROUTING_CONFIG) private readonly routing: RoutingConfig,
    @Inject(REDIS_CLIENT) shared: Redis,
    private readonly classifier: SemanticClassifierService,
  ) {
    const { auth, base } = loadAuthConfig();
    this.tenantKey = deriveTenantHmacKey(resolveAuthSecrets(auth, base).apiKeyHmacSecret);
    this.redis = shared.duplicate({ enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    this.redis.on('error', () => {});
    if (this.redis.status === 'wait') void this.redis.connect().catch(() => {});
    this.store = new RedisLearningStore(this.redis);
  }

  async status(principal: Principal): Promise<SemanticLearningStatus> {
    const pref = await this.db.routingSettings.get(principal);
    const enabled = pref?.semanticLearningEnabled ?? false;
    const epoch = pref?.semanticLearningEpoch ?? 0;
    const generation = pref?.semanticLearningGeneration ?? 0;
    const history = await this.db.semanticLearningEvents.list(principal, 20);
    const lastApplied = history.find((e) => e.trigger === 'apply');
    const prov = this.classifier.learningProvenance;

    let source: 'learned' | 'bundled' = 'bundled';
    let freshHigh = 0;
    let freshLow = 0;
    if (prov !== null) {
      const hmac = this.hmacOf(principal);
      const snapshot = await loadRoutingSnapshot(this.db, principal).then((r) => r.snapshot);
      const revision = resolveLearningEvidenceRevision(
        snapshot,
        prov,
        this.routing.cascade.qualityThreshold,
      );
      const counts = await this.store
        .pendingCounts(hmac, epoch, revision)
        .catch(() => ({ high: 0, low: 0 }));
      freshHigh = counts.high;
      freshLow = counts.low;
      const active = await this.store
        .readActive(hmac, { epoch, generation, revision })
        .catch(() => null);
      source = active !== null ? 'learned' : 'bundled';
    }
    return {
      enabled,
      available: this.classifier.available,
      epoch,
      generation,
      source,
      freshHigh,
      freshLow,
      lastAppliedAt: lastApplied?.createdAt ?? null,
      history,
    };
  }

  async revert(principal: Principal): Promise<SemanticLearningStatus> {
    const coords = await this.db.routingSettings.revertLearning(principal, 'user revert');
    if (coords !== null) {
      // Best-effort Redis cleanup — the epoch bump already fenced reads/CAS.
      await this.store.deleteTenant(this.hmacOf(principal)).catch(() => undefined);
    }
    return this.status(principal);
  }

  onApplicationShutdown(): void {
    try {
      this.redis.disconnect();
    } catch {
      /* already closed */
    }
  }

  private hmacOf(principal: Principal): string {
    const id = principal.kind === 'user' ? principal.userId : principal.orgId;
    return tenantHmac(this.tenantKey, id);
  }
}
