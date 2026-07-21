import { Module } from '@nestjs/common';
import { SEMANTIC_LOADER, loadOnnxRuntime } from './onnx-loader';
import { SemanticRuntimeService } from './semantic-runtime.service';
import { SEMANTIC_CONFIG, loadSemanticConfig } from './semantic.config';

/** The flag-gated semantic-embedder runtime (add-semantic-embedder). With
 * `SEMANTIC_MODEL_PATH` unset this module contributes one boot line and a
 * false capability — nothing else. */
@Module({
  providers: [
    { provide: SEMANTIC_CONFIG, useFactory: loadSemanticConfig },
    { provide: SEMANTIC_LOADER, useValue: loadOnnxRuntime },
    SemanticRuntimeService,
  ],
  exports: [SemanticRuntimeService],
})
export class SemanticModule {}
