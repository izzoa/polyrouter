import { Module } from '@nestjs/common';
import { CLASSIFICATION_SOURCE } from './classification-source';
import { SEMANTIC_LOADER, loadOnnxRuntime } from './onnx-loader';
import { SemanticClassifierService } from './semantic-classifier.service';
import { SemanticRouter } from './semantic-router';
import { SemanticRuntimeService } from './semantic-runtime.service';
import { SEMANTIC_CONFIG, loadSemanticConfig } from './semantic.config';

/** The flag-gated semantic stack: the embedder runtime (add-semantic-embedder)
 * plus the Layer-2 classifier + router (add-semantic-routing). With
 * `SEMANTIC_MODEL_PATH` unset this module contributes one boot line and false
 * capabilities — nothing else. */
@Module({
  providers: [
    { provide: SEMANTIC_CONFIG, useFactory: loadSemanticConfig },
    { provide: SEMANTIC_LOADER, useValue: loadOnnxRuntime },
    SemanticRuntimeService,
    SemanticClassifierService,
    // The classification source is the bundled classifier here; the learning
    // capability rebinds this token to layer learned state (clink r2 Med-4).
    { provide: CLASSIFICATION_SOURCE, useExisting: SemanticClassifierService },
    SemanticRouter,
  ],
  exports: [
    SemanticRuntimeService,
    SemanticClassifierService,
    SemanticRouter,
    CLASSIFICATION_SOURCE,
  ],
})
export class SemanticModule {}
