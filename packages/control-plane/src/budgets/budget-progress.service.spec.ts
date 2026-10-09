import { ServiceUnavailableException } from '@nestjs/common';
import { userPrincipal, type PersistencePort } from '@polyrouter/shared/server';
import { BudgetProgressService } from './budget-progress.service';
describe('budget progress service capability boundary', () => {
  it('delegates only through the principal-scoped read capability', async () => {
    const response = { asOf: '2026-10-08T12:00:00.000Z', results: [] };
    const read = jest.fn().mockResolvedValue(response);
    const port = { budgetProgress: { read } } as unknown as PersistencePort;
    const principal = userPrincipal('owner');
    expect(await new BudgetProgressService(port).read(principal, ['id'])).toBe(response);
    expect(read).toHaveBeenCalledWith(principal, ['id']);
    expect(Object.keys(port)).toEqual(['budgetProgress']);
  });
  it('sanitizes persistence faults without fabricating success fields', async () => {
    const port = {
      budgetProgress: { read: jest.fn().mockRejectedValue(new Error('password secret SQL')) },
    } as unknown as PersistencePort;
    try {
      await new BudgetProgressService(port).read(userPrincipal('owner'), ['id']);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        code: 'budget_progress_unavailable',
        message: 'Budget progress is temporarily unavailable',
      });
    }
  });
});
