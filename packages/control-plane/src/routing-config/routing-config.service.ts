import { batchFactoryFor, type BatchSeamInput } from '@polyrouter/data-plane';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AUTO_ALIAS,
  DEFAULT_TIER_KEY,
  MAX_MODELS_PER_TIER,
  PERSISTENCE_PORT,
  TIER_HEADER_NAME,
  isNonRoutableVariant,
  parseModelVariant,
  parseRoutingTarget,
  type ModelRow,
  type PersistencePort,
  type Principal,
  type RoutingEntryRow,
  type RoutingRuleInsertInput,
  type RoutingRulePatch,
  type RoutingRuleRow,
  type RuleMatchType,
  type TierInsertInput,
  type TierPatch,
  type TierRow,
  WORKLOAD_CLASSES,
  replaceEntryModelId,
  type ReplaceEntryInput,
} from '@polyrouter/shared/server';
import { ruleOrder } from '@polyrouter/data-plane';
import type {
  CreateRuleDto,
  CreateTierDto,
  UpdateRuleDto,
  UpdateTierDto,
} from './routing-config.dto';

export interface SafeTier {
  id: string;
  key: string;
  displayName: string | null;
  description: string | null;
  createdAt: Date;
}

export interface SafeEntryModel {
  id: string;
  providerId: string;
  externalModelId: string;
  displayName: string | null;
}

export interface SafeEntry {
  id: string;
  tierId: string;
  modelId: string;
  position: number;
  /** Which execution mode this entry is reserved for (add-batch-mode-routing).
   * `any` = no restriction; `batch` = only batch work may use it. Returned so the
   * dashboard can render the reservation without inferring it. */
  mode: 'any' | 'batch';
  model: SafeEntryModel | null;
}

export interface SafeRule {
  id: string;
  matchType: string;
  headerName: string;
  headerValue: string | null;
  /** The workload class an `auto_workload` rule binds (add-workload-routing);
   * null on every other match type. */
  workloadClass: string | null;
  target: string;
  priority: number;
  createdAt: Date;
}

// RFC 7230 field-name token, lower-cased (HTTP header names are case-insensitive).
const HEADER_NAME_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

/** Walk the error/cause chain for a PostgreSQL SQLSTATE (e.g. 23505 unique). */
function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function toSafeTier(t: TierRow): SafeTier {
  return {
    id: t.id,
    key: t.key,
    displayName: t.displayName,
    description: t.description,
    createdAt: t.createdAt,
  };
}

function toSafeEntry(e: RoutingEntryRow, model: ModelRow | null): SafeEntry {
  return {
    id: e.id,
    tierId: e.tierId,
    modelId: e.modelId,
    position: e.position,
    mode: e.mode === 'batch' ? 'batch' : 'any',
    model: model
      ? {
          id: model.id,
          providerId: model.providerId,
          externalModelId: model.externalModelId,
          displayName: model.displayName,
        }
      : null,
  };
}

/** The workload-class shape on the EFFECTIVE row (add-workload-routing D5 +
 * add-workload-scoped-bands): an `auto_workload` rule requires exactly one
 * taxonomy class (never `none`) and no `header_value`; a band rule
 * (`auto_high`/`auto_low`) MAY carry a class as its SCOPE (never `none`);
 * `header`/`default` never carry one. Mirrors the DB CHECKs so the shape is
 * a clean 4xx, never a constraint 500. */
function assertWorkloadShape(
  matchType: string,
  workloadClass: string | null,
  headerValue: string | null,
): void {
  const validClass = (c: string): boolean => (WORKLOAD_CLASSES as readonly string[]).includes(c);
  if (matchType === 'auto_workload') {
    if (workloadClass === null) {
      throw new UnprocessableEntityException('an auto_workload rule requires a workload_class');
    }
    if (!validClass(workloadClass)) {
      throw new UnprocessableEntityException(
        `workload_class must be one of ${WORKLOAD_CLASSES.join(', ')} (never none)`,
      );
    }
    // ANY non-null value (including '') is refused — the DB CHECK is `IS NULL`,
    // so a clean 4xx here is the only way an empty string never reaches it.
    if (headerValue !== null) {
      throw new UnprocessableEntityException('an auto_workload rule carries no header_value');
    }
  } else if (matchType === 'auto_high' || matchType === 'auto_low') {
    if (workloadClass !== null && !validClass(workloadClass)) {
      throw new UnprocessableEntityException(
        `a band rule's workload_class scope must be one of ${WORKLOAD_CLASSES.join(', ')} (never none)`,
      );
    }
  } else if (workloadClass !== null) {
    throw new UnprocessableEntityException(
      `workload_class is only valid on an auto_workload rule or as a band scope (got match_type ${matchType})`,
    );
  }
}

