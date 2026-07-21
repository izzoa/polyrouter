import { Module } from '@nestjs/common';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';
import { loadAuthConfig, resolveAuthSecrets } from '../auth/auth.config';
import { RedisModule } from '../redis/redis.module';
import { CLASSIFICATION_SOURCE } from './classification-source';
import { deriveTenantHmacKey } from './learning-format';
import { LearnedClassificationSource } from './learned-classification-source';
import { RedisLearningStore } from './learning-store';
import { SEMANTIC_LOADER, loadOnnxRuntime } from './onnx-loader';
import { SemanticClassifierService } from './semantic-classifier.service';
import { SemanticRouter } from './semantic-router';
import { SemanticRuntimeService } from './semantic-runtime.service';
import { SEMANTIC_CONFIG, loadSemanticConfig, type SemanticConfig } from './semantic.config';

/** The flag-gated semantic stack: the embedder runtime (add-semantic-embedder)
 * plus the Layer-2 classifier + router (add-semantic-routing) and the learned
 * classification decorator (add-semantic-learning). With `SEMANTIC_MODEL_PATH`
 * unset this module contributes one boot line and false capabilities; the
 * decorator's Redis connection is best-effort and lazy. */
@Module({
  imports: [RedisModule],
  providers: [
    { provide: SEMANTIC_CONFIG, useFactory: loadSemanticConfig },
    { provide: SEMANTIC_LOADER, useValue: loadOnnxRuntime },
    SemanticRuntimeService,
    SemanticClassifierService,
    // The classification source is the bundled classifier decorated with learned
    // per-tenant state (add-semantic-learning D4). The decorator is bound INSIDE
    // this module so a sibling can't override the intra-module token; its store
    // rides a dedicated fail-fast connection so a down Redis never stalls reads.
    {
      provide: LearnedClassificationSource,
      inject: [REDIS_CLIENT, SEMANTIC_CONFIG, SemanticClassifierService],
      useFactory: (
        redis: Redis,
        cfg: SemanticConfig,
        classifier: SemanticClassifierService,
      ): LearnedClassificationSource => {
        const { auth, base } = loadAuthConfig();
        const key = deriveTenantHmacKey(resolveAuthSecrets(auth, base).apiKeyHmacSecret);
        const conn = redis.duplicate({ enableOfflineQueue: false, maxRetriesPerRequest: 1 });
        conn.on('error', () => {});
        if (conn.status === 'wait') void conn.connect().catch(() => {});
        return new LearnedClassificationSource(
          new RedisLearningStore(conn),
          key,
          classifier,
          cfg.timeoutMs,
          () => conn.disconnect(),
        );
      },
    },
    { provide: CLASSIFICATION_SOURCE, useExisting: LearnedClassificationSource },
    SemanticRouter,
  ],
  exports: [
    SEMANTIC_CONFIG,
    SemanticRuntimeService,
    SemanticClassifierService,
    SemanticRouter,
    CLASSIFICATION_SOURCE,
  ],
})
export class SemanticModule {}
