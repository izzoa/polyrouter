import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { SemanticLearningService, type SemanticLearningStatus } from './semantic-learning.service';

/**
 * `/api/routing/semantic-learning` (add-semantic-learning task 5.3): the learning
 * status view + the one-action revert. Session-guarded (global guard),
 * owner-scoped through the service. The ENABLE/disable toggle rides the existing
 * `/api/routing/auto-layers` PUT (`semanticLearning`).
 */
@Controller('api/routing/semantic-learning')
export class SemanticLearningController {
  constructor(private readonly svc: SemanticLearningService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status(@CurrentPrincipal() principal: Principal): Promise<SemanticLearningStatus> {
    return this.svc.status(principal);
  }

  /** Idempotent revert: bumps the revocation epoch (Postgres-first), then clears
   * Redis. Reverting with no learned state still bumps the epoch harmlessly. */
  @Post('revert')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revert(@CurrentPrincipal() principal: Principal): Promise<SemanticLearningStatus> {
    return this.svc.revert(principal);
  }
}
