import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  type BudgetPatch,
  type BudgetRow,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { BUDGET_READER, type BudgetReader, type MeteringBasis } from '../database/budget.reader';
import { BudgetCache } from './budget-cache';
import type { CreateBudgetDto, UpdateBudgetDto } from './budgets.dto';
import { periodInfo, type BudgetWindow } from './period';
import { SpendCounter } from './spend-counter';

/** The API view of a budget (no secrets to hide; channel ids as an array). */
export interface SafeBudget {
  id: string;
  name: string;
  scope: string;
  agentId: string | null;
  window: string;
  action: string;
  /** What this budget meters: `cash` (money owed) or `notional` (also counts prepaid
   * subscription traffic at API rates). */
  meteringBasis: string;
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
    meteringBasis: r.meteringBasis,
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
  private static readonly log = new Logger(BudgetsCrudService.name);

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    private readonly cache: BudgetCache,
    // OPTIONAL on purpose: these serve only the best-effort counter seed on a
    // metering-basis change. Budget CRUD is a Postgres concern — editing a budget must
    // not fail because Redis is unavailable, and the scheduler's next reconcile fills
    // the counter in regardless. Production wiring provides both (BudgetsModule).
    @Optional() private readonly counter?: SpendCounter,
    @Optional() @Inject(BUDGET_READER) private readonly reader?: BudgetReader,
  ) {}

  /** Populate the counter key a basis change moves this budget onto, so it is never
   * read as an authoritative zero before the scheduler's next reconcile. Reconciliation
   * recomputes the WHOLE period from the ledgers, so nothing is lost by the move — the
   * seed carries the complete total for the new basis. */
  private async seedCounterForBasis(b: BudgetRow): Promise<void> {
    if (this.counter === undefined || this.reader === undefined) {
      BudgetsCrudService.log.warn('metering-basis change refused: counter seed unwired');
      throw new ServiceUnavailableException(
        'cannot change what this budget counts right now — spend metering is unavailable',
      );
    }
    try {
      const window = b.window as BudgetWindow;
      const { periodId, startMs, endMs } = periodInfo(window, new Date());
      const scopeId = b.scope === 'agent' ? (b.agentId ?? 'global') : 'global';
      const owner = b.ownerUserId;
      const basis = b.meteringBasis as MeteringBasis;
      const spend = await this.reader.spendMicrosFor(
        owner,
        b.scope === 'agent' ? b.agentId : null,
        new Date(startMs),
        new Date(endMs),
        basis,
      );
      await this.counter.reconcileMax(
        this.counter.key(owner, b.scope, scopeId, window, periodId, basis),
        spend.micros,
        Math.max(1, endMs - Date.now()),
      );
    } catch (err) {
      // NOT best-effort. An unseeded key reads as zero spend, so letting the basis
      // change land anyway would silently disable this budget until the next reconcile.
      // Refuse the change instead and leave the budget metering exactly as it was.
      BudgetsCrudService.log.warn(`metering-basis seed failed: ${String((err as Error).message)}`);
      throw new ServiceUnavailableException(
        'could not switch what this budget counts — try again shortly',
      );
    }
  }

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
      // New budgets meter money owed. The DB column defaults to `notional` so the
      // migration could preserve EXISTING budgets' enforcement; a new one is always
      // written explicitly so that backfill default never applies to it.
      meteringBasis: dto.meteringBasis ?? 'cash',
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
    if (dto.meteringBasis !== undefined) patch.meteringBasis = dto.meteringBasis;
    if (dto.amount !== undefined) patch.amount = dto.amount;
    if (dto.notifyChannelIds !== undefined) patch.notifyChannelIds = dto.notifyChannelIds.join(',');
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;

    // A basis change moves this budget onto a different counter key, which does not
    // exist yet — and a missing counter reads as an authoritative ZERO (not as
    // "enforcement unavailable") while the global reconcile heartbeat stays fresh from
    // other budgets. So the new key must be populated BEFORE the change is visible:
    // seeding after the commit leaves a window where a concurrent request loads the new
    // basis and meters against nothing.
    const changingBasis =
      dto.meteringBasis !== undefined && dto.meteringBasis !== existing.meteringBasis;
    if (changingBasis) {
      await this.seedCounterForBasis({ ...existing, ...patch } as BudgetRow);
    }

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
