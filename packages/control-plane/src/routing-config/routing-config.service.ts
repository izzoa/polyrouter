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
  model: SafeEntryModel | null;
}

export interface SafeRule {
  id: string;
  matchType: string;
  headerName: string;
  headerValue: string | null;
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

function toSafeRule(r: RoutingRuleRow): SafeRule {
  return {
    id: r.id,
    matchType: r.matchType,
    headerName: r.headerName,
    headerValue: r.headerValue,
    target: r.target,
    priority: r.priority,
    createdAt: r.createdAt,
  };
}

/** `/api/routing` service: tier / ordered-entry / rule CRUD, tenant-scoped
 * through the persistence port. No routing execution (that is #10). */
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

  async replaceEntries(
    principal: Principal,
    tierId: string,
    modelIds: string[],
  ): Promise<SafeEntry[]> {
    if (modelIds.length > MAX_MODELS_PER_TIER) {
      throw new UnprocessableEntityException(`a tier holds at most ${MAX_MODELS_PER_TIER} models`);
    }
    if (new Set(modelIds).size !== modelIds.length) {
      throw new UnprocessableEntityException('modelIds must not contain duplicates');
    }
    const result = await this.db.routingEntries.replaceForTier(principal, tierId, modelIds);
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
    // The proxy's (#10) evaluation order — the SAME shared `ruleOrder` comparator
    // the resolver uses (A-45), so display and evaluation can't drift.
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
    await this.assertTargetOwned(principal, dto.target);
    const values: RoutingRuleInsertInput = {
      matchType: dto.matchType,
      headerName,
      headerValue: dto.headerValue ?? null,
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
    if (dto.target !== undefined) await this.assertTargetOwned(principal, dto.target);

    const patch: RoutingRulePatch = {
      ...(dto.matchType !== undefined ? { matchType: dto.matchType } : {}),
      ...(dto.headerName !== undefined
        ? { headerName: this.normalizeHeaderName(dto.headerName) }
        : {}),
      ...(dto.headerValue !== undefined ? { headerValue: dto.headerValue } : {}),
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
    }
  }
}

function hasValue(v: string | null | undefined): boolean {
  return v !== undefined && v !== null && v !== '';
}
