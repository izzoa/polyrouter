import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SemanticRuntimeService } from '../semantic/semantic-runtime.service';
import { SemanticModule } from '../semantic/semantic.module';

/**
 * Test-only entrypoint for the semantic boot-matrix e2e (add-semantic-embedder
 * task 3.6). Boots ONLY the semantic module graph and binds an ephemeral
 * port: lifecycle hooks run inside `listen()`'s implicit init, so a broken
 * `SEMANTIC_MODEL_PATH` must exit non-zero WITHOUT ever printing LISTENING —
 * the port-never-binds contract — while unset/valid paths print the
 * capability the instance would advertise.
 */
@Module({ imports: [SemanticModule] })
class SemanticBootFixtureModule {}

async function main(): Promise<void> {
  // abortOnError:false so a create-time failure (e.g. config validation in a
  // provider factory) REJECTS into the catch below and reaches stderr — the
  // default would process.exit(1) silently with the logger disabled.
  const app = await NestFactory.create(SemanticBootFixtureModule, {
    logger: false,
    abortOnError: false,
  });
  await app.listen(0, '127.0.0.1');
  console.log('LISTENING');
  console.log(`AVAILABLE:${String(app.get(SemanticRuntimeService).available)}`);
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