function toSafeRule(r: RoutingRuleRow): SafeRule {
  return {
    id: r.id,
    matchType: r.matchType,
    headerName: r.headerName,
    headerValue: r.headerValue,
    workloadClass: r.workloadClass,
    target: r.target,
    priority: r.priority,
    createdAt: r.createdAt,
  };
}

/** `/api/routing` service: tier / ordered-entry / rule CRUD, tenant-scoped
 * through the persistence port. No routing execution (that is #10). */
/** Whether a provider row carries the batch adapter seam (add-batch-mode-routing). */
function providerCanBatch(p: { kind: string; protocol: string; baseUrl: string | null }): boolean {
  if (p.baseUrl === null) return false;
  return (
    batchFactoryFor({
      kind: p.kind as BatchSeamInput['kind'],
      protocol: p.protocol as BatchSeamInput['protocol'],
      baseUrl: p.baseUrl,
    }) !== undefined
  );
}

@Injectable()
export class RoutingConfigService {
  constructor(@Inject(PERSISTENCE_PORT) private readonly db: PersistencePort) {}

  // --- tiers ---

  async listTiers(principal: Principal): Promise<SafeTier[]> {
    const rows = await this.db.tiers.list(principal);
    // Oldest first — the seeded `default` tier leads.
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.map(toSafeTier);
  }

  async getTier(principal: Principal, id: string): Promise<SafeTier> {
    const row = await this.db.tiers.findById(principal, id);
    if (!row) throw new NotFoundException();
    return toSafeTier(row);
  }

