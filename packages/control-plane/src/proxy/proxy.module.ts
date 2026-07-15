import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createProviderAdapter } from '@polyrouter/data-plane';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ChatCompletionsController } from './chat-completions.controller';
import { MessagesController } from './messages.controller';
import { ModelsController } from './models.controller';
import { ProxyExceptionFilter } from './proxy-exception.filter';
import { PROXY_ADAPTER_FACTORY, PROXY_RUNTIME, loadProxyRuntime } from './proxy.config';
import { ProxyService } from './proxy.service';
import { StreamDrainRegistry } from './stream-drain.registry';

/**
 * The inference proxy (#10, Layer 0). `AuthModule` supplies the agent-key guard
 * the controllers use; `DatabaseModule` the persistence port. The exception
 * filter is registered globally (it protocol-shapes only `/v1`).
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ChatCompletionsController, MessagesController, ModelsController],
  providers: [
    ProxyService,
    StreamDrainRegistry,
    { provide: PROXY_RUNTIME, useFactory: loadProxyRuntime },
    { provide: PROXY_ADAPTER_FACTORY, useValue: createProviderAdapter },
    { provide: APP_FILTER, useClass: ProxyExceptionFilter },
  ],
})
export class ProxyModule {}
