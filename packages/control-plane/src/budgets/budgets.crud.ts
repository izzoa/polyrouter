import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  type BudgetPatch,
  type BudgetRow,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { BudgetCache } from './budget-cache';
import type { CreateBudgetDto, UpdateBudgetDto } from './budgets.dto';

/** The API view of a budget (no secrets to hide; channel ids as an array). */
export interface SafeBudget {
  id: string;
  name: string;
  scope: string;
  agentId: string | null;
  window: string;
  action: string;
  amount: number;
  notifyChannelIds: string[];
  enabled: boolean;
  createdAt: Date;
}

/** Empty/whitespace agentId is treated as "no agent" (so it can't slip past the
 * agent-requires-agentId rule and land a blank id that never matches a request). */
function normAgentId(a: string | null | undefined): string | null {
  const t = a?.trim();
  return t ? t : null;
}

function toSafe(r: BudgetRow): SafeBudget {
  return {
    id: r.id,
    name: r.name,
    scope: r.scope,
    agentId: r.agentId,
    window: r.window,
    action: r.action,
    amount: r.amount,
    notifyChannelIds: r.notifyChannelIds ? r.notifyChannelIds.split(',').filter((s) => s) : [],
    enabled: r.enabled,
    createdAt: r.createdAt,
  };
}

/** Ownership-scoped budget CRUD (#16, spec §5/§10). Every access goes through the
 * owner-scoped `db.budgets` repository (invariant 5). Writes invalidate the
 * owner's block-check cache so enforcement picks up the change promptly. */
@Injectable()
export class BudgetsCrudService {
  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    private readonly cache: BudgetCache,
  ) {}

  async list(principal: Principal): Promise<SafeBudget[]> {
    return (await this.db.budgets.list(principal)).map(toSafe);
  }

  async get(principal: Principal, id: string): Promise<SafeBudget> {
    const row = await this.db.budgets.findById(principal, id);
    if (row === null) throw new NotFoundException();
    return toSafe(row);
  }

  async create(principal: Principal, dto: CreateBudgetDto): Promise<SafeBudget> {
    const agentId = dto.scope === 'agent' ? normAgentId(dto.agentId) : null;
    if (dto.scope === 'agent' && agentId === null) {
      throw new UnprocessableEntityException('an agent-scoped budget requires an agentId');
    }
    const row = await this.db.budgets.insert(principal, {
      name: dto.name,
      scope: dto.scope,
      agentId,
      window: dto.window,
      action: dto.action,
      amount: dto.amount,
      notifyChannelIds: (dto.notifyChannelIds ?? []).join(','),
      enabled: dto.enabled ?? true,
    });
    this.cache.invalidate(principal);
    return toSafe(row);
  }

  async update(principal: Principal, id: string, dto: UpdateBudgetDto): Promise<SafeBudget> {
    const existing = await this.db.budgets.findById(principal, id);
    if (existing === null) throw new NotFoundException();

    // Validate the MERGED state (a scope/agentId change is re-validated): an agent
    // budget must carry an agent; a global budget must not.
    const scope = dto.scope ?? existing.scope;
    let agentId = dto.agentId !== undefined ? normAgentId(dto.agentId) : existing.agentId;
    if (scope === 'agent') {
      if (agentId === null) {
        throw new UnprocessableEntityException('an agent-scoped budget requires an agentId');
      }
    } else {
      agentId = null;
    }

    const patch: BudgetPatch = { agentId };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.scope !== undefined) patch.scope = dto.scope;
    if (dto.window !== undefined) patch.window = dto.window;
    if (dto.action !== undefined) patch.action = dto.action;
    if (dto.amount !== undefined) patch.amount = dto.amount;
    if (dto.notifyChannelIds !== undefined) patch.notifyChannelIds = dto.notifyChannelIds.join(',');
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;

    const row = await this.db.budgets.update(principal, id, patch);
    if (row === null) throw new NotFoundException();
    this.cache.invalidate(principal);
    return toSafe(row);
  }

  async remove(principal: Principal, id: string): Promise<{ deleted: boolean }> {
    const deleted = await this.db.budgets.remove(principal, id);
    if (!deleted) throw new NotFoundException();
    this.cache.invalidate(principal);
    return { deleted };
  }
}