  async createTier(principal: Principal, dto: CreateTierDto): Promise<SafeTier> {
    if (dto.key === AUTO_ALIAS) {
      throw new UnprocessableEntityException(`"${AUTO_ALIAS}" is a reserved routing alias`);
    }
    const values: TierInsertInput = {
      key: dto.key,
      ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
    };
    try {
      return toSafeTier(await this.db.tiers.insert(principal, values));
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        throw new ConflictException(`tier key "${dto.key}" already exists`);
      }
      throw err;
    }
  }

  async updateTier(principal: Principal, id: string, dto: UpdateTierDto): Promise<SafeTier> {
    // `key` is intentionally absent — a tier key is immutable after creation.
    const patch: TierPatch = {
      ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
    };
    const row = await this.db.tiers.update(principal, id, patch);
    if (!row) throw new NotFoundException();
    return toSafeTier(row);
  }

  async deleteTier(principal: Principal, id: string): Promise<{ deleted: boolean }> {
    const tier = await this.db.tiers.findById(principal, id);
    if (!tier) throw new NotFoundException();
    if (tier.key === DEFAULT_TIER_KEY) {
      throw new UnprocessableEntityException('the default tier cannot be deleted');
    }
    // ON DELETE CASCADE clears the tier's routing entries.
    const deleted = await this.db.tiers.remove(principal, id);
    if (!deleted) throw new NotFoundException();
    return { deleted };
  }

  // --- entries ---

  async listEntries(principal: Principal, tierId: string): Promise<SafeEntry[]> {
    const tier = await this.db.tiers.findById(principal, tierId);
    if (!tier) throw new NotFoundException();
    const entries = await this.db.routingEntries.listForTier(principal, tierId);
    entries.sort((a, b) => a.position - b.position);
    const byId = await this.modelsById(principal);
    return entries.map((e) => toSafeEntry(e, byId.get(e.modelId) ?? null));
  }

  // Same predicate the batch path and the dashboard's capability flag use, so a
  // reservation the UI offers can never be refused here (and vice versa).
  // (Module-level helper below.)
  async replaceEntries(
    principal: Principal,
    tierId: string,
    ordered: readonly ReplaceEntryInput[],
  ): Promise<SafeEntry[]> {
    const modelIds = ordered.map(replaceEntryModelId);
    if (modelIds.length > MAX_MODELS_PER_TIER) {
      throw new UnprocessableEntityException(`a tier holds at most ${MAX_MODELS_PER_TIER} models`);
    }
    if (new Set(modelIds).size !== modelIds.length) {
      throw new UnprocessableEntityException('modelIds must not contain duplicates');
    }
    // The WHOLE submitted list is checked, including a member that was already
    // stored: a PUT is a full replacement, so accepting it would re-affirm a member
    // that can never serve (add-model-variant-detection). The stored chain is left
    // untouched on rejection, and the proxy keeps serving around such a member
    // meanwhile, so this is never the first the tenant hears of it.
    // Ownership of the TIER is settled before anything about its contents is judged
    // (invariant 5). `replaceForTier` would answer `tier_not_found` eventually, but
    // every content check above it can throw a 4xx first — so another tenant's tier
    // id would answer 422 "cannot be reserved for batch" instead of the 404 that
    // makes it indistinguishable from a missing one. Pre-existing for the routability
    // check; the seam check would have widened it.
    if ((await this.db.tiers.findById(principal, tierId)) === null) throw new NotFoundException();
    if (modelIds.length > 0) {
      const owned = await this.modelsById(principal);
      for (const id of modelIds) {
        const m = owned.get(id);
        if (m) assertRoutable(m, 'model');
      }
      // A reservation may only name a provider that can actually run a batch
      // (add-batch-mode-routing). Checked for a member that INTRODUCES or RETAINS
      // `batch` — never for one moving to `any`: a provider can lose its seam
      // beneath a stored reservation, and since a PUT resubmits every entry, a
      // blanket check would leave the tenant unable to edit that tier at all.
      // Unreserving must always be reachable (D12).
      const providers = new Map((await this.db.providers.list(principal)).map((r) => [r.id, r]));
      const stored = new Map(
        (await this.db.routingEntries.listForTier(principal, tierId)).map((e) => [e.modelId, e]),
      );
      for (const e of ordered) {
        const modelId = replaceEntryModelId(e);
        const stated = typeof e === 'string' ? undefined : e.mode;
        const effective = stated ?? stored.get(modelId)?.mode ?? 'any';
        if (effective !== 'batch') continue;
        const m = owned.get(modelId);
        // An id that is not the principal's is NOT a provider-capability problem —
        // it falls through to the `unknown_models` mapping below, which names it as
        // such. Reporting "its provider has no batch API" for a model the tenant does
        // not own would describe someone else's configuration.
        if (m === undefined) continue;
        const prov = providers.get(m.providerId);
        if (prov === undefined || prov.baseUrl === null || !providerCanBatch(prov)) {
          throw new UnprocessableEntityException(
            `"${m.externalModelId}" cannot be reserved for batch: its provider has no batch API`,
          );
        }
      }
    }
    const result = await this.db.routingEntries.replaceForTier(principal, tierId, ordered);
    if (result.status === 'tier_not_found') throw new NotFoundException();
    if (result.status === 'unknown_models') {
      throw new UnprocessableEntityException(
        `${result.modelIds.length} model id(s) are not among your models`,
      );
    }
    const byId = await this.modelsById(principal);
    return result.entries
      .sort((a, b) => a.position - b.position)
      .map((e) => toSafeEntry(e, byId.get(e.modelId) ?? null));
  }

  // --- rules ---

  async listRules(principal: Principal): Promise<SafeRule[]> {
    const rows = await this.db.routingRules.list(principal);
    // The SAME shared `ruleOrder` comparator the resolver applies WITHIN each of
    // its phases (A-45) — a deterministic display order, NOT the end-to-end
    // evaluation order: since add-tier-header-precedence, tier-header remaps
    // execute before rules on other headers regardless of priority.
    rows.sort(ruleOrder);
    return rows.map(toSafeRule);
  }

  async getRule(principal: Principal, id: string): Promise<SafeRule> {
    const row = await this.db.routingRules.findById(principal, id);
    if (!row) throw new NotFoundException();
    return toSafeRule(row);
  }

  async createRule(principal: Principal, dto: CreateRuleDto): Promise<SafeRule> {
    const headerName = this.normalizeHeaderName(dto.headerName);
    if (dto.matchType === 'header' && !hasValue(dto.headerValue)) {
      throw new UnprocessableEntityException('a header rule requires a header_value');
    }
    const workloadClass = dto.workloadClass ?? null;
    assertWorkloadShape(dto.matchType, workloadClass, dto.headerValue ?? null);
    await this.assertTargetOwned(principal, dto.target);
    const values: RoutingRuleInsertInput = {
      matchType: dto.matchType,
      headerName,
      headerValue: dto.headerValue ?? null,
      workloadClass,
      target: dto.target,
      priority: dto.priority ?? 0,
    };
    return toSafeRule(await this.db.routingRules.insert(principal, values));
  }

  async updateRule(principal: Principal, id: string, dto: UpdateRuleDto): Promise<SafeRule> {
    const existing = await this.db.routingRules.findById(principal, id);
    if (!existing) throw new NotFoundException();

    // Validate the EFFECTIVE merged row so a PATCH can't leave it invalid.
    const matchType = (dto.matchType ?? existing.matchType) as RuleMatchType;
    const headerValue = dto.headerValue !== undefined ? dto.headerValue : existing.headerValue;
    if (matchType === 'header' && !hasValue(headerValue)) {
      throw new UnprocessableEntityException('a header rule requires a header_value');
    }
    // `workload_class` is nullable at the boundary: an explicit null CLEARS it
    // (add-workload-routing D5) — the merged row decides legality.
    const workloadClass =
      dto.workloadClass !== undefined ? dto.workloadClass : existing.workloadClass;
    assertWorkloadShape(matchType, workloadClass, headerValue);
    if (dto.target !== undefined) await this.assertTargetOwned(principal, dto.target);

    const patch: RoutingRulePatch = {
      ...(dto.matchType !== undefined ? { matchType: dto.matchType } : {}),
      ...(dto.headerName !== undefined
        ? { headerName: this.normalizeHeaderName(dto.headerName) }
        : {}),
      ...(dto.headerValue !== undefined ? { headerValue: dto.headerValue } : {}),
      ...(dto.workloadClass !== undefined ? { workloadClass: dto.workloadClass } : {}),
      ...(dto.target !== undefined ? { target: dto.target } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
    };
    const row = await this.db.routingRules.update(principal, id, patch);
    if (!row) throw new NotFoundException();
    return toSafeRule(row);
  }

  async deleteRule(principal: Principal, id: string): Promise<{ deleted: boolean }> {
    const deleted = await this.db.routingRules.remove(principal, id);
    if (!deleted) throw new NotFoundException();
    return { deleted };
  }

  // --- internals ---

  private async modelsById(principal: Principal): Promise<Map<string, ModelRow>> {
    const models = await this.db.models.listForPrincipal(principal);
    return new Map(models.map((m) => [m.id, m]));
  }

  private normalizeHeaderName(name: string | undefined): string {
    const lowered = (name ?? TIER_HEADER_NAME).toLowerCase();
    if (!HEADER_NAME_PATTERN.test(lowered)) {
      throw new UnprocessableEntityException('header_name is not a valid HTTP header name');
    }
    return lowered;
  }

  /** Write-time (best-effort) target validation: the target must parse and
   * reference one of the principal's own tiers (by key) or models (by id). */
  private async assertTargetOwned(principal: Principal, target: string): Promise<void> {
    const parsed = parseRoutingTarget(target);
    if (!parsed) {
      throw new UnprocessableEntityException('target must be "tier:<key>" or "model:<id>"');
    }
    if (parsed.kind === 'tier') {
      const tiers = await this.db.tiers.list(principal);
      if (!tiers.some((t) => t.key === parsed.key)) {
        throw new UnprocessableEntityException(`target tier "${parsed.key}" does not exist`);
      }
    } else {
      const model = await this.db.models.findById(principal, parsed.id);
      if (!model) {
        throw new UnprocessableEntityException('target model does not exist');
      }
      // add-model-variant-detection: a batch-priced variant can never serve, so a
      // rule that names one is refused when it is WRITTEN rather than at request
      // time. A `tier:` target is unaffected — late-bound by key, with its
      // membership policed by the entry-replacement path.
      assertRoutable(model, 'target model');
    }
  }
}

/** Refuse a non-routable model at a config write, naming the base id so the
 * message points somewhere real (add-model-variant-detection). */
function assertRoutable(model: ModelRow, label: string): void {
  if (!isNonRoutableVariant(model.variant)) return;
  const base = parseModelVariant(model.externalModelId)?.base;
  const hint = base === undefined ? '' : ` — use "${base}" instead`;
  throw new UnprocessableEntityException(
    `${label} "${model.externalModelId}" is a batch-priced variant and cannot serve requests${hint}`,
  );
}

function hasValue(v: string | null | undefined): boolean {
  return v !== undefined && v !== null && v !== '';
}
