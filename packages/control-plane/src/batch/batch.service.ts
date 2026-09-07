import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import {
  CallCancelledError,
  ProviderError,
  getAdapter,
  isRouteError,
  resolveRoute,
  type BatchAdapter,
  type ProviderAdapter,
  type ProviderConfig,
  type RouteDecision,
} from '@polyrouter/data-plane';
import { isBatchJobTerminal, parseModelVariant, type BatchJobStatus } from '@polyrouter/shared';
import {
  PERSISTENCE_PORT,
  type BatchJobRow,
  type ModelRow,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import { decodeBatchJobsCursor } from '../database/batch-jobs.cursor';
import { BudgetEnforcementUnavailableError, BudgetService } from '../budgets/budget-service';
import { PricingService } from '../pricing/pricing.service';
import { AdapterBuildError, ProviderAdapterBuilder } from '../providers/adapter-builder';
import { loadRoutingSnapshot } from '../proxy/routing-snapshot';
import {
  budgetEnforcementUnavailable,
  providerErrorToProxy,
  routeError,
  serviceUnavailable,
  toProxyError,
  type ClientProtocol,
} from '../proxy/proxy-errors';
import { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import { computeCeiling } from './batch-ceiling';
import { batchBudgetBlocked, batchError, protocolForEndpoint } from './batch-errors';
import {
  BatchIngressError,
  parseBatchSubmission,
  type ParsedBatchSubmission,
} from './batch-ingress';
import { renderBatchObject, resultLine } from './batch-object';
import {
  BATCH_ADAPTER_FACTORY,
  BATCH_CONFIG,
  BATCH_RUNTIME,
  type BatchAdapterFactory,
  type BatchConfig,
  type BatchRuntime,
} from './batch.config';

/** Lets the transport learn the caller's protocol as soon as the body reveals it
 * (D22), so any later failure renders in the endpoint's envelope. */
export interface SubmitEnvelope {
  setProtocol(protocol: ClientProtocol): void;
}

interface ResolvedTarget {
  readonly decision: RouteDecision;
  readonly provider: ProviderRow;
  readonly model: ModelRow;
  readonly models: readonly ModelRow[];
  readonly adapter: ProviderAdapter;
  readonly batch: BatchAdapter;
}

export interface BatchListPage {
  readonly rows: readonly BatchJobRow[];
  readonly nextCursor: string | null;
}

/** The synthesized `max_tokens` default the Anthropic adapter uses when an item
 * omits its own — the same value the proxy runtime carries. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * The batch surface's service (add-batch-inference §3): ONE explicit route
 * decision per batch, the submit-time price snapshot, the honest ceiling, and
 * the D6 order — job row → atomic check-and-reserve → upstream create → id
 * persisted — with every failure mapped to the protocol-shaped taxonomy.
 */
@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);
  private readonly builder: ProviderAdapterBuilder;

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(BATCH_CONFIG) private readonly cfg: BatchConfig,
    @Inject(BATCH_RUNTIME) private readonly rt: BatchRuntime,
    @Inject(BATCH_ADAPTER_FACTORY) private readonly factory: BatchAdapterFactory,
    private readonly pricing: PricingService,
    private readonly budgets: BudgetService,
    oauth: SubscriptionOauthService,
  ) {
    // The SAME builder the request path uses (D4) — credentials, OAuth, SSRF,
    // quirks and bounds resolve identically for a batch.
    this.builder = new ProviderAdapterBuilder({ key: rt.key, mode: rt.mode }, oauth);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Parse, route, price, bound, reserve, create — in that order (D1, D3, D6, D7, D8). */
  async submit(
    principal: Principal,
    agentId: string | null,
    source: AsyncIterable<Uint8Array>,
    envelope: SubmitEnvelope,
    signal?: AbortSignal,
  ): Promise<BatchJobRow> {
    // Disabled = new submissions refused; reads, cancel and the poller keep
    // running so in-flight jobs drain (D23).
    if (!this.cfg.enabled)
      throw batchError('batch_not_supported', 'batches are disabled on this instance');
    if (agentId === null)
      throw batchError('batch_invalid', 'a batch must be submitted with an agent key');

    let target: ResolvedTarget | undefined;
    let parsed: ParsedBatchSubmission;
    try {
      parsed = await parseBatchSubmission(
        source,
        { maxItems: this.cfg.maxItems, maxBodyBytes: this.cfg.maxBodyBytes },
        {
          onEndpoint: (endpoint) => envelope.setProtocol(protocolForEndpoint(endpoint)),
          // Route BEFORE the first item is read: `auto`, a non-routable model, or a
          // provider without the seam is refused without parsing an item (task 3.2),
          // and the upstream's own bounds join the ingress bounds.
          beforeItems: async ({ model }) => {
            target = await this.resolveTarget(principal, model);
            return {
              maxUpstreamItems: target.batch.limits.maxItems,
              customIdPattern: target.batch.limits.customIdPattern,
            };
          },
        },
      );
    } catch (err) {
      if (err instanceof BatchIngressError) {
        envelope.setProtocol(err.protocol);
        throw err.proxyError;
      }
      throw err;
    }
    if (target === undefined)
      throw batchError('batch_invalid', 'requests must be a non-empty array');
    const { decision, provider, model, models, batch } = target;

    // The submit-time snapshot, batch mode (D7): exact pair → native-family pair →
    // the aggregator twin's captured listed rate → unknown. Never a sync rate.
    const now = new Date();
    const twin = models.find(
      (m) =>
        m.providerId === provider.id &&
        m.variant === 'batch' &&
        parseModelVariant(m.externalModelId)?.base === model.externalModelId,
    );
    const { snapshot, maxOutputTokens } = await this.pricing.resolveBatchPricing(
      model,
      provider.baseUrl,
      provider.kind,
      now,
      twin !== undefined
        ? {
            inputPricePer1m: twin.listedInputPricePer1m,
            outputPricePer1m: twin.listedOutputPricePer1m,
          }
        : null,
    );
    const ceiling = computeCeiling(
      parsed.items.map((i) => ({ chars: i.chars, maxOutputTokens: i.maxOutputTokens })),
      snapshot !== null
        ? { inputPricePer1m: snapshot.inputPricePer1m, outputPricePer1m: snapshot.outputPricePer1m }
        : null,
      maxOutputTokens,
    );

    // (1) The job row — BEFORE the reservation and the create (D6/D8).
    const jobId = randomUUID();
    const row = await this.db.batchJobs.insert(principal, {
      id: jobId,
      agentId,
      providerId: provider.id,
      modelId: model.id,
      tierAssigned: decision.tierKey,
      endpoint: parsed.endpoint,
      protocol: provider.protocol,
      providerKind: provider.kind,
      itemCount: parsed.items.length,
      estimatedInputTokens: ceiling.estimatedInputTokens,
      priceMode: 'batch',
      inputPriceSnapshot: snapshot?.inputPricePer1m ?? null,
      outputPriceSnapshot: snapshot?.outputPricePer1m ?? null,
      cacheReadPriceSnapshot: snapshot?.cacheReadPricePer1m ?? null,
      cacheWritePriceSnapshot: snapshot?.cacheWritePricePer1m ?? null,
      priceVersionId: snapshot?.priceVersionId ?? null,
      priceSource: snapshot?.source ?? null,
      reservedCeilingMicros: ceiling.kind === 'bounded' ? ceiling.micros : null,
      completionWindowMs: batch.limits.completionWindowMs,
    });

    // (2) The atomic check-and-reserve, under the SAME fail mode as a request (D8/D20).
    let reserved = false;
    try {
      if (ceiling.kind === 'bounded') {
        const r = await this.budgets.reserveForBatch(principal, agentId, ceiling.micros);
        if (r.outcome === 'rejected') {
          await this.db.batchJobs.discard(principal, jobId);
          throw batchBudgetBlocked(r.hit, ceiling.micros);
        }
        reserved = r.outcome === 'reserved';
      } else if (await this.budgets.hasBlockBudget(principal, agentId)) {
        await this.db.batchJobs.discard(principal, jobId);
        throw batchError(
          'batch_unbounded',
          ceiling.reason === 'unknown_rate'
            ? 'no batch rate is known for this model'
            : 'an item has no max_tokens and the model has no known output cap',
        );
      }
    } catch (err) {
      if (err instanceof BudgetEnforcementUnavailableError) {
        await this.db.batchJobs.discard(principal, jobId);
        throw budgetEnforcementUnavailable();
      }
      throw err;
    }

    // (3) The upstream create, the job id as the idempotency key where honoured.
    let result;
    try {
      result = await batch.submit(
        {
          items: parsed.items.map((i) => ({ customId: i.customId, request: i.request })),
          model: model.externalModelId,
          jobId,
        },
        signal !== undefined ? { signal } : undefined,
      );
    } catch (err) {
      // The upstream ANSWERED with a rejection: definitive — fail the row, release.
      if (err instanceof ProviderError && err.status !== undefined) {
        await this.db.batchJobs.fail(principal, jobId, err.kind);
        if (reserved) {
          await this.budgets.releaseForBatch(
            principal,
            agentId,
            row.submittedAt,
            ceiling.kind === 'bounded' ? ceiling.micros : 0,
          );
        }
        throw providerErrorToProxy(err);
      }
      // Ambiguous — a network fault after the request left, a first-byte timeout,
      // a caller abort: the upstream may hold the job. The row stays `submitting`
      // for the reconciler (D6); nothing is released on a guess (D21).
      this.logger.warn(
        `batch ${jobId} submission outcome unknown (${err instanceof Error ? err.constructor.name : 'unknown'}); left for reconciliation`,
      );
      if (err instanceof CallCancelledError) {
        throw serviceUnavailable('batch submission interrupted; the job will be reconciled');
      }
      throw toProxyError(err);
    }

    // (4) The upstream id, persisted.
    const updated = await this.db.batchJobs.update(
      principal,
      jobId,
      {
        status: result.status ?? 'validating',
        upstreamBatchId: result.upstreamId,
        resultsExpireAt: result.resultsExpireAt,
      },
      { whenStatusIn: ['submitting'] },
    );
    return updated ?? row;
  }

  /** ONE explicit decision through the shared resolver (D3, task 3.2); a tier
   * resolves to its primary; the provider must carry the batch seam. */
  private async resolveTarget(principal: Principal, modelField: string): Promise<ResolvedTarget> {
    const { snapshot, models } = await loadRoutingSnapshot(this.db, principal);
    // No headers: the tier header and every smart layer are outside the batch
    // path by construction (invariant 1); `auto` was refused by the ingress.
    // `mode: 'batch'` is not cosmetic: the resolver's SYNCHRONOUS composition
    // excludes batch-reserved entries, so reusing it here would answer `empty_tier`
    // for a wholly reserved tier — the one configuration a batch is entitled to use.
    // It also selects the single never-promoted candidate (add-batch-mode-routing D3).
    const decision = resolveRoute(snapshot, { modelField, headers: {}, mode: 'batch' });
    if (isRouteError(decision)) throw routeError(decision);
    const provider = await this.db.providers.findById(principal, decision.providerId);
    const model = models.find((m) => m.id === decision.modelId);
    if (provider === null || model === undefined) throw routeError({ error: 'unresolved_target' });
    let config: ProviderConfig;
    try {
      config = await this.builder.buildConfig(principal, provider, {
        defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        bounds: {
          firstByteTimeoutMs: provider.firstByteTimeoutMs ?? this.rt.firstByteTimeoutMs,
          idleTimeoutMs: provider.idleTimeoutMs ?? this.rt.idleTimeoutMs,
          streamEventTimeoutMs: this.rt.streamEventTimeoutMs,
        },
      });
    } catch (err) {
      if (err instanceof AdapterBuildError) throw serviceUnavailable(err.message);
      throw err;
    }
    const adapter = this.factory(config);
    if (adapter.batch === undefined) throw batchError('batch_not_supported');
    return { decision, provider, model, models, adapter, batch: adapter.batch };
  }

  /** The DASHBOARD's view: every job the OWNER holds, scoped through the seam
   * (invariant 5). Another tenant's id is null, indistinguishable from missing. */
  getForOwner(principal: Principal, id: string): Promise<BatchJobRow | null> {
    return this.db.batchJobs.findById(principal, id);
  }

  /** The agent-key plane sees an agent's OWN jobs: owner-scoped through the seam,
   * then narrowed to the submitting agent. */
  async get(principal: Principal, agentId: string | null, id: string): Promise<BatchJobRow | null> {
    const row = await this.getForOwner(principal, id);
    if (row === null || row.agentId !== agentId) return null;
    return row;
  }

  /** The dashboard's listing: active jobs first, then terminal newest-first, over
   * the whole owner. `active` returns only the live rows (the band's read). */
  async listForOwner(
    principal: Principal,
    query: { limit: number; cursor?: string; active?: boolean },
  ): Promise<BatchListPage> {
    if (query.active === true) {
      return { rows: await this.db.batchJobs.listActive(principal), nextCursor: null };
    }
    const cursor = query.cursor !== undefined ? decodeBatchJobsCursor(query.cursor) : null;
    if (query.cursor !== undefined && cursor === null) {
      throw new UnprocessableEntityException('invalid cursor');
    }
    return this.db.batchJobs.list(principal, {
      limit: query.limit,
      ...(cursor !== null ? { cursor } : {}),
    });
  }

  async list(
    principal: Principal,
    agentId: string | null,
    query: { limit: number; after?: string },
  ): Promise<BatchListPage> {
    if (agentId === null) return { rows: [], nextCursor: null };
    let cursor;
    if (query.after !== undefined) {
      const encoded = await this.db.batchJobs.cursorForJob(principal, query.after);
      cursor = encoded !== null ? (decodeBatchJobsCursor(encoded) ?? undefined) : undefined;
      if (cursor === undefined)
        throw batchError('batch_not_found', 'the after cursor names no batch');
    }
    const page = await this.db.batchJobs.list(principal, {
      limit: query.limit,
      agentId,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return { rows: page.rows, nextCursor: page.nextCursor };
  }

  /**
   * Cancel (task 3.6 / 4.6, the request side): a terminal job is a no-op; a job
   * with no upstream id yet records the intent for the reconciler (D6); otherwise
   * the upstream is asked and the job holds `cancelling` until the poller has
   * settled what ran (D21).
   */
  cancel(
    principal: Principal,
    agentId: string | null,
    id: string,
  ): Promise<{ row: BatchJobRow; changed: boolean }> {
    return this.cancelJob(principal, () => this.get(principal, agentId, id));
  }

  /** The dashboard's cancel: the same transition, scoped to the owner. */
  cancelForOwner(
    principal: Principal,
    id: string,
  ): Promise<{ row: BatchJobRow; changed: boolean }> {
    return this.cancelJob(principal, () => this.getForOwner(principal, id));
  }

  private async cancelJob(
    principal: Principal,
    load: () => Promise<BatchJobRow | null>,
  ): Promise<{ row: BatchJobRow; changed: boolean }> {
    const row = await load();
    if (row === null) throw batchError('batch_not_found');
    const id = row.id;
    const status = row.status as BatchJobStatus;
    if (isBatchJobTerminal(status)) return { row, changed: false };
    if (row.upstreamBatchId === null) {
      const updated = await this.db.batchJobs.update(principal, id, { cancelRequested: true });
      return { row: updated ?? row, changed: true };
    }
    if (status === 'cancelling') return { row, changed: false };
    const provider = await this.db.providers.findById(principal, row.providerId);
    if (provider === null) {
      // The poller fails a provider-less job (`provider_missing`); record the intent.
      const updated = await this.db.batchJobs.update(principal, id, { cancelRequested: true });
      return { row: updated ?? row, changed: true };
    }
    const batch = await this.batchFor(principal, provider);
    try {
      await batch.cancel(row.upstreamBatchId);
    } catch (err) {
      if (err instanceof ProviderError) throw providerErrorToProxy(err);
      throw toProxyError(err);
    }
    const updated = await this.db.batchJobs.update(
      principal,
      id,
      { status: 'cancelling', cancelRequested: true },
      { whenStatusIn: ['validating', 'in_progress', 'finalizing'] },
    );
    return { row: updated ?? row, changed: true };
  }

  /**
   * The seam for an EXISTING job's provider (cancel, results, and the poller's
   * calls). Built from the SERVICING predicate, not the submission one
   * (add-batch-mode-routing task 1.2): `createProviderAdapter` derives
   * `deps.batch` from `batchFactoryFor` unless a factory is supplied, so once
   * submission eligibility narrowed it would have stripped the seam from here
   * too — and a job whose seam has vanished can never be polled to a terminal
   * state, so it holds its budget reservation for the rest of the window (the
   * poller releases nothing on a failure) and its paid-for results become
   * unreadable. Injecting the servicing factory is what keeps "drain, never
   * strand" true across an eligibility change.
   *
   * The seam is selected by PURPOSE, not by rewriting the config's `kind`. An
   * earlier cut overrode `kind` with the job's recorded value for fidelity; that
   * is both redundant — the servicing predicate already admits what submission
   * refuses — and harmful, because `kind` also drives connect-time SSRF and
   * credential resolution, so rewriting it changes semantics well beyond the
   * seam (a loopback provider stops being reachable). The live row remains the
   * truth for how to TALK to the provider; the purpose decides only whether a
   * batch seam is attached.
   */
  async batchFor(principal: Principal, provider: ProviderRow): Promise<BatchAdapter> {
    let config: ProviderConfig;
    try {
      config = await this.builder.buildConfig(principal, provider, {
        defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        bounds: {
          firstByteTimeoutMs: provider.firstByteTimeoutMs ?? this.rt.firstByteTimeoutMs,
          idleTimeoutMs: provider.idleTimeoutMs ?? this.rt.idleTimeoutMs,
          streamEventTimeoutMs: this.rt.streamEventTimeoutMs,
        },
      });
    } catch (err) {
      if (err instanceof AdapterBuildError) throw serviceUnavailable(err.message);
      throw err;
    }
    const adapter = this.factory(config, { batchPurpose: 'servicing' });
    if (adapter.batch === undefined) throw batchError('batch_not_supported');
    return adapter.batch;
  }

  /**
   * The results pass-through (add-batch-inference D2/D25, task 4.5). polyrouter
   * stores nothing: the lines are streamed FROM the upstream, translated per item
   * into the caller's protocol, and pass through memory only.
   *
   * The read is refused BEFORE any upstream call when the job is not terminal
   * (409) or its retention deadline has passed (410) — so the caller's own
   * envelope carries the reason. Everything after the first line is the stream's
   * problem, and the caller renders a terminal error object rather than a silent
   * truncation.
   */
  async results(
    principal: Principal,
    agentId: string | null,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ job: BatchJobRow; lines: AsyncGenerator<string> }> {
    const job = await this.get(principal, agentId, id);
    if (job === null) throw batchError('batch_not_found');
    if (!isBatchJobTerminal(job.status as BatchJobStatus)) throw batchError('batch_not_ready');
    if (job.upstreamBatchId === null) {
      // Nothing was ever created upstream (a lost submission): there is nothing to
      // read, and saying so is honest where a 404 would suggest a wrong id.
      throw batchError('batch_results_expired', 'this batch never reached the provider');
    }
    if (job.resultsExpireAt !== null && job.resultsExpireAt.getTime() <= Date.now()) {
      throw batchError('batch_results_expired');
    }
    const provider = await this.db.providers.findById(principal, job.providerId);
    if (provider === null) throw batchError('batch_results_expired', 'the provider was removed');
    const batch = await this.batchFor(principal, provider);
    const upstreamId = job.upstreamBatchId;
    const client = getAdapter(
      protocolForEndpoint(job.endpoint) === 'anthropic' ? 'anthropic' : 'openai',
    );
    async function* lines(): AsyncGenerator<string> {
      for await (const outcome of batch.results(
        upstreamId,
        signal !== undefined ? { signal } : undefined,
      )) {
        yield `${JSON.stringify(resultLine(job!, outcome, client))}\n`;
      }
    }
    return { job, lines: lines() };
  }

  /** The client-facing object; the external model id is looked up owner-scoped
   * (the row keeps the internal id, so a deleted model falls back to it). */
  async render(principal: Principal, row: BatchJobRow): Promise<Record<string, unknown>> {
    const model = await this.db.models.findById(principal, row.modelId);
    return renderBatchObject(row, model?.externalModelId ?? row.modelId);
  }
}
