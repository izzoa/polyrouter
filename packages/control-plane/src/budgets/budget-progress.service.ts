import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PERSISTENCE_PORT, type PersistencePort, type Principal } from '@polyrouter/shared/server';

@Injectable()
export class BudgetProgressService {
  constructor(@Inject(PERSISTENCE_PORT) private readonly db: PersistencePort) {}

  async read(principal: Principal, ids: string[]) {
    try {
      return await this.db.budgetProgress.read(principal, ids);
    } catch {
      throw new ServiceUnavailableException({
        code: 'budget_progress_unavailable',
        message: 'Budget progress is temporarily unavailable',
      });
    }
  }
}
