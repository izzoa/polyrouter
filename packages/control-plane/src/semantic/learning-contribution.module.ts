import { Global, Module } from '@nestjs/common';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { loadAuthConfig, resolveAuthSecrets } from '../auth/auth.config';
import { RedisModule } from '../redis/redis.module';
import { LEARNING_EVIDENCE_SINK } from '../recording/request-recorder';
import { EvidenceAccumulator } from './evidence-accumulator';
import { SemanticLearningContributor } from './semantic-learning-contributor';
import { SEMANTIC_CONFIG, loadSemanticConfig } from './semantic.config';

/**
 * The hot-path learning-evidence contribution (add-semantic-learning task 3.3),
 * bound GLOBALLY so the recorder can optionally inject `LEARNING_EVIDENCE_SINK`
 * without the recording module depending on the (flag-gated, heavy) semantic
 * stack. Dormant when Layer 2 is off — the gate is disabled, so the recorder
 * never calls the sink and the accumulator stays idle.
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [
    { provide: SEMANTIC_CONFIG, useFactory: loadSemanticConfig },
    {
      provide: EvidenceAccumulator,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis): EvidenceAccumulator => {
        const { auth, base } = loadAuthConfig();
        return new EvidenceAccumulator(redis, resolveAuthSecrets(auth, base).apiKeyHmacSecret);
      },
    },
    { provide: LEARNING_EVIDENCE_SINK, useClass: SemanticLearningContributor },
  ],
  exports: [LEARNING_EVIDENCE_SINK],
})
export class LearningContributionModule {}
