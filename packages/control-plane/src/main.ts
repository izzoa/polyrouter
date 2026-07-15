import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigValidationError, loadConfig, type AppConfig } from '@polyrouter/shared';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { configureSpa } from './spa';

export async function bootstrap(): Promise<void> {
  // Validate the full registered config before anything binds: boot fails
  // fast, non-zero, naming each offending variable (never its value).
  let config: AppConfig;
  try {
    config = loadConfig<AppConfig>();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  configureApp(app, config);
  if (config.NODE_ENV === 'production') {
    configureSpa(app);
  }

  await app.listen(config.PORT, config.BIND_ADDRESS);
  console.log(
    `polyrouter listening on http://${config.BIND_ADDRESS}:${String(config.PORT)} (MODE=${config.MODE}, NODE_ENV=${config.NODE_ENV})`,
  );
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    // Migration or infrastructure failures during init must never serve
    // traffic: report and exit non-zero before any port is bound.
    console.error(error);
    process.exit(1);
  });
}
