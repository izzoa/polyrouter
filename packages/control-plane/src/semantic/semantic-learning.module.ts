import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { ROUTING_CONFIG, loadRoutingConfig } from '../proxy/routing.config';
import { SemanticLearningController } from './semantic-learning.controller';
import { SemanticLearningService } from './semantic-learning.service';
import { SemanticLearningScheduler } from './learning.scheduler';
import { SemanticModule } from './semantic.module';

/**
 * The semantic-learning sweep (add-semantic-learning task 4.2): the scheduled,
 * off-hot-path daily loop that folds pending evidence into learned centroids.
 * Separate from `SemanticModule` (which stays the lean classifier/router the
 * proxy imports) so the BullMQ scheduler + DB/Redis dependencies live only where
 * the sweep does. Mirrors `CalibrationModule`'s placement. No-ops cleanly when
 * Layer 2 is unavailable.
 */
@Module({
  imports: [SemanticModule, DatabaseModule, RedisModule],
  controllers: [SemanticLearningController],
  providers: [
    { provide: ROUTING_CONFIG, useFactory: loadRoutingConfig },
    SemanticLearningScheduler,
    SemanticLearningService,
  ],
  exports: [SemanticLearningScheduler],
})
export class SemanticLearningModule {}
